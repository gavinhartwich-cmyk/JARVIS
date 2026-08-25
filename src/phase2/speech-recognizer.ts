/**
 * Phase 2: Speech Recognition
 *
 * Converts speech to text using Whisper
 * Supports streaming and batch processing
 */

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
   */
  private async processStreamingChunk(chunk: Buffer): Promise<void> {
    // In real implementation:
    // - Convert chunk to the right format for Whisper
    // - Send to streaming endpoint
    // - Get partial result
    // - Emit partial-result event

    // Simulated partial result
    const simulatedPartialText = "I'm listening to your speech...";
    const partialResult: RecognitionResult = {
      text: simulatedPartialText,
      confidence: 0.85,
      language: this.language,
      isFinal: false,
      timestamp: new Date(),
      duration: (new Date().getTime() - this.startTime.getTime()),
    };

    this.emit("partial-result", partialResult);
  }

  /**
   * Recognize complete audio buffer
   *
   * This is the main recognition function that calls Whisper
   */
  private async recognizeAudio(audio: Buffer): Promise<RecognitionResult> {
    console.log("\n📝 Processing audio with Whisper...");
    console.log(`   Duration: ${(audio.length / (this.sampleRate * 2 / 1000)).toFixed(1)}s`);

    try {
      // In real implementation:
      // 1. Send audio to Whisper (via whisper.cpp, Python API, or remote)
      // 2. Parse response based on responseFormat
      // 3. Extract confidence if available
      // 4. Return structured result

      const duration = new Date().getTime() - this.startTime.getTime();

      // Simulated result
      const result: RecognitionResult = {
        text: "This would be the transcribed text from Whisper",
        confidence: 0.95,
        language: this.language,
        isFinal: true,
        alternatives: [
          "This would be alternative transcription one",
          "This would be alternative transcription two",
        ],
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
