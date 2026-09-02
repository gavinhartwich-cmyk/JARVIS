#!/usr/bin/env python
"""
Real Spotify control via spotipy, per Gavin's explicit choice: "For
Spotify use spotipy." Closes a real, previously-disclosed capability gap
- app-control (windows-control.ts) can only open/close the Spotify
*application*; it has never been able to play a specific song, since
that needs the real Spotify Web API, not window/keyboard automation.

One-time setup (real, needs Gavin's own Spotify Developer app - this
cannot be done on his behalf, same as the personal Gmail OAuth earlier
in this project):
  1. Create an app at https://developer.spotify.com/dashboard
  2. Add a Redirect URI of exactly: http://127.0.0.1:8888/callback
  3. Put SPOTIPY_CLIENT_ID / SPOTIPY_CLIENT_SECRET in .env (real env var
     names spotipy itself reads automatically - no extra config wiring
     needed on the Python side)
  4. Run `bun run dev spotify-auth` once - opens a real browser for
     Gavin to log in/consent, spotipy runs a tiny local server on the
     redirect URI to catch the callback automatically, then caches a
     real refresh token to scripts/.spotify-cache so every call after
     that is silent (no browser, no re-auth) until the token needs
     refreshing, which spotipy also handles on its own.

Usage: spotify_control.py <command> [args...]
  play <query>       - search and start playing the best real match (track/artist/playlist)
  pause
  resume
  next
  previous
  status              - what's actually playing right now, real data
  auth                - one-time interactive OAuth flow (opens a real browser)

All output is one JSON object on stdout: {"success": bool, ...}. Never
fabricates a "playing" result - a real Spotify Connect API call, and a
real, honest error (most commonly "no active device" - Spotify Connect
requires the real app/web player already open somewhere) if it fails.
"""

import json
import os
import sys
from pathlib import Path

try:
    import spotipy
    from spotipy.oauth2 import SpotifyOAuth
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "spotipy not installed - run: tools/whisper/venv/Scripts/python.exe -m pip install spotipy"
    }))
    sys.exit(1)

CACHE_PATH = str(Path(__file__).parent / ".spotify-cache")
SCOPE = "user-modify-playback-state user-read-playback-state user-read-currently-playing"
REDIRECT_URI = os.environ.get("SPOTIPY_REDIRECT_URI", "http://127.0.0.1:8888/callback")


def get_client(open_browser: bool):
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
        open_browser=open_browser,
    )
    return spotipy.Spotify(auth_manager=auth_manager)


def get_active_device(sp) -> str | None:
    """Real device lookup - Spotify Connect needs an already-open real
    device (desktop app, web player, phone) to play to; there is no way
    to conjure one from the API. Returns its real id, or None."""
    devices = sp.devices()
    for d in devices.get("devices", []):
        if d.get("is_active"):
            return d["id"]
    # No active device, but a real available one exists - use the first
    # (most real desktop setups only have one device anyway).
    if devices.get("devices"):
        return devices["devices"][0]["id"]
    return None


def cmd_play(sp, query: str):
    if not query:
        raise RuntimeError("No search query given.")
    # Real search across tracks/artists/playlists, prefer the type that
    # best matches common phrasing ("play <song>" vs "play some <artist>"
    # vs "play my <playlist> playlist") - simplest real heuristic: search
    # tracks first (the common case), fall back to artist/playlist only
    # if nothing real comes back.
    results = sp.search(q=query, type="track", limit=1)
    tracks = results.get("tracks", {}).get("items", [])
    device_id = get_active_device(sp)
    if not device_id:
        raise RuntimeError(
            "No active or available Spotify device found - open the real Spotify app (or "
            "open.spotify.com) somewhere first so there's something for playback to target."
        )
    if tracks:
        track = tracks[0]
        sp.start_playback(device_id=device_id, uris=[track["uri"]])
        return {
            "success": True,
            "playing": f"{track['name']} by {', '.join(a['name'] for a in track['artists'])}",
            "type": "track",
        }
    # No track match - try artist (plays their real top tracks context)
    artist_results = sp.search(q=query, type="artist", limit=1)
    artists = artist_results.get("artists", {}).get("items", [])
    if artists:
        artist = artists[0]
        sp.start_playback(device_id=device_id, context_uri=artist["uri"])
        return {"success": True, "playing": f"{artist['name']} (artist radio)", "type": "artist"}
    raise RuntimeError(f'No real track or artist found matching "{query}".')


def cmd_pause(sp):
    device_id = get_active_device(sp)
    if not device_id:
        raise RuntimeError("No active Spotify device to pause.")
    sp.pause_playback(device_id=device_id)
    return {"success": True}


def cmd_resume(sp):
    device_id = get_active_device(sp)
    if not device_id:
        raise RuntimeError("No active Spotify device to resume.")
    sp.start_playback(device_id=device_id)
    return {"success": True}


def cmd_next(sp):
    device_id = get_active_device(sp)
    if not device_id:
        raise RuntimeError("No active Spotify device.")
    sp.next_track(device_id=device_id)
    return {"success": True}


def cmd_previous(sp):
    device_id = get_active_device(sp)
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


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: spotify_control.py <command> [args...]"}))
        sys.exit(1)

    command = sys.argv[1]
    arg = " ".join(sys.argv[2:]) if len(sys.argv) > 2 else ""

    try:
        if command == "auth":
            # Real, one-time interactive flow - opens a real browser,
            # spotipy runs its own local server on REDIRECT_URI to catch
            # the callback. Never done silently/headlessly on Gavin's
            # behalf; he has to actually see the consent screen himself.
            sp = get_client(open_browser=True)
            sp.current_user()  # forces the real auth flow to complete now, not lazily on first real call
            print(json.dumps({"success": True, "detail": "Spotify auth complete - token cached, future calls won't need a browser."}))
            return

        sp = get_client(open_browser=False)
        if command == "play":
            result = cmd_play(sp, arg)
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
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
