/**
 * Phase 2: Chatterbox Text-to-Speech (local, $0, voice cloning)
 *
 * Real local TTS via Resemble AI's open-source Chatterbox model
 * (https://github.com/resemble-ai/chatterbox), cloning a specific voice
 * from a short reference audio clip rather than using a paid named voice
 * like Fish Audio's reference_id. Added 2026-08-31 per Gavin's decision
 * to move off paid Fish Audio credits (real 402 Payment Required
 * confirmed live) while keeping a real custom "jarvis" voice, staying
 * $0.
 *
 * Persistent-daemon architecture (scripts/chatterbox_synthesize_daemon.py),
 * same reasoning as wake-word-detector.ts's persistent daemon: loading a
 * real PyTorch model (potentially several seconds, especially on first
 * GPU warm-up) on every single synthesis request would be a severe
 * regression - the daemon loads the model exactly once and stays warm
 * for the whole `listen` session, and each synthesize() call is one
 * request/response round trip over its stdin/stdout.
 *
 * Requires (NOT yet done as of 2026-08-31): scripts/setup-chatterbox.ps1
 * run once (installs a CUDA PyTorch + chatterbox-tts venv - a much
 * heavier download than Piper/Whisper/openWakeWord's setup-voice.ps1),
 * plus a real ~10s reference audio clip of the voice to clone. Gavin
 * confirmed he has an NVIDIA GPU but hadn't picked/recorded the
 * reference clip yet - so this is NOT the default provider until
 * textToSpeech.chatterbox.referenceClipPath (or CHATTERBOX_VOICE_CLIP_PATH)
 * is actually set; see tts-provider.ts's createSpeechSynthesizer().
 */

import { spawn, ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SynthesisResult, ISpeechSynthesizer } from "./speech-synthesizer";

export interface ChatterboxSynthesizerConfig {
  referenceClipPath: string; // path to the ~10s reference audio clip to clone
  speakingRate: number; // informational only - stored on SynthesisResult; Chatterbox has no speed knob wired here
  outputFormat: "wav" | "mp3"; // this path always writes wav via torchaudio regardless of what's asked for
  device?: "cuda" | "cpu" | "mps"; // default "cuda"
  pythonPath?: string; // default: CHATTERBOX_PYTHON_PATH env, else tools/chatterbox/venv/Scripts/python.exe
  scriptPath?: string; // default: scripts/chatterbox_synthesize_daemon.py
}

function resolveChatterboxPaths(config: ChatterboxSynthesizerConfig) {
  const pythonPath =
    config.pythonPath ||
    process.env.CHATTERBOX_PYTHON_PATH ||
    "tools/chatterbox/venv/Scripts/python.exe";
  const scriptPath = config.scriptPath || "scripts/chatterbox_synthesize_daemon.py";
  const device = config.device || "cuda";
  return { pythonPath, scriptPath, device };
}

interface PendingRequest {
  resolve: (v: { duration_ms: number }) => void;
  reject: (e: Error) => void;
}

export class ChatterboxSynthesizer implements ISpeechSynthesizer {
  private referenceClipPath: string;
  private speakingRate: number;
  private outputFormat: "wav" | "mp3";
  private pythonPath: string;
  private scriptPath: string;
  private device: string;

  private daemonProc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private daemonReady: Promise<void> | null = null;
  private daemonStdoutBuffer = "";
  private pendingRequest: PendingRequest | null = null;
  private isSynthesizing = false;

  constructor(config: ChatterboxSynthesizerConfig) {
    this.referenceClipPath = config.referenceClipPath;
    this.speakingRate = config.speakingRate;
    this.outputFormat = config.outputFormat;
    const { pythonPath, scriptPath, device } = resolveChatterboxPaths(config);
    this.pythonPath = pythonPath;
    this.scriptPath = scriptPath;
    this.device = device;
  }

  private ensureDaemonStarted(): Promise<void> {
    if (this.daemonReady) return this.daemonReady;

    this.daemonReady = new Promise((resolve, reject) => {
      const proc = spawn(this.pythonPath, [this.scriptPath, this.referenceClipPath, this.device], {
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessByStdio<Writable, Readable, Readable>;
      this.daemonProc = proc;

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
            // [2026-09-02] conditioning_ms is new - the daemon now
            // prepares the reference-clip conditioning exactly once at
            // startup instead of on every request (see
            // chatterbox_synthesize_daemon.py's own comment on this),
            // so this is a real one-time cost, not per-turn.
            const conditioningNote =
              typeof parsed.conditioning_ms === "number" ? `, voice conditioning: ${parsed.conditioning_ms.toFixed(0)}ms (one-time)` : "";
            console.log(`   🎭 Chatterbox model loaded (sample rate: ${parsed.sample_rate}Hz${conditioningNote})`);
            resolve();
          } else if (parsed.error) {
            if (this.pendingRequest) {
              this.pendingRequest.reject(new Error(parsed.error));
              this.pendingRequest = null;
            } else if (!readyResolved) {
              readyResolved = true;
              reject(new Error(parsed.error));
            } else {
              console.error(`   ⚠️  Chatterbox daemon error: ${parsed.error}`);
            }
          } else if (parsed.done && this.pendingRequest) {
            this.pendingRequest.resolve({ duration_ms: parsed.duration_ms });
            this.pendingRequest = null;
          }
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        console.error(`   [chatterbox] ${chunk.toString("utf-8").trim()}`);
      });

      proc.on("error", (err) => {
        this.daemonProc = null;
        this.daemonReady = null;
        if (!readyResolved) {
          readyResolved = true;
          reject(err);
        }
      });

      proc.on("close", (code) => {
        this.daemonProc = null;
        this.daemonReady = null;
        if (this.pendingRequest) {
          this.pendingRequest.reject(new Error(`Chatterbox daemon exited (code ${code}) mid-request`));
          this.pendingRequest = null;
        }
        if (!readyResolved) {
          readyResolved = true;
          reject(new Error(`Chatterbox daemon exited (code ${code}) before becoming ready`));
        }
      });
    });

