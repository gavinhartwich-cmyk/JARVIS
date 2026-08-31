/**
 * Phase 2: Text-to-Speech Synthesis
 *
 * Converts text to natural-sounding speech using Piper (real local binary,
 * not a simulation — see synthesizeWithPiper()).
 * Streaming output (synthesizeStreaming) currently chunks the finished
 * WAV rather than generating audio incrementally — Piper is not being run
 * in a true low-latency streaming mode yet, so don't call this "streaming
 * synthesis" in status reports until that's actually built.
 */

import { spawn } from "node:child_process";

export interface SynthesisResult {
  text: string;
  audio: Buffer; // WAV or MP3 audio data
  duration: number; // Duration of audio (ms)
  voiceId: string;
  speakingRate: number;
  timestamp: Date;
}

export interface SynthesizerConfig {
  voiceId: string;
  speakingRate: number; // 0.5-2.0, default 1.0
  outputFormat: "wav" | "mp3";
  modelPath?: string; // Path to the Piper .onnx voice model
  sampleRate: number;
  piperBinaryPath?: string; // Path to the piper executable
  espeakDataPath?: string; // Path to piper's bundled espeak-ng-data dir
}

/**
 * Shared shape both SpeechSynthesizer (Piper) and FishAudioSynthesizer
 * implement, so voice-interface.ts and tts-provider.ts's fallback wrapper
 * can treat either one interchangeably. Added 2026-08-31 alongside the
 * Fish Audio integration - see tts-provider.ts.
 */
export interface ISpeechSynthesizer {
  synthesize(text: string): Promise<SynthesisResult>;
  setVoice(voiceId: string): void;
  setSpeakingRate(rate: number): void;
  getStatus(): {
    isSynthesizing: boolean;
    voiceId: string;
    speakingRate: number;
    outputFormat: string;
  };
}

function resolvePiperPaths(config: SynthesizerConfig) {
  const binaryPath =
    config.piperBinaryPath ||
    process.env.PIPER_BINARY_PATH ||
    "tools/piper/piper/piper";
  // Real bug found 2026-08-26: this used to hardcode en_US-amy-medium
  // regardless of config.voiceId, so changing voiceId silently did
  // nothing — the log line said one voice while a different model
  // actually spoke. Derive the model path from voiceId by convention
  // (models/piper/<voiceId>.onnx, matching scripts/setup-voice.sh's
  // download naming) so voiceId actually selects the model.
  const modelPath =
    config.modelPath ||
    process.env.PIPER_MODEL_PATH ||
    `models/piper/${config.voiceId}.onnx`;
  const espeakDataPath =
    config.espeakDataPath ||
    process.env.PIPER_ESPEAK_DATA_PATH ||
    "tools/piper/piper/espeak-ng-data";
  return { binaryPath, modelPath, espeakDataPath };
}

/**
 * Parse a little-endian PCM WAV buffer's real duration (ms) from its header,
 * instead of guessing from word count.
 */
function wavDurationMs(wav: Buffer): number {
  // Standard WAV: byteRate at offset 28 (uint32 LE), data chunk size found
  // by scanning for the "data" subchunk (works whether or not there are
  // extra chunks like LIST before it).
  const byteRate = wav.readUInt32LE(28);
  let offset = 12; // after RIFF header
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      return byteRate > 0 ? (chunkSize / byteRate) * 1000 : 0;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return 0;
}

/**
 * Speech Synthesizer
 *
 * Uses Piper (local TTS) for text-to-speech conversion
 * Produces high-quality, natural-sounding speech
 */
export class SpeechSynthesizer implements ISpeechSynthesizer {
  private voiceId: string;
  private speakingRate: number;
  private outputFormat: string;
  private modelPath?: string;
  private sampleRate: number;

  // Event listeners
  private listeners: Map<string, Function[]> = new Map();

  // Processing state
  private isSynthesizing: boolean = false;

  constructor(config: SynthesizerConfig) {
    this.voiceId = config.voiceId;
    this.speakingRate = config.speakingRate;
    this.outputFormat = config.outputFormat;
    this.modelPath = config.modelPath;
    this.sampleRate = config.sampleRate;

    this.initializeListeners();
  }

  /**
   * Initialize event listeners
   */
  private initializeListeners() {
    this.listeners.set("synthesis-started", []);
    this.listeners.set("audio-chunk", []);
    this.listeners.set("synthesis-complete", []);
    this.listeners.set("error", []);
  }

  /**
   * Subscribe to synthesis events
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
   * Synthesize text to speech
   *
   * In real implementation, this would:
   * 1. Call Piper TTS with the text
   * 2. Apply speaking rate adjustment
   * 3. Generate audio stream
   * 4. Return audio buffer
   */
  async synthesize(text: string): Promise<SynthesisResult> {
    if (this.isSynthesizing) {
      throw new Error("Synthesis already in progress");
    }

    if (!text || text.trim().length === 0) {
      throw new Error("Text cannot be empty");
    }

    console.log("\n🎙️  Starting text-to-speech synthesis");
    console.log(`   Text: "${text.substring(0, 100)}${text.length > 100 ? "..." : ""}"`);
    console.log(`   Voice: ${this.voiceId}`);
    console.log(`   Speaking Rate: ${this.speakingRate}x`);

    this.isSynthesizing = true;
    const startTime = new Date();

    try {
      this.emit("synthesis-started", { text });

      const audioBuffer = await this.synthesizeWithPiper(text);
      const audioDuration = wavDurationMs(audioBuffer);

      const duration = new Date().getTime() - startTime.getTime();

      const result: SynthesisResult = {
        text,
        audio: audioBuffer,
        duration: audioDuration,
        voiceId: this.voiceId,
        speakingRate: this.speakingRate,
        timestamp: new Date(),
      };

      console.log(`✅ Synthesis complete: ${audioDuration.toFixed(0)}ms of audio (${duration}ms wall time)`);

      this.emit("synthesis-complete", result);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      console.error("❌ Synthesis failed:", err);
      this.emit("error", { message: err });
      throw error;
    } finally {
      this.isSynthesizing = false;
    }
  }

