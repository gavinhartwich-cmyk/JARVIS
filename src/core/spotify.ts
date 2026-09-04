/**
 * Real Spotify control — TS wrapper around scripts/spotify_control_daemon.py.
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
 * [CHANGED 2026-09-03] Per Gavin, live-confirmed but "slow": playback
 * worked end to end but every call spawned a brand-new Python process -
 * measured live at ~350ms just for interpreter start + `import spotipy`,
 * PLUS a real ~550-825ms "first network call of a fresh process" cost
 * (TLS handshake + spotipy's own token-expiry check) that a warm
 * process's second call onward doesn't pay, PLUS `play` specifically
 * stacked three sequential API round trips (search -> devices ->
 * start_playback) where two of them don't actually depend on each other.
 * Same real fix already applied to Whisper/openWakeWord/Chatterbox in
 * this codebase for the same class of problem: a persistent daemon
 * (scripts/spotify_control_daemon.py) that authenticates once and stays
 * warm for the whole `listen` session, now also running search() and the
 * device lookup concurrently and caching the last-known device id - see
 * that script's own header comment for the full measured breakdown.
 *
 * `spotifyAuth()` deliberately still spawns the original one-shot
 * `spotify_control.py` script instead of the daemon - it needs a real
 * interactive browser + spotipy's own local callback server, which has
 * no reason to live in a long-running background process and is only
 * ever run once by hand (`bun run dev spotify-auth`).
 *
 * Real, disclosed dependency on Gavin's own action: this needs his own
 * Spotify Developer app (Client ID/Secret) and a one-time real OAuth
 * consent (see spotify_control_daemon.py's own header comment, and the
 * `bun run dev spotify-auth` CLI command) - cannot be done on his
 * behalf, same as the personal Gmail OAuth earlier in this project.
 * Every method here fails with a clear, real error (not a fabricated
 * success) if that setup hasn't happened yet.
 */

