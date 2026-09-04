#!/usr/bin/env python
"""
Persistent Spotify control daemon - same real reasoning and the same
stdin/stdout newline-delimited-JSON protocol as
chatterbox_synthesize_daemon.py/whisper_transcribe_daemon.py: a fresh
`spotify_control.py` subprocess per command was measured (2026-09-03,
Gavin: "spotify playback works confirmed but slow") to cost real,
avoidable time on EVERY call, not just the first:

  - Python interpreter start + `import spotipy` (pulls in requests,
    urllib3, cryptography's transitive chain): ~350ms, every single call.
  - The first real network call of any fresh process pays a real, larger
    fixed cost (TLS handshake to Spotify's API + spotipy's own
    is_token_expired() check) - measured live at 550-825ms - that a warm
    process's *second* call onward does NOT pay (measured 95-350ms on
    the same warm connection).
  - `cmd_play` alone makes three sequential real network calls
    (search -> devices -> start_playback) in the old one-shot script,
    stacking three round trips instead of overlapping the two that don't
    actually depend on each other.

This daemon fixes the first two by loading spotipy and authenticating
exactly once at startup (paying that one real fixed cost up front,
during JARVIS's own startup warm-up - see spotify.ts's warmUp()) and
keeping the same requests session/connection alive across every command
for the rest of the `listen` session. It fixes the third by running
search() and the device lookup concurrently (they're independent) and by
caching the last-known active device id so most `play` calls skip the
devices() round trip entirely (see get_device_id() below) - only
refetching it when a cached id turns out to be stale (start_playback
fails with Spotify's real "device not found" error).

This is a *second* real code path alongside spotify_control.py, not a
replacement for it - spotify_control.py still handles the one-shot
`auth` flow (needs a real interactive browser + spotipy's own local
callback server, which has no reason to live in a long-running daemon)
and remains available for one-off CLI testing (`bun run dev
spotify-test`). This daemon is only spawned for the real, long-lived
`listen` voice session, where paying setup costs once and reusing a warm
connection across many turns is the whole point (same tradeoff Chatterbox
and Whisper already made in this codebase).

Protocol (stdin -> stdout, both newline-delimited JSON), one request in
flight at a time (Spotify calls are fast enough - tens to a few hundred
ms - that this codebase's simpler one-at-a-time daemon protocol, not a
request-id/pipelined one, is the right amount of complexity here):
  startup:  stdout emits {"ready": true}
  request:  stdin line  {"command": "play", "query": "..."}  (or
            "pause"/"resume"/"next"/"previous"/"status", "query" omitted)
  response: stdout line the same JSON shape spotify_control.py's own
            commands already return (e.g. {"success": true, "playing":
            "...", "type": "track"}), or {"success": false, "error":
            "..."} - the daemon keeps running after a per-request error,
            same resilience as the other two daemons.
"""

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

try:
    import spotipy
    from spotipy.oauth2 import SpotifyOAuth
except ImportError as e:
    print(json.dumps({"error": f"spotipy not installed: {e}. Run: tools/whisper/venv/Scripts/python.exe -m pip install spotipy"}))
    sys.exit(1)

from pathlib import Path

CACHE_PATH = str(Path(__file__).parent / ".spotify-cache")
SCOPE = "user-modify-playback-state user-read-playback-state user-read-currently-playing"
REDIRECT_URI = os.environ.get("SPOTIPY_REDIRECT_URI", "http://127.0.0.1:8888/callback")

# Real, small (2-worker) pool just to overlap the two independent Spotify
# API calls inside cmd_play (search, device lookup) - not a general-
# purpose thread pool, spotipy/requests is synchronous so this is the
# real mechanism, not asyncio, for getting them concurrent at all.
_executor = ThreadPoolExecutor(max_workers=2)

# Real, live-measured win: most calls in a real session target the same
# one device Gavin already has open, so caching its id across requests
# skips a whole network round trip on the common case. Invalidated (set
# back to None) whenever a cached id turns out to be stale, so a real
# device change (Gavin switches from desktop app to phone, say) is still
# picked up correctly on the very next call, not silently stuck.
_cached_device_id: str | None = None


def get_client() -> "spotipy.Spotify":
    client_id = os.environ.get("SPOTIPY_CLIENT_ID")
    client_secret = os.environ.get("SPOTIPY_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise RuntimeError(
            "SPOTIPY_CLIENT_ID/SPOTIPY_CLIENT_SECRET not set - create a real app at "
            "https://developer.spotify.com/dashboard and put its credentials in .env first."
        )
    auth_manager = SpotifyOAuth(
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=REDIRECT_URI,
        scope=SCOPE,
        cache_path=CACHE_PATH,
        open_browser=False,  # daemon never does the interactive flow - see this file's own header comment
    )
    return spotipy.Spotify(auth_manager=auth_manager)


def fetch_active_device_id(sp) -> str | None:
    """Real, uncached device lookup - one network call. Only called when
    there's no usable cached id (see get_device_id())."""
    devices = sp.devices()
    for d in devices.get("devices", []):
        if d.get("is_active"):
            return d["id"]
    if devices.get("devices"):
        return devices["devices"][0]["id"]
    return None


