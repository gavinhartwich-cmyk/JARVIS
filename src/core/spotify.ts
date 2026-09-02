/**
 * Real Spotify control — TS wrapper around scripts/spotify_control.py.
 *
 * [ADDED 2026-09-02] Per Gavin's explicit choice: "For Spotify use
 * spotipy." Closes a real, previously-disclosed gap: app-control
 * (windows-control.ts) can open/close the Spotify application, but has
 * never been able to play a specific song - that needs the real Spotify
 * Web API (spotipy), not window/keyboard automation, which is why this
 * is a real Python subprocess (spotipy has no first-class equivalent
 * this codebase would trust more in TS) rather than a hand-rolled fetch()
 * against Spotify's REST API - same "shell out to a real, well-tested
 * library via Python" pattern already used for Whisper/openWakeWord/
 * Chatterbox in this project, not a new architectural choice.
 *
 * Real, disclosed dependency on Gavin's own action: this needs his own
 * Spotify Developer app (Client ID/Secret) and a one-time real OAuth
 * consent (see spotify_control.py's own header comment, and the
 * `bun run dev spotify-auth` CLI command) - cannot be done on his
 * behalf, same as the personal Gmail OAuth earlier in this project.
 * Every method here fails with a clear, real error (not a fabricated
 * success) if that setup hasn't happened yet.
 */

import { spawn } from "node:child_process";

export interface SpotifyPlayResult {
  success: boolean;
  playing?: string;
  type?: "track" | "artist";
  error?: string;
}

export interface SpotifyStatusResult {
  success: boolean;
  isPlaying?: boolean;
  track?: string;
  artists?: string[];
  album?: string;
  detail?: string;
  error?: string;
}

function resolveSpotifyPaths(): { pythonPath: string; scriptPath: string } {
  const pythonPath =
    process.env.SPOTIFY_PYTHON_PATH || process.env.WHISPER_PYTHON_PATH || "tools/whisper/venv/Scripts/python.exe";
  const scriptPath = process.env.SPOTIFY_CONTROL_SCRIPT_PATH || "scripts/spotify_control.py";
  return { pythonPath, scriptPath };
}

/**
 * Real subprocess call - spotify_control.py always prints exactly one
 * JSON object on stdout (see its own header comment), parsed here rather
 * than trusted as free text. A non-JSON or empty stdout is a real,
 * disclosed failure (the script crashed before it could even report a
 * structured error), not silently swallowed.
 */
async function runSpotifyCommand(command: string, arg?: string): Promise<any> {
  const { pythonPath, scriptPath } = resolveSpotifyPaths();
  const args = arg ? [scriptPath, command, arg] : [scriptPath, command];

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) =>
      reject(new Error(`Failed to spawn Spotify control script - is "${pythonPath}" real/on disk? (${err.message})`))
    );
    proc.on("close", () => {
      const line = stdout.trim().split("\n").pop()?.trim();
      if (!line) {
        reject(new Error(`Spotify control script produced no output (stderr: ${stderr.trim() || "none"})`));
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`Spotify control script's output wasn't real JSON: "${line}" (stderr: ${stderr.trim() || "none"})`));
      }
    });
  });
}

export async function spotifyPlay(query: string): Promise<SpotifyPlayResult> {
  return runSpotifyCommand("play", query);
}

export async function spotifyPause(): Promise<{ success: boolean; error?: string }> {
  return runSpotifyCommand("pause");
}

export async function spotifyResume(): Promise<{ success: boolean; error?: string }> {
  return runSpotifyCommand("resume");
}

export async function spotifyNext(): Promise<{ success: boolean; error?: string }> {
  return runSpotifyCommand("next");
}

export async function spotifyPrevious(): Promise<{ success: boolean; error?: string }> {
  return runSpotifyCommand("previous");
}

export async function spotifyStatus(): Promise<SpotifyStatusResult> {
  return runSpotifyCommand("status");
}

/** One-time real interactive OAuth flow - opens a real browser. See spotify_control.py's own header comment. */
export async function spotifyAuth(): Promise<{ success: boolean; detail?: string; error?: string }> {
  return runSpotifyCommand("auth");
}
