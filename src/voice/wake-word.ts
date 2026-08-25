/**
 * Wake Word Detection Module
 * Detects "Hey JARVIS" or other custom wake words
 * Uses lightweight local detection (Porcupine or custom)
 */

export interface WakeWordConfig {
  wakeWords: string[];
  sensitivity?: number; // 0.0 to 1.0, higher = more sensitive
  audioThreshold?: number; // silence detection threshold
  cooldownMs?: number; // prevent rapid re-triggering
}

export interface WakeWordEvent {
  wakeWord: string;
  confidence: number;
  timestamp: Date;
}

export class WakeWordDetector {
  private config: WakeWordConfig;
  private lastTrigger: number = 0;
  private listeners: Array<(event: WakeWordEvent) => void> = [];

  constructor(config: Partial<WakeWordConfig> = {}) {
    this.config = {
      wakeWords: ["hey jarvis", "jarvis"],
      sensitivity: 0.7,
      audioThreshold: 0.1,
      cooldownMs: 1000,
      ...config,
    };
  }

  /**
   * Start listening for wake word
   * In production, this would continuously process audio
   */
  async startListening(): Promise<void> {
    console.log(
      `[WakeWord] Listening for: ${this.config.wakeWords.join(", ")}`
    );
    console.log(`[WakeWord] Sensitivity: ${(this.config.sensitivity! * 100).toFixed(0)}%`);

    // Placeholder: In production, this would:
    // 1. Open audio stream from microphone
    // 2. Process audio with Porcupine or similar
    // 3. Emit events when wake word detected

    console.log(
      "[WakeWord] Placeholder listening (needs microphone hardware to activate)"
    );
  }

  /**
   * Stop listening
   */
  stopListening(): void {
    console.log("[WakeWord] Stopped listening");
  }

  /**
   * Process audio chunk for wake word detection
   * Returns true if wake word detected
   */
  async processAudioChunk(
    audioBuffer: Buffer,
    sampleRate: number = 16000
  ): Promise<WakeWordEvent | null> {
    // Check cooldown to prevent rapid re-triggering
    const now = Date.now();
    if (now - this.lastTrigger < (this.config.cooldownMs || 1000)) {
      return null;
    }

    // Placeholder detection logic
    // In production, this would use Porcupine or similar
    // to match audio against wake word models

    // For now, simulate detection with low probability
    const confidence = Math.random() * 0.3; // mostly false positives prevented
    if (confidence > (this.config.sensitivity || 0.7)) {
      const event: WakeWordEvent = {
        wakeWord: "hey jarvis",
        confidence,
        timestamp: new Date(),
      };

      this.lastTrigger = now;
      this.emit(event);
      return event;
    }

    return null;
  }

  /**
   * Add listener for wake word events
   */
  on(callback: (event: WakeWordEvent) => void): void {
    this.listeners.push(callback);
  }

  /**
   * Remove listener
   */
  off(callback: (event: WakeWordEvent) => void): void {
    this.listeners = this.listeners.filter((l) => l !== callback);
  }

  /**
   * Emit wake word event
   */
  private emit(event: WakeWordEvent): void {
    console.log(
      `\n🔊 WAKE WORD DETECTED: "${event.wakeWord}" (${(event.confidence * 100).toFixed(0)}% confidence)`
    );
    this.listeners.forEach((callback) => callback(event));
  }

  /**
   * Add custom wake word
   */
  addWakeWord(word: string): void {
    if (!this.config.wakeWords.includes(word.toLowerCase())) {
      this.config.wakeWords.push(word.toLowerCase());
      console.log(`[WakeWord] Added wake word: "${word}"`);
    }
  }

  /**
   * Remove wake word
   */
  removeWakeWord(word: string): void {
    this.config.wakeWords = this.config.wakeWords.filter(
      (w) => w !== word.toLowerCase()
    );
    console.log(`[WakeWord] Removed wake word: "${word}"`);
  }

  /**
   * Get current wake words
   */
  getWakeWords(): string[] {
    return [...this.config.wakeWords];
  }

  /**
   * Set sensitivity (0.0 = very sensitive, 1.0 = not sensitive)
   */
  setSensitivity(sensitivity: number): void {
    if (sensitivity < 0 || sensitivity > 1) {
      throw new Error("Sensitivity must be between 0.0 and 1.0");
    }
    this.config.sensitivity = sensitivity;
    console.log(`[WakeWord] Sensitivity set to ${(sensitivity * 100).toFixed(0)}%`);
  }
}

/**
 * Standalone wake word matcher
 * Simple string matching for testing
 */
export function matchWakeWord(
  text: string,
  wakeWords: string[]
): { matched: boolean; word: string } {
  const normalizedText = text.toLowerCase().trim();

  for (const word of wakeWords) {
    if (
      normalizedText.includes(word.toLowerCase()) ||
      normalizedText.startsWith(word.toLowerCase())
    ) {
      return { matched: true, word };
    }
  }

  return { matched: false, word: "" };
}
