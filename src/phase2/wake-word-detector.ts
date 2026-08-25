/**
 * Phase 2: Wake Word Detection
 *
 * Detects when user says the wake word (e.g., "JARVIS")
 * Uses openWakeWord for efficient local detection
 */

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
  private modelPath?: string;
  private sampleRate: number;
  private audioBuffer: number[] = [];
  private isListening: boolean = false;

  // Event listeners
  private listeners: Map<string, Function[]> = new Map();

  constructor(config: WakeWordDetectorConfig) {
    this.keyword = config.keyword;
    this.sensitivity = config.sensitivity;
    this.modelPath = config.modelPath;
    this.sampleRate = config.sampleRate;

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
    this.audioBuffer = [];
    this.emit("listening-started");

    // Simulate listening (actual implementation would use microphone API)
    console.log("   Listening for wake word...");
  }

  /**
   * Stop listening for wake word
   */
  async stopListening(): Promise<void> {
    if (!this.isListening) return;

    console.log("🛑 Stopping wake word detection");
    this.isListening = false;
    this.audioBuffer = [];
    this.emit("listening-stopped");
  }

  /**
   * Process audio chunk (called from microphone stream)
   *
   * In real implementation, this would:
   * 1. Add audio to buffer
   * 2. Run through openWakeWord model
   * 3. Emit event if wake word detected
   */
  async processAudioChunk(audioChunk: Buffer): Promise<void> {
    if (!this.isListening) return;

    // Convert audio to number array for processing
    const pcm16Data = this.bufferToPCM16(audioChunk);
    this.audioBuffer.push(...pcm16Data);

    this.emit("audio-chunk", {
      size: pcm16Data.length,
      bufferSize: this.audioBuffer.length,
    });

    // In real implementation, check against model
    // For now, we'll check if buffer has enough data
    if (this.audioBuffer.length >= this.sampleRate) {
      await this.detectWakeWord();
    }
  }

  /**
   * Detect wake word in buffer
   *
   * This is where openWakeWord model would be called:
   * const confidence = await model.predict(this.audioBuffer)
   */
  private async detectWakeWord(): Promise<void> {
    // In real implementation:
    // - Load audio buffer into openWakeWord model
    // - Get confidence score
    // - If confidence > sensitivity threshold, emit event

    // Simulated detection
    const simulatedConfidence = Math.random();

    if (simulatedConfidence > this.sensitivity) {
      this.emitWakeWordDetected(simulatedConfidence);
    }

    // Keep only last second of audio to avoid buffer bloat
    const maxBufferSize = this.sampleRate;
    if (this.audioBuffer.length > maxBufferSize) {
      this.audioBuffer = this.audioBuffer.slice(-maxBufferSize);
    }
  }

  /**
   * Emit wake word detected event
   */
  private emitWakeWordDetected(confidence: number) {
    const event: WakeWordEvent = {
      keyword: this.keyword,
      confidence: Math.min(confidence, 1.0),
      timestamp: new Date(),
      audioChunk: Buffer.from(new Float32Array(this.audioBuffer)),
    };

    console.log(`🎯 Wake word detected: "${this.keyword}"`);
    console.log(`   Confidence: ${(event.confidence * 100).toFixed(1)}%`);

    this.emit("wake-word-detected", event);
  }

  /**
   * Convert buffer to PCM16 array
   */
  private bufferToPCM16(buffer: Buffer): number[] {
    const pcm16 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
    return Array.from(pcm16);
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
      bufferSize: this.audioBuffer.length,
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
