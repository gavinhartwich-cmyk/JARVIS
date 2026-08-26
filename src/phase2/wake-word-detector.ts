/**
 * Phase 2: Wake Word Detection
 *
 * Detects when the user says "Jarvis" — anywhere in speech, not just the
 * literal phrase "hey Jarvis" — using a real local openWakeWord model
 * (via scripts/wakeword_detect.py — see detectWakeWord()), not a
 * simulation.
 *
 * IMPORTANT CAVEAT: the underlying pretrained model ("hey_jarvis") was
 * only ever trained on the phrase "hey jarvis", not bare "jarvis". Real
 * measurements against Piper-synthesized clips (2026-08-26): unrelated
 * speech scores ~0.0001-0.0003 (noise floor); "hey jarvis" scores ~0.999;
 * bare "jarvis" scores 0.25-0.99 depending on sentence position and
 * cadence (higher near a pause/end-of-utterance, e.g. "jarvis, can you
 * help me" -> 0.997; lower when buried mid-sentence with no pause, e.g.
 * "...if jarvis knows the answer..." -> 0.003). voice-config.ts's default
 * sensitivity (0.15) is tuned from this real data to catch the large
 * majority of "jarvis" mentions while staying far above the noise floor
 * — but it is NOT a 100% guarantee of catching every utterance in every
 * sentence position; that outlier case would need a dedicated custom-
 * trained "jarvis" model (openWakeWord supports this, but it's
 * substantially more work than a threshold tune — see
 * jarvis-phase-1-developer memory for the full data and the open
 * decision on whether that's worth doing).
 *
 * Real continuous microphone capture doesn't exist in this codebase yet
 * (out of scope for this sandbox — needs Gavin's PC); this class buffers
 * whatever PCM16 chunks processAudioChunk() receives and runs detection
 * once ~1s has accumulated, spawning one subprocess per detection cycle.
 * That's the same "batch, not persistent-stream" tradeoff SpeechRecognizer
 * makes, and is fine for now — a persistent stdin-streaming subprocess
 * would be the next optimization once real-time mic latency matters.
 */

import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface WakeWordEvent {
  keyword: string;
  confidence: number; // 0-1
  timestamp: Date;
  audioChunk?: Buffer; // Raw audio data
}

export interface WakeWordDetectorConfig {
  keyword: string;
  sensitivity: number; // 0-1
  modelPath?: string;
  sampleRate: number;
  pythonPath?: string; // Path to the venv python with openwakeword installed
  scriptPath?: string; // Path to scripts/wakeword_detect.py
}

function resolveWakeWordPaths(config: { pythonPath?: string; scriptPath?: string }) {
  const pythonPath =
    config.pythonPath || process.env.WAKEWORD_PYTHON_PATH || "tools/whisper/venv/bin/python";
  const scriptPath =
    config.scriptPath || process.env.WAKEWORD_SCRIPT_PATH || "scripts/wakeword_detect.py";
  return { pythonPath, scriptPath };
}

/**
 * Wrap raw 16-bit mono PCM in a minimal WAV container so
 * wakeword_detect.py can load it via Python's wave module.
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

interface WakeWordScriptResult {
  model: string;
  max_score: number;
  scores: number[];
  error?: string;
}

/**
 * Wake Word Detector
 *
 * Listens to audio stream and detects when user says the wake word.
 * Uses local models (openWakeWord) for privacy.
 */
export class WakeWordDetector {
  private keyword: string;
  private sensitivity: number;
  private modelPath: string;
  private sampleRate: number;
  private pythonPath: string;
  private scriptPath: string;
  private audioBuffer: Buffer = Buffer.alloc(0);
  private isListening: boolean = false;
  private detecting: boolean = false;

  // Event listeners
  private listeners: Map<string, Function[]> = new Map();

  constructor(config: WakeWordDetectorConfig) {
    this.keyword = config.keyword;
    this.sensitivity = config.sensitivity;
    // openWakeWord model names map to a specific keyword; "hey_jarvis" is
    // the only bundled pretrained model that matches this project's
    // keyword, and is the default. A custom-trained model for a different
    // keyword would be passed here as an explicit .onnx/.tflite path.
    this.modelPath = config.modelPath || "hey_jarvis";
    this.sampleRate = config.sampleRate;
    const { pythonPath, scriptPath } = resolveWakeWordPaths(config);
    this.pythonPath = pythonPath;
    this.scriptPath = scriptPath;

    if (this.sampleRate !== 16000) {
      console.warn(
        `⚠️  WakeWordDetector configured with sampleRate=${this.sampleRate}, but openWakeWord's pretrained models require 16000Hz. Detection will be unreliable until audio is resampled to 16kHz.`
      );
    }

    this.initializeListeners();
  }

  /**
   * Initialize event listeners
   */
  private initializeListeners() {
    this.listeners.set("wake-word-detected", []);
    this.listeners.set("audio-chunk", []);
    this.listeners.set("listening-started", []);
    this.listeners.set("listening-stopped", []);
  }