    return this.daemonReady;
  }

  async synthesize(text: string): Promise<SynthesisResult> {
    if (this.isSynthesizing) {
      throw new Error("Synthesis already in progress");
    }
    if (!text || text.trim().length === 0) {
      throw new Error("Text cannot be empty");
    }

    console.log("\n🎭 Starting Chatterbox text-to-speech synthesis (local voice clone)");
    console.log(`   Text: "${text.substring(0, 100)}${text.length > 100 ? "..." : ""}"`);
    console.log(`   Reference clip: ${this.referenceClipPath}`);

    this.isSynthesizing = true;
    const startTime = Date.now();
    const outPath = join(tmpdir(), `jarvis-chatterbox-${randomUUID()}.wav`);

    try {
      await this.ensureDaemonStarted();
      if (!this.daemonProc) {
        throw new Error("Chatterbox daemon is not running");
      }

      const { duration_ms } = await new Promise<{ duration_ms: number }>((resolve, reject) => {
        this.pendingRequest = { resolve, reject };
        this.daemonProc!.stdin.write(JSON.stringify({ text, out_path: outPath }) + "\n");
      });

      const audio = readFileSync(outPath);
      const wallTime = Date.now() - startTime;

      const result: SynthesisResult = {
        text,
        audio,
        duration: duration_ms,
        voiceId: this.referenceClipPath,
        speakingRate: this.speakingRate,
        timestamp: new Date(),
      };

      console.log(
        `✅ Chatterbox synthesis complete: ${audio.length} bytes (${wallTime}ms wall time, ${duration_ms.toFixed(0)}ms model time)`
      );
      return result;
    } finally {
      this.isSynthesizing = false;
      try {
        unlinkSync(outPath);
      } catch {
        // Best-effort cleanup - a leftover temp WAV isn't worth failing over.
      }
    }
  }

  getStatus() {
    return {
      isSynthesizing: this.isSynthesizing,
      voiceId: this.referenceClipPath,
      speakingRate: this.speakingRate,
      outputFormat: this.outputFormat,
    };
  }

  setVoice(referenceClipPath: string) {
    if (this.isSynthesizing) {
      throw new Error("Cannot change voice while synthesizing");
    }
    // Changing the reference clip means the warm model needs to be
    // re-primed with the new clip - real limitation, not faked: kill the
    // running daemon so the next synthesize() respawns it with the new
    // path (paying the model-load cost once more, same as the very first
    // synthesis of a session).
    this.referenceClipPath = referenceClipPath;
    if (this.daemonProc) {
      this.daemonProc.kill();
      this.daemonProc = null;
      this.daemonReady = null;
    }
    console.log(`🎭 Chatterbox voice changed to reference clip ${referenceClipPath} (daemon will restart on next synthesis)`);
  }

  setSpeakingRate(rate: number) {
    if (this.isSynthesizing) {
      throw new Error("Cannot change speaking rate while synthesizing");
    }
    this.speakingRate = Math.max(0.5, Math.min(2.0, rate));
  }

  /**
   * [ADDED 2026-09-02] Real, live-found fix: just calls the same real
   * ensureDaemonStarted() a normal synthesize() call would lazily trigger
   * on its own - the only difference is WHEN. Called proactively by
   * cli.ts's `listen` command right after startup (not awaited/blocking -
   * fired in the background so mic/wake-word detection isn't held up
   * waiting for it) so the real ~65s one-time model-load/voice-
   * conditioning cost gets paid during the "just started, nobody's
   * talking yet" window instead of silently during the first real
   * request. If a real request DOES arrive before this finishes, nothing
   * breaks - synthesize() below awaits the exact same daemonReady promise
   * either way, it just won't have gotten a head start.
   */
  async warmUp(): Promise<void> {
    await this.ensureDaemonStarted();
  }

  /** Real persistent-process teardown - called once at full session end
   * (VoiceInterface.stop()), NOT between turns. */
  shutdown(): void {
    if (this.daemonProc) {
      this.daemonProc.stdin.end();
      this.daemonProc.kill();
      this.daemonProc = null;
      this.daemonReady = null;
    }
  }
}