def get_device_id(sp, force_refresh: bool = False) -> str | None:
    global _cached_device_id
    if force_refresh or _cached_device_id is None:
        _cached_device_id = fetch_active_device_id(sp)
    return _cached_device_id


def cmd_play(sp, query: str):
    if not query:
        raise RuntimeError("No search query given.")
    # Real concurrency win over the one-shot script: search() and the
    # device lookup don't depend on each other, so run them on separate
    # threads instead of stacking two sequential round trips - see this
    # file's own header comment for the measured numbers.
    search_future = _executor.submit(sp.search, q=query, type="track", limit=1)
    device_future = _executor.submit(get_device_id, sp)

    results = search_future.result()
    device_id = device_future.result()
    tracks = results.get("tracks", {}).get("items", [])

    if not device_id:
        raise RuntimeError(
            "No active or available Spotify device found - open the real Spotify app (or "
            "open.spotify.com) somewhere first so there's something for playback to target."
        )

    def start(uri_kwargs: dict, device: str):
        try:
            sp.start_playback(device_id=device, **uri_kwargs)
        except spotipy.SpotifyException as e:
            # Real, disclosed recovery: a cached device id can go stale
            # (device closed/switched since the last call) - Spotify's
            # API reports that as 404 "Device not found". Refetch once
            # for real and retry, rather than surfacing a confusing
            # error for something transient and self-correctable.
            if e.http_status == 404:
                fresh_device = get_device_id(sp, force_refresh=True)
                if not fresh_device:
                    raise RuntimeError("No active or available Spotify device found (device closed mid-request).")
                sp.start_playback(device_id=fresh_device, **uri_kwargs)
            else:
                raise

    if tracks:
        track = tracks[0]
        start({"uris": [track["uri"]]}, device_id)
        return {
            "success": True,
            "playing": f"{track['name']} by {', '.join(a['name'] for a in track['artists'])}",
            "type": "track",
        }

    # No track match - try artist (plays their real top tracks context).
    # A second real network call, but only on the real fallback path, not
    # the common case - not worth parallelizing with the above since it
    # depends on knowing the first search came back empty.
    artist_results = sp.search(q=query, type="artist", limit=1)
    artists = artist_results.get("artists", {}).get("items", [])
    if artists:
        artist = artists[0]
        start({"context_uri": artist["uri"]}, device_id)
        return {"success": True, "playing": f"{artist['name']} (artist radio)", "type": "artist"}
    raise RuntimeError(f'No real track or artist found matching "{query}".')


def cmd_pause(sp):
    device_id = get_device_id(sp)
    if not device_id:
        raise RuntimeError("No active Spotify device to pause.")
    sp.pause_playback(device_id=device_id)
    return {"success": True}


def cmd_resume(sp):
    device_id = get_device_id(sp)
    if not device_id:
        raise RuntimeError("No active Spotify device to resume.")
    sp.start_playback(device_id=device_id)
    return {"success": True}


def cmd_next(sp):
    device_id = get_device_id(sp)
    if not device_id:
        raise RuntimeError("No active Spotify device.")
    sp.next_track(device_id=device_id)
    return {"success": True}


def cmd_previous(sp):
    device_id = get_device_id(sp)
    if not device_id:
        raise RuntimeError("No active Spotify device.")
    sp.previous_track(device_id=device_id)
    return {"success": True}


def cmd_status(sp):
    playback = sp.current_playback()
    if not playback or not playback.get("item"):
        return {"success": True, "isPlaying": False, "detail": "Nothing is currently playing."}
    item = playback["item"]
    return {
        "success": True,
        "isPlaying": playback.get("is_playing", False),
        "track": item.get("name"),
        "artists": [a["name"] for a in item.get("artists", [])],
        "album": item.get("album", {}).get("name"),
    }


def main() -> int:
    try:
        sp = get_client()
        # Real, deliberate: pay the "first call is slow" cost (see this
        # file's own header comment) exactly once, right here at startup,
        # the same way Chatterbox's daemon pays its model-load cost once
        # - not lazily on Gavin's first real request of the session.
        sp.current_user()
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1

    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            command = request.get("command")
            query = request.get("query", "")

            if command == "play":
                result = cmd_play(sp, query)
            elif command == "pause":
                result = cmd_pause(sp)
            elif command == "resume":
                result = cmd_resume(sp)
            elif command == "next":
                result = cmd_next(sp)
            elif command == "previous":
                result = cmd_previous(sp)
            elif command == "status":
                result = cmd_status(sp)
            else:
                result = {"success": False, "error": f"Unknown command: {command}"}
            print(json.dumps(result), flush=True)
        except Exception as e:
            # Real per-request resilience, matching the other two daemons
            # in this codebase - one bad request (a transient Spotify API
            # error, a malformed request line) doesn't kill the whole warm
            # session.
            print(json.dumps({"success": False, "error": str(e)}), flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