  /**
   * Subscribe to wake word detector events
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
   * Start listening for wake word
   */
  async startListening(): Promise<void> {
    if (this.isListening) return;

    console.log(`🎤 Starting wake word detection for "${this.keyword}"`);
    console.log(`   Sensitivity: ${(this.sensitivity * 100).toFixed(0)}%`);

    this.isListening = true;
    this.audioBuffer = Buffer.alloc(0);
    this.emit("listening-started");

    // Real detection runs in detectWakeWord() once processAudioChunk()
    // has buffered ~1s of audio — there is no continuous mic input to read
    // from here yet (needs Gavin's PC; see file header).
    console.log("   Listening for wake word...");
  }

  /**
   * Stop listening for wake word
   */
  async stopListening(): Promise<void> {
    if (!this.isListening) return;

    console.log("🛑 Stopping wake word detection");
    this.isListening = false;
    this.audioBuffer = Buffer.alloc(0);
    this.emit("listening-stopped");
  }

  /**
   * Process audio chunk (called from microphone stream)
   *
   * Buffers raw PCM16 bytes; once ~1s has accumulated, runs it through the
   * real openWakeWord model via detectWakeWord().
   */
  async processAudioChunk(audioChunk: Buffer): Promise<void> {
    if (!this.isListening) return;

    this.audioBuffer = Buffer.concat([this.audioBuffer, audioChunk]);
    const sampleCount = this.audioBuffer.length / 2; // 16-bit samples

    this.emit("audio-chunk", {
      size: audioChunk.length / 2,
      bufferSize: sampleCount,
    });

    // Avoid overlapping subprocess runs if chunks arrive faster than
    // detection completes.
    if (sampleCount >= this.sampleRate && !this.detecting) {
      await this.detectWakeWord();
    }
  }

  /**
   * Detect wake word in the buffered audio
   *
   * Runs the real openWakeWord model (via wakeword_detect.py) against the
   * buffered PCM and emits an event if the peak score crosses sensitivity.
   */
  private async detectWakeWord(): Promise<void> {
    this.detecting = true;
    const bufferedAudio = this.audioBuffer;

    try {
      const result = await this.runWakeWordModel(bufferedAudio);
      if (result.max_score > this.sensitivity) {
        this.emitWakeWordDetected(result.max_score, bufferedAudio);
      }
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      console.error("❌ Wake word detection failed:", err);
      this.emit("error", { message: err });
    } finally {
      this.detecting = false;
      // Keep only last second of audio to avoid buffer bloat
      const maxBufferBytes = this.sampleRate * 2; // 16-bit samples
      if (this.audioBuffer.length > maxBufferBytes) {
        this.audioBuffer = this.audioBuffer.subarray(-maxBufferBytes);
      }
    }
  }

  /**
   * Write the buffered PCM to a temp WAV file and run the real
   * openWakeWord subprocess against it.
   */
  private async runWakeWordModel(pcm: Buffer): Promise<WakeWordScriptResult> {
    const wav = pcmToWav(pcm, this.sampleRate);
    const tempPath = join(tmpdir(), `jarvis-wakeword-${randomUUID()}.wav`);
    writeFileSync(tempPath, wav);

    try {
      return await new Promise<WakeWordScriptResult>((resolve, reject) => {
        const proc = spawn(this.pythonPath, [this.scriptPath, this.modelPath, tempPath]);
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        proc.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
        proc.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

        proc.on("error", (err) => {
          reject(new Error(`Failed to launch wakeword detector at "${this.pythonPath}": ${err.message}. Run scripts/setup-voice.sh first.`));
        });

        proc.on("close", () => {
          const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
          let parsed: WakeWordScriptResult;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            reject(new Error(`wakeword_detect.py produced non-JSON output: ${stdout || Buffer.concat(stderrChunks).toString("utf-8")}`));
            return;
          }
          if (parsed.error) {
            reject(new Error(`wakeword_detect.py error: ${parsed.error}`));
            return;
          }
          resolve(parsed);
        });
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
   * Emit wake word detected event
   */
  private emitWakeWordDetected(confidence: number, audioChunk: Buffer) {
    const event: WakeWordEvent = {
      keyword: this.keyword,
      confidence: Math.min(confidence, 1.0),
      timestamp: new Date(),
      audioChunk,
    };

    console.log(`🎯 Wake word detected: "${this.keyword}"`);
    console.log(`   Confidence: ${(event.confidence * 100).toFixed(1)}%`);

    this.emit("wake-word-detected", event);
  }

  /**
   * Get detector status
   */
  getStatus(): {
    isListening: boolean;
    keyword: string;
    sensitivity: number;
    bufferSize: number;
  } {
    return {
      isListening: this.isListening,
      keyword: this.keyword,
      sensitivity: this.sensitivity,
      bufferSize: this.audioBuffer.length / 2, // 16-bit samples
    };
  }

  /**
   * Set sensitivity (0-1)
   */
  setSensitivity(sensitivity: number) {
    this.sensitivity = Math.max(0, Math.min(1, sensitivity));
    console.log(`⚙️  Sensitivity adjusted to ${(this.sensitivity * 100).toFixed(0)}%`);
  }

  /**
   * Change wake word
   */
  setKeyword(keyword: string) {
    this.keyword = keyword;
    console.log(`🎯 Wake word changed to "${keyword}"`);
  }
}
