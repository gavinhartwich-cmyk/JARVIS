/**
 * Phase 2: Microphone Capture (TypeScript side)
 *
 * The real hardware gap the master architecture doc calls out directly
 * ("there is no microphone capture anywhere in this codebase... needs
 * Gavin's PC, not this Linux sandbox") - closes it by spawning
 * scripts/mic_capture.py (real sounddevice-based capture, see that file)
 * once and streaming its stdout as PCM16 chunks for the life of the
 * process, matching the Buffer-chunk shape wake-word-detector.ts's and
 * speech-recognizer.ts's own processAudioChunk() already expect - this
 * is the missing feeder, not a redesign of either of those.
 */

import { spawn, ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export interface MicCaptureConfig {
  sampleRate: number;
  channels: number;
  blockMs?: number;
  pythonPath?: string;
  scriptPath?: string;
  // Case-insensitive substring match against the real input device list
  // (e.g. "C920" for an HD Pro Webcam C920's mic) - see mic_capture.py's
  // own header comment for why this isn't optional-but-ignored: without
  // it, sounddevice silently opens whatever the OS currently calls the
  // default input device, which is a guess on any machine with more than
  // one microphone. Falls back to MIC_DEVICE_NAME, then the OS default if
  // neither is set.
  deviceName?: string;
}

function resolveMicPaths(config: { pythonPath?: string; scriptPath?: string }) {
  // Reuses the same venv whisper_transcribe.py/wakeword_detect.py already
  // depend on (tools/whisper/venv) - scripts/setup-voice.ps1/.sh installs
  // `sounddevice` into that same venv rather than creating a second one.
  const pythonPath =
    config.pythonPath || process.env.WHISPER_PYTHON_PATH || "tools/whisper/venv/bin/python";
  const scriptPath = config.scriptPath || process.env.MIC_CAPTURE_SCRIPT_PATH || "scripts/mic_capture.py";
  return { pythonPath, scriptPath };
}

function resolveDeviceName(config: { deviceName?: string }): string {
  return config.deviceName || process.env.MIC_DEVICE_NAME || "";
}

export class MicCapture {
  private config: Required<Pick<MicCaptureConfig, "sampleRate" | "channels" | "blockMs">> &
    MicCaptureConfig;
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private bytesPerChunk: number;

  constructor(config: MicCaptureConfig) {
    const blockMs = config.blockMs ?? 250;
    this.config = { ...config, blockMs };
    // int16 PCM = 2 bytes/sample; mono capture regardless of
    // config.channels (mic_capture.py always reads channel 0 - matches
    // what wake-word-detector.ts/speech-recognizer.ts assume).
    this.bytesPerChunk = Math.round((config.sampleRate * blockMs) / 1000) * 2;
  }

  /**
   * Start capturing. onChunk fires once per underlying Python write()
   * (~blockMs worth of audio) - callers don't need to do their own
   * re-chunking. Rejects if this isn't actually Windows/doesn't have a
   * working mic pipeline; that's a real environment error, not something
   * to paper over.
   */
  start(onChunk: (chunk: Buffer) => void, onError?: (err: Error) => void): void {
    if (this.proc) return;
    const { pythonPath, scriptPath } = resolveMicPaths(this.config);

    const deviceName = resolveDeviceName(this.config);
    this.proc = spawn(
      pythonPath,
      [scriptPath, String(this.config.sampleRate), String(this.config.channels), String(this.config.blockMs), deviceName],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let pending = Buffer.alloc(0);
    this.proc.stdout.on("data", (data: Buffer) => {
      pending = Buffer.concat([pending, data]);
      // mic_capture.py writes once per block already, but stdout is a
      // byte stream with no message boundaries - re-slice into
      // fixed-size chunks here so onChunk always receives exactly one
      // block's worth, regardless of how the OS pipe happened to
      // fragment or coalesce the underlying writes.
      while (pending.length >= this.bytesPerChunk) {
        onChunk(pending.subarray(0, this.bytesPerChunk));
        pending = pending.subarray(this.bytesPerChunk);
      }
    });

    this.proc.stderr.on("data", (data: Buffer) => {
      // mic_capture.py logs its own startup line and any stream-status
      // warnings to stderr - surface them (prefixed) instead of
      // swallowing real diagnostic info.
      console.log(`   [mic] ${data.toString().trim()}`);
    });

    this.proc.on("error", (err) => {
      this.proc = null;
      onError?.(err);
    });

    this.proc.on("exit", (code) => {
      const wasRunning = this.proc !== null;
      this.proc = null;
      if (wasRunning && code !== 0 && code !== null) {
        onError?.(new Error(`mic_capture.py exited unexpectedly (code ${code})`));
      }
    });
  }

  stop(): void {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    proc.kill();
  }
}