  /**
   * Run the real Piper binary as a subprocess: pipe text to stdin, read the
   * generated WAV back over stdout. No temp files, no mocking.
   */
  private async synthesizeWithPiper(text: string): Promise<Buffer> {
    const { binaryPath, modelPath, espeakDataPath } = resolvePiperPaths({
      voiceId: this.voiceId,
      speakingRate: this.speakingRate,
      outputFormat: this.outputFormat as "wav" | "mp3",
      modelPath: this.modelPath,
      sampleRate: this.sampleRate,
    });

    return new Promise((resolve, reject) => {
      const args = [
        "-m", modelPath,
        "-f", "-", // write WAV to stdout
        "--espeak_data", espeakDataPath,
        "--length_scale", String(1 / this.speakingRate),
        "-q",
      ];
      const proc = spawn(binaryPath, args);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      proc.on("error", (err) => {
        reject(new Error(`Failed to launch piper at "${binaryPath}": ${err.message}. Run scripts/setup-voice.sh first.`));
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`piper exited with code ${code}: ${Buffer.concat(stderrChunks).toString("utf-8")}`));
          return;
        }
        const audio = Buffer.concat(stdoutChunks);
        if (audio.length < 44) {
          // Smaller than a minimal WAV header means piper produced nothing usable.
          reject(new Error(`piper produced no usable audio (${audio.length} bytes). stderr: ${Buffer.concat(stderrChunks).toString("utf-8")}`));
          return;
        }
        resolve(audio);
      });

      proc.stdin.write(text);
      proc.stdin.end();
    });
  }

  /**
   * Stream synthesis results
   *
   * Plays audio as it's synthesized (not waiting for complete synthesis)
   */
  async *synthesizeStreaming(text: string): AsyncGenerator<Buffer> {
    if (this.isSynthesizing) {
      throw new Error("Synthesis already in progress");
    }

    console.log("\n🎙️  Starting streaming text-to-speech synthesis");
    console.log(`   Text: "${text.substring(0, 100)}${text.length > 100 ? "..." : ""}"`);

    this.isSynthesizing = true;

    try {
      this.emit("synthesis-started", { text });

      // NOT true low-latency streaming yet: Piper still generates the whole
      // clip first, then this slices the real WAV into playback-sized
      // chunks. Genuine incremental (sentence-at-a-time) generation is a
      // real follow-up, not built here — don't report this as low-latency
      // streaming synthesis.
      const audio = await this.synthesizeWithPiper(text);
      const chunkSize = 4096;
      const totalChunks = Math.ceil(audio.length / chunkSize);

      for (let i = 0; i < totalChunks; i++) {
        const chunk = audio.subarray(i * chunkSize, (i + 1) * chunkSize);
        this.emit("audio-chunk", { chunkIndex: i, totalChunks });
        yield chunk;
      }

      console.log(`✅ Streaming synthesis complete (${totalChunks} chunks, chunked post-hoc — not incremental generation)`);
      this.emit("synthesis-complete", { text });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      console.error("❌ Streaming synthesis failed:", err);
      this.emit("error", { message: err });
      throw error;
    } finally {
      this.isSynthesizing = false;
    }
  }

  /**
   * Get synthesizer status
   */
  getStatus(): {
    isSynthesizing: boolean;
    voiceId: string;
    speakingRate: number;
    outputFormat: string;
  } {
    return {
      isSynthesizing: this.isSynthesizing,
      voiceId: this.voiceId,
      speakingRate: this.speakingRate,
      outputFormat: this.outputFormat,
    };
  }

  /**
   * Change voice
   */
  setVoice(voiceId: string) {
    if (this.isSynthesizing) {
      throw new Error("Cannot change voice while synthesizing");
    }
    this.voiceId = voiceId;
    console.log(`🎙️  Voice changed to ${voiceId}`);
  }

  /**
   * Change speaking rate
   */
  setSpeakingRate(rate: number) {
    if (this.isSynthesizing) {
      throw new Error("Cannot change speaking rate while synthesizing");
    }
    this.speakingRate = Math.max(0.5, Math.min(2.0, rate));
    console.log(`📊 Speaking rate changed to ${this.speakingRate}x`);
  }

  /**
   * Available voices
   */
  static getAvailableVoices(): string[] {
    return [
      "en_GB-alba-medium", // British accent
      "en_US-amy-medium", // American accent
      "en_US-libritts-high", // High quality American
      "en_US-glow-tts", // Natural sounding American
      "en_US-hfc-male", // Male voice
      "en_US-ljspeech-high", // Female voice
      "en_US-northern_english_male-glow-tts", // Northern English male
    ];
  }
}
