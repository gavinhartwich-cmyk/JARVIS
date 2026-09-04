/**
 * Phase 2: Speech Recognition
 *
 * Converts speech to text using a real local Whisper model (faster-whisper,
 * via scripts/whisper_transcribe_daemon.py — see runWhisper()), not a
 * simulation. "Streaming" here means audio chunks are buffered as they
 * arrive and the whole buffer is transcribed once recognition stops —
 * there is no true incremental/partial transcription yet, so
 * processStreamingChunk() does not emit fabricated partial-result text
 * anymore; that's a real follow-up, not built here.
 *
 * [UPDATE 2026-09-03] Real live-testing finding, per Gavin's "were stul
 * SUPER slow": runWhisper() used to spawn a brand-new
 * `python whisper_transcribe.py` process and reload the whole faster-
 * whisper model from scratch on EVERY single utterance - measured live
 * at ~1.18s of model-load cost paid again every turn, for a model,
 * device, and compute_type that never actually change mid-session.
 * Rewritten to the same persistent-daemon pattern already proven for
 * Chatterbox (chatterbox-synthesizer.ts) and the wake-word detector: one
 * long-lived `whisper_transcribe_daemon.py` process, one JSON
 * request/response per stdin/stdout line, model loaded exactly once.
 */

import { spawn, ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface RecognitionResult {
  text: string;
  confidence: number; // 0-1
  language: string;
  isFinal: boolean; // true if this is the final result
  alternatives?: string[]; // Alternative interpretations
  timestamp: Date;
  duration: number; // Duration of audio processed (ms)
}

export interface SpeechRecognizerConfig {
  model: "tiny" | "base" | "small" | "medium" | "large";
  language: string;
  streaming: boolean;
  responseFormat: "text" | "json" | "verbose_json";
  sampleRate: number;
  pythonPath?: string; // Path to the venv python with faster-whisper installed
  scriptPath?: string; // Path to scripts/whisper_transcribe_daemon.py
}

function resolveWhisperPaths(config: { pythonPath?: string; scriptPath?: string }) {
  const pythonPath =
    config.pythonPath || process.env.WHISPER_PYTHON_PATH || "tools/whisper/venv/bin/python";
  const scriptPath =
    config.scriptPath || process.env.WHISPER_DAEMON_SCRIPT_PATH || "scripts/whisper_transcribe_daemon.py";
  return { pythonPath, scriptPath };
}

/**
 * Wrap raw 16-bit mono PCM in a minimal WAV container so whisper (via
 * ffmpeg/av under the hood) can decode it — recognizeAudio() receives raw
 * PCM chunks, not a file, so this has to happen before every transcription.
 */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

interface WhisperScriptResult {
  text: string;
  language: string;
  language_probability: number;
  duration: number;
  segments: { start: number; end: number; text: string; avg_logprob: number }[];
  error?: string;
}

/**
 * Speech Recognizer
 *
 * Uses Whisper (via whisper.cpp or Python API) for speech-to-text
 * Supports both streaming and batch processing
 */
export class SpeechRecognizer {
  private model: string;
  private language: string;
  private streaming: boolean;
  private responseFormat: string;
  private sampleRate: number;

  // Event listeners
  private listeners: Map<string, Function[]> = new Map();

  // Processing state
  private isProcessing: boolean = false;
  private audioBuffer: Buffer = Buffer.alloc(0);
  private startTime: Date = new Date();

  // Persistent daemon state - see this file's header comment.
  private daemonProc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private daemonReady: Promise<void> | null = null;
  private daemonStdoutBuffer = "";
  private pendingRequest: { resolve: (v: WhisperScriptResult) => void; reject: (e: Error) => void } | null = null;

  constructor(config: SpeechRecognizerConfig) {
    this.model = config.model;
    this.language = config.language;
    this.streaming = config.streaming;
    this.responseFormat = config.responseFormat;
    this.sampleRate = config.sampleRate;

    this.initializeListeners();
  }

  /**
   * Initialize event listeners
   */
  private initializeListeners() {
    this.listeners.set("partial-result", []);
    this.listeners.set("final-result", []);
    this.listeners.set("error", []);
    this.listeners.set("processing-started", []);
    this.listeners.set("processing-completed", []);
  }

  /**
   * Subscribe to recognition events
   */
  on(event: string, callback: Function) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  /**
   * Emit event
   */
  private emit(event: string, data?: any) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach((callback) => callback(data));
  }

  /**
   * Start streaming recognition
   */
  async startStreaming(): Promise<void> {
    if (this.isProcessing) return;

    console.log("🎤 Starting speech recognition (streaming mode)");
    console.log(`   Model: Whisper-${this.model}`);
    console.log(`   Language: ${this.language}`);

    this.isProcessing = true;
    this.audioBuffer = Buffer.alloc(0);
    this.startTime = new Date();
    this.emit("processing-started");
  }

  /**
   * Stop streaming recognition and return final result
   */
  async stopStreaming(): Promise<RecognitionResult> {
    if (!this.isProcessing) {
      throw new Error("Not currently recognizing");
    }

    console.log("⏹️  Stopping speech recognition");
    this.isProcessing = false;

    return this.recognizeAudio(this.audioBuffer);
  }

  /**
   * Process audio chunk (called from microphone stream)
   *
   * If streaming is enabled, sends chunk to Whisper for immediate processing
   */
  async processAudioChunk(audioChunk: Buffer): Promise<void> {
    if (!this.isProcessing) return;

    this.audioBuffer = Buffer.concat([this.audioBuffer, audioChunk]);

    if (this.streaming) {
      // Streaming mode: process every chunk
      // In real implementation: send to Whisper API for streaming recognition
      await this.processStreamingChunk(audioChunk);
    }
  }

  /**
   * Process a streaming audio chunk (internal)
   *
   * Real incremental/partial transcription isn't built — this just buffers
   * (processAudioChunk already appended the chunk before calling this).
   * No partial-result event is emitted per chunk anymore, since the old
   * behavior fabricated a fixed placeholder string on every call.
   */
  private async processStreamingChunk(chunk: Buffer): Promise<void> {
    // Real per-chunk incremental decoding would go here; not implemented.
  }

  /**
   * Recognize complete audio buffer
   *
   * This is the main recognition function that calls Whisper
   */
  private async recognizeAudio(audio: Buffer): Promise<RecognitionResult> {
    console.log("\n📝 Processing audio with Whisper...");
    console.log(`   Duration: ${(audio.length / (this.sampleRate * 2)).toFixed(2)}s`);

    try {
      const whisperResult = await this.runWhisper(audio);
      const duration = new Date().getTime() - this.startTime.getTime();

      // avg_logprob is a per-token log-likelihood (<=0); exp() turns it into
      // a rough 0-1 confidence proxy. Not calibrated against ground truth,
      // but it's a real model signal, not a hardcoded number.
      const avgLogprob =
        whisperResult.segments.length > 0
          ? whisperResult.segments.reduce((sum, s) => sum + s.avg_logprob, 0) / whisperResult.segments.length
          : -1;

      const result: RecognitionResult = {
        text: whisperResult.text,
        confidence: Math.exp(avgLogprob),
        language: whisperResult.language,
        isFinal: true,
        timestamp: new Date(),
        duration,
      };

      console.log(`✅ Recognition complete: "${result.text}"`);
      console.log(`   Confidence: ${(result.confidence * 100).toFixed(1)}%`);
      console.log(`   Processing time: ${duration}ms`);

      this.emit("final-result", result);
      this.emit("processing-completed", result);

      return result;
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      console.error("❌ Recognition failed:", err);
      this.emit("error", { message: err });
      throw error;
    }
  }

  /**
   * Recognize audio from buffer (batch mode)
   */
  async recognize(audioBuffer: Buffer): Promise<RecognitionResult> {
    console.log("🎤 Recognizing audio (batch mode)");
    return this.recognizeAudio(audioBuffer);
  }

  /**
   * Start (if not already starting/started) the persistent Whisper daemon
   * and resolve once it reports {"ready": true}. Mirrors
   * chatterbox-synthesizer.ts's ensureDaemonStarted() exactly - same
   * newline-delimited-JSON stdin/stdout protocol shape, same
   * single-pending-request assumption (fine here since runWhisper() is
   * always awaited to completion by its one caller, recognizeAudio(),
   * before the next call can start).
   */
  private ensureDaemonStarted(): Promise<void> {
    if (this.daemonReady) return this.daemonReady;

    const { pythonPath, scriptPath } = resolveWhisperPaths({});

    this.daemonReady = new Promise((resolve, reject) => {
      const proc = spawn(pythonPath, [scriptPath, this.model, this.language], {
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
            console.log(`   📝 Whisper-${this.model} model loaded (persistent daemon, warm for the rest of this session)`);
            resolve();
          } else if (parsed.error) {
            if (this.pendingRequest) {
              this.pendingRequest.reject(new Error(parsed.error));
              this.pendingRequest = null;
            } else if (!readyResolved) {
              readyResolved = true;
              reject(new Error(parsed.error));
            } else {
              console.error(`   ⚠️  Whisper daemon error: ${parsed.error}`);
            }
          } else if (parsed.text !== undefined && this.pendingRequest) {
            this.pendingRequest.resolve(parsed as WhisperScriptResult);
            this.pendingRequest = null;
          }
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        console.error(`   [whisper] ${chunk.toString("utf-8").trim()}`);
      });

      proc.on("error", (err) => {
        this.daemonProc = null;
        this.daemonReady = null;
        if (!readyResolved) {
          readyResolved = true;
          reject(new Error(`Failed to launch whisper daemon at "${pythonPath}": ${err.message}. Run scripts/setup-voice.sh first.`));
        }
      });

      proc.on("close", (code) => {
        this.daemonProc = null;
        this.daemonReady = null;
        if (this.pendingRequest) {
          this.pendingRequest.reject(new Error(`Whisper daemon exited (code ${code}) mid-request`));
          this.pendingRequest = null;
        }
        if (!readyResolved) {
          readyResolved = true;
          reject(new Error(`Whisper daemon exited (code ${code}) before becoming ready`));
        }
      });
    });

    return this.daemonReady;
  }

  /**
   * Write the raw PCM buffer to a temp WAV file and send one
   * request/response round trip to the persistent Whisper daemon.
   */
  private async runWhisper(pcm: Buffer): Promise<WhisperScriptResult> {
    const wav = pcmToWav(pcm, this.sampleRate);
    const tempPath = join(tmpdir(), `jarvis-stt-${randomUUID()}.wav`);
    writeFileSync(tempPath, wav);

    try {
      await this.ensureDaemonStarted();
      if (!this.daemonProc) {
        throw new Error("Whisper daemon is not running");
      }

      return await new Promise<WhisperScriptResult>((resolve, reject) => {
        this.pendingRequest = { resolve, reject };
        this.daemonProc!.stdin.write(JSON.stringify({ audio_path: tempPath, language: this.language }) + "\n");
      });
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {
        // best-effort cleanup
      }
    }
  }

  /**
   * [ADDED 2026-09-03] Proactive daemon start, mirroring
   * ChatterboxSynthesizer.warmUp() exactly - called fire-and-forget from
   * voice-interface.ts's start() so the real ~1s model-load cost is paid
   * during the "just started, nobody's talking yet" window instead of
   * silently during the first real utterance.
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

  /**
   * Get recognizer status
   */
  getStatus(): {
    isProcessing: boolean;
    model: string;
    language: string;
    streaming: boolean;
    bufferSize: number;
  } {
    return {
      isProcessing: this.isProcessing,
      model: this.model,
      language: this.language,
      streaming: this.streaming,
      bufferSize: this.audioBuffer.length,
    };
  }

  /**
   * Change model
   *
   * The daemon's model size is fixed at spawn time (unlike `language`,
   * which is sent fresh on every request and needs no restart) - real
   * limitation, not faked: kill the running daemon so the next
   * transcription respawns it with the new size, same tradeoff
   * ChatterboxSynthesizer.setVoice() already documents for its own
   * daemon.
   */
  setModel(model: "tiny" | "base" | "small" | "medium" | "large") {
    this.model = model;
    if (this.daemonProc) {
      this.daemonProc.kill();
      this.daemonProc = null;
      this.daemonReady = null;
    }
    console.log(`🔄 Model changed to Whisper-${model} (daemon will restart on next transcription)`);
  }

  /**
   * Change language
   */
  setLanguage(language: string) {
    this.language = language;
    console.log(`🌍 Language changed to ${language}`);
  }
}