import { spawn, ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

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

function resolveSpotifyPaths(): { pythonPath: string; scriptPath: string; daemonScriptPath: string } {
  const pythonPath =
    process.env.SPOTIFY_PYTHON_PATH || process.env.WHISPER_PYTHON_PATH || "tools/whisper/venv/Scripts/python.exe";
  const scriptPath = process.env.SPOTIFY_CONTROL_SCRIPT_PATH || "scripts/spotify_control.py";
  const daemonScriptPath = process.env.SPOTIFY_CONTROL_DAEMON_SCRIPT_PATH || "scripts/spotify_control_daemon.py";
  return { pythonPath, scriptPath, daemonScriptPath };
}

interface PendingRequest {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

/**
 * Persistent-daemon controller - same shape as ChatterboxSynthesizer's
 * daemon management (chatterbox-synthesizer.ts), reused here for the
 * same real reason: pay process-start/auth costs once, not per call.
 */
class SpotifyController {
  private daemonProc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private daemonReady: Promise<void> | null = null;
  private daemonStdoutBuffer = "";
  private pendingRequest: PendingRequest | null = null;
  private requestQueue: Promise<any> = Promise.resolve();

  private ensureDaemonStarted(): Promise<void> {
    if (this.daemonReady) return this.daemonReady;

    const { pythonPath, daemonScriptPath } = resolveSpotifyPaths();

    this.daemonReady = new Promise((resolve, reject) => {
      const proc = spawn(pythonPath, [daemonScriptPath], {
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessByStdio<Writable, Readable, Readable>;
      this.daemonProc = proc;
      // Real, deliberate: don't let this background process alone keep a
      // one-shot CLI command (e.g. `bun run dev spotify-test`) from
      // exiting - when the parent process exits normally its stdio pipes
      // close, which ends the daemon's own `for line in sys.stdin` loop
      // and lets it exit cleanly on its own. A real `listen` session
      // still explicitly kills it via shutdown() below at session end,
      // same as the Chatterbox/Whisper daemons.
      proc.unref();

      let readyResolved = false;

      proc.stdout.on("data", (chunk: Buffer) => {
        this.daemonStdoutBuffer += chunk.toString("utf-8");
        let newlineIndex: number;
        while ((newlineIndex = this.daemonStdoutBuffer.indexOf("\n")) !== -1) {
          const line = this.daemonStdoutBuffer.slice(0, newlineIndex).trim();
          this.daemonStdoutBuffer = this.daemonStdoutBuffer.slice(newlineIndex + 1);
          if (!line) continue;

          let parsed: any;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue; // not a JSON status line - ignore rather than crash
          }

          if (parsed.ready && !readyResolved) {
            readyResolved = true;
            console.log("   🎵 Spotify daemon authenticated and ready (warm for the rest of this session)");
            resolve();
          } else if (!readyResolved && parsed.error !== undefined) {
            readyResolved = true;
            reject(new Error(parsed.error));
          } else if (this.pendingRequest) {
            this.pendingRequest.resolve(parsed);
            this.pendingRequest = null;
          }
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        console.error(`   [spotify] ${chunk.toString("utf-8").trim()}`);
      });

      proc.on("error", (err) => {
        this.daemonProc = null;
        this.daemonReady = null;
        if (!readyResolved) {
          readyResolved = true;
          reject(new Error(`Failed to spawn Spotify daemon - is "${pythonPath}" real/on disk? (${err.message})`));
        }
      });

      proc.on("close", (code) => {
        this.daemonProc = null;
        this.daemonReady = null;
        if (this.pendingRequest) {
          this.pendingRequest.reject(new Error(`Spotify daemon exited (code ${code}) mid-request`));
          this.pendingRequest = null;
        }
        if (!readyResolved) {
          readyResolved = true;
          reject(new Error(`Spotify daemon exited (code ${code}) before becoming ready`));
        }
      });
    });

    return this.daemonReady;
  }

  /** Real, deliberate one-at-a-time serialization - matches the daemon's
   * own single-request-in-flight protocol (see its own header comment)
   * rather than risking two requests' stdout lines interleaving. */
  private sendCommand(command: string, query?: string): Promise<any> {
    const run = () =>
      new Promise((resolve, reject) => {
        this.ensureDaemonStarted()
          .then(() => {
            if (!this.daemonProc) {
              reject(new Error("Spotify daemon is not running"));
              return;
            }
            this.pendingRequest = { resolve, reject };
            this.daemonProc.stdin.write(JSON.stringify({ command, query: query ?? "" }) + "\n");
          })
          .catch(reject);
      });

    this.requestQueue = this.requestQueue.then(run, run);
    return this.requestQueue;
  }

  async play(query: string): Promise<SpotifyPlayResult> {
    return this.sendCommand("play", query);
  }
  async pause(): Promise<{ success: boolean; error?: string }> {
    return this.sendCommand("pause");
  }
  async resume(): Promise<{ success: boolean; error?: string }> {
    return this.sendCommand("resume");
  }
  async next(): Promise<{ success: boolean; error?: string }> {
    return this.sendCommand("next");
  }
  async previous(): Promise<{ success: boolean; error?: string }> {
    return this.sendCommand("previous");
  }
  async status(): Promise<SpotifyStatusResult> {
    return this.sendCommand("status");
  }

  /** Same real reasoning as ChatterboxSynthesizer.warmUp() - pay the
   * one-time daemon-start + first-auth-call cost during startup's "just
   * started, nobody's talking yet" window instead of during Gavin's
   * first real "play X" request. Fire-and-forget from the caller. */
  async warmUp(): Promise<void> {
    await this.ensureDaemonStarted();
  }

  /** Real persistent-process teardown - called once at full session end
   * (VoiceInterface.stop()), same as Chatterbox/Whisper. */
  shutdown(): void {
    if (this.daemonProc) {
      this.daemonProc.stdin.end();
      this.daemonProc.kill();
      this.daemonProc = null;
      this.daemonReady = null;
    }
  }
}

// Module-level singleton - orchestrator.ts and cli.ts both call the
// plain functions below, unchanged from before this daemon existed, so
// this is the one place that actually holds the warm process.
const controller = new SpotifyController();

export async function spotifyPlay(query: string): Promise<SpotifyPlayResult> {
  return controller.play(query);
}

export async function spotifyPause(): Promise<{ success: boolean; error?: string }> {
  return controller.pause();
}

export async function spotifyResume(): Promise<{ success: boolean; error?: string }> {
  return controller.resume();
}

export async function spotifyNext(): Promise<{ success: boolean; error?: string }> {
  return controller.next();
}

export async function spotifyPrevious(): Promise<{ success: boolean; error?: string }> {
  return controller.previous();
}

export async function spotifyStatus(): Promise<SpotifyStatusResult> {
  return controller.status();
}

/** [ADDED 2026-09-03] Same real reasoning/wiring as speechSynthesizer's
 * and speechRecognizer's warmUp() in voice-interface.ts - see
 * SpotifyController.warmUp()'s own comment. */
export async function spotifyWarmUp(): Promise<void> {
  return controller.warmUp();
}

/** [ADDED 2026-09-03] Same real wiring as the other two daemons' shutdown -
 * called from VoiceInterface.stop(). */
export function spotifyShutdown(): void {
  controller.shutdown();
}

/**
 * One-time real interactive OAuth flow - opens a real browser. Kept as a
 * separate one-shot subprocess (NOT the daemon) - see this file's own
 * header comment for why. See spotify_control.py's own header comment
 * for the full setup steps.
 */
export async function spotifyAuth(): Promise<{ success: boolean; detail?: string; error?: string }> {
  const { pythonPath, scriptPath } = resolveSpotifyPaths();
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonPath, [scriptPath, "auth"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) =>
      reject(new Error(`Failed to spawn Spotify auth script - is "${pythonPath}" real/on disk? (${err.message})`))
    );
    proc.on("close", () => {
      const line = stdout.trim().split("\n").pop()?.trim();
      if (!line) {
        reject(new Error(`Spotify auth script produced no output (stderr: ${stderr.trim() || "none"})`));
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`Spotify auth script's output wasn't real JSON: "${line}" (stderr: ${stderr.trim() || "none"})`));
      }
    });
  });
}
