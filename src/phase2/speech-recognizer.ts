/**
 * Phase 2: Speech Recognition
 *
 * Converts speech to text using a real local Whisper model (faster-whisper,
 * via scripts/whisper_transcribe.py — see recognizeAudio()), not a
 * simulation. "Streaming" here means audio chunks are buffered as they
 * arrive and the whole buffer is transcribed once recognition stops —
 * there is no true incremental/partial transcription yet, so
 * processStreamingChunk() does not emit fabricated partial-result text
 * anymore; that's a real follow-up, not built here.
 */

import { spawn } from "node:child_process";
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
  scriptPath?: string; // Path to scripts/whisper_transcribe.py
}

function resolveWhisperPaths(config: { pythonPath?: string; scriptPath?: string }) {
  const pythonPath =
    config.pythonPath || process.env.WHISPER_PYTHON_PATH || "tools/whisper/venv/bin/python";
  const scriptPath =
    config.scriptPath || process.env.WHISPER_SCRIPT_PATH || "scripts/whisper_transcribe.py";
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
   * Write the raw PCM buffer to a temp WAV file and run the real
   * faster-whisper subprocess against it.
   */
  private async runWhisper(pcm: Buffer): Promise<WhisperScriptResult> {
    const { pythonPath, scriptPath } = resolveWhisperPaths({});
    const wav = pcmToWav(pcm, this.sampleRate);
    const tempPath = join(tmpdir(), `jarvis-stt-${randomUUID()}.wav`);
    writeFileSync(tempPath, wav);

    try {
      return await new Promise<WhisperScriptResult>((resolve, reject) => {
        const proc = spawn(pythonPath, [scriptPath, this.model, tempPath, this.language]);
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        proc.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
        proc.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

        proc.on("error", (err) => {
          reject(new Error(`Failed to launch whisper at "${pythonPath}": ${err.message}. Run scripts/setup-voice.sh first.`));
        });

        proc.on("close", () => {
          const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
          let parsed: WhisperScriptResult;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            reject(new Error(`whisper_transcribe.py produced non-JSON output: ${stdout || Buffer.concat(stderrChunks).toString("utf-8")}`));
            return;
          }
          if (parsed.error) {
            reject(new Error(`whisper_transcribe.py error: ${parsed.error}`));
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
   */
  setModel(model: "tiny" | "base" | "small" | "medium" | "large") {
    this.model = model;
    console.log(`🔄 Model changed to Whisper-${model}`);
  }

  /**
   * Change language
   */
  setLanguage(language: string) {
    this.language = language;
    console.log(`🌍 Language changed to ${language}`);
  }
}
