/**
 * Phase 2: Natural Voice Interface
 *
 * Complete voice interaction pipeline:
 * Microphone → Wake Word → Speech Recognition → JARVIS Core →
 * Response Generation → Text-to-Speech → Speaker
 */

import { WakeWordDetector, WakeWordEvent } from "./wake-word-detector";
import { SpeechRecognizer, RecognitionResult } from "./speech-recognizer";
import { SpeechSynthesizer, SynthesisResult } from "./speech-synthesizer";
import { VoiceConfig, DEFAULT_VOICE_CONFIG } from "./voice-config";

export interface VoiceInteractionContext {
  conversationId: string;
  messageHistory: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: Date;
  }>;
  lastWakeWordTime: Date;
  isActive: boolean;
}

export interface VoiceInteractionResult {
  userInput: string;
  jarvisResponse: string;
  audioOutput: Buffer;
  duration: number;
  timestamp: Date;
}

/**
 * Natural Voice Interface
 *
 * Orchestrates the complete voice interaction pipeline
 */
export class VoiceInterface {
  private config: VoiceConfig;
  private wakeWordDetector?: WakeWordDetector;
  private speechRecognizer?: SpeechRecognizer;
  private speechSynthesizer?: SpeechSynthesizer;

  private context: VoiceInteractionContext;
  private isRunning: boolean = false;

  // Event listeners
  private listeners: Map<string, Function[]> = new Map();

  constructor(config: VoiceConfig = DEFAULT_VOICE_CONFIG) {
    this.config = config;
    this.context = {
      conversationId: `conversation-${Date.now()}`,
      messageHistory: [],
      lastWakeWordTime: new Date(),
      isActive: false,
    };

    this.initializeListeners();
    this.initializeComponents();
  }

  /**
   * Initialize event listeners
   */
  private initializeListeners() {
    this.listeners.set("listening", []);
    this.listeners.set("wake-word-detected", []);
    this.listeners.set("user-speech-recognized", []);
    this.listeners.set("jarvis-responding", []);
    this.listeners.set("audio-ready", []);
    this.listeners.set("interaction-complete", []);
    this.listeners.set("error", []);
  }

  /**
   * Subscribe to voice interface events
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
   * Initialize voice components
   */
  private initializeComponents() {
    if (this.config.wakeWord.enabled) {
      this.wakeWordDetector = new WakeWordDetector({
        keyword: this.config.wakeWord.keyword,
        sensitivity: this.config.wakeWord.sensitivity,
        modelPath: this.config.wakeWord.modelPath,
        sampleRate: this.config.audio.sampleRate,
      });

      // Listen for wake word
      this.wakeWordDetector.on("wake-word-detected", (event: WakeWordEvent) => {
        this.handleWakeWord(event);
      });
    }

    if (this.config.speechRecognition.enabled) {
      this.speechRecognizer = new SpeechRecognizer({
        model: this.config.speechRecognition.model,
        language: this.config.speechRecognition.language,
        streaming: this.config.speechRecognition.streaming,
        responseFormat: this.config.speechRecognition.responseFormat,
        sampleRate: this.config.audio.sampleRate,
      });

      // Listen for recognition results
      this.speechRecognizer.on("final-result", (result: RecognitionResult) => {
        this.handleUserSpeech(result);
      });
    }

    if (this.config.textToSpeech.enabled) {
      this.speechSynthesizer = new SpeechSynthesizer({
        voiceId: this.config.textToSpeech.voiceId,
        speakingRate: this.config.textToSpeech.speakingRate,
        outputFormat: this.config.textToSpeech.outputFormat,
        modelPath: this.config.textToSpeech.modelPath,
        sampleRate: this.config.audio.sampleRate,
      });
    }
  }

  /**
   * Start voice interface
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    console.log("\n" + "=".repeat(70));
    console.log("🚀 JARVIS Voice Interface Starting");
    console.log("=".repeat(70));

    this.isRunning = true;

    if (this.wakeWordDetector) {
      console.log(`\n🎤 Waiting for wake word: "${this.config.wakeWord.keyword}"`);
      await this.wakeWordDetector.startListening();
    }

    this.emit("listening", { wake_word: this.config.wakeWord.keyword });
  }

  /**
   * Stop voice interface
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    console.log("\n🛑 Stopping Voice Interface");
    this.isRunning = false;
    this.context.isActive = false;

    if (this.wakeWordDetector) {
      await this.wakeWordDetector.stopListening();
    }

    if (this.speechRecognizer) {
      try {
        await this.speechRecognizer.stopStreaming();
      } catch {
        // Ignore error if not currently recognizing
      }
    }
  }

  /**
   * Handle wake word detection
   */
  private async handleWakeWord(event: WakeWordEvent) {
    console.log(`\n✨ Wake word detected! Starting conversation...`);

    this.context.isActive = true;
    this.context.lastWakeWordTime = new Date();
    this.emit("wake-word-detected", event);

    // Start listening for speech
    if (this.speechRecognizer) {
      await this.speechRecognizer.startStreaming();
    }
  }

  /**
   * Handle user speech recognition
   */
  private async handleUserSpeech(result: RecognitionResult) {
    console.log(`\n👤 User said: "${result.text}"`);

    this.context.messageHistory.push({
      role: "user",
      content: result.text,
      timestamp: new Date(),
    });

    this.emit("user-speech-recognized", result);

    // Generate JARVIS response
    // In real implementation, this would call the JARVIS Core
    const jarvisResponse = await this.generateResponse(result.text);

    // Add response to history
    this.context.messageHistory.push({
      role: "assistant",
      content: jarvisResponse,
      timestamp: new Date(),
    });

    // Synthesize speech response
    if (this.speechSynthesizer) {
      const audioResult = await this.speechSynthesizer.synthesize(jarvisResponse);

      this.emit("audio-ready", audioResult);
      console.log(`\n🔊 Response ready: ${audioResult.duration}ms`);
    }

    // Interaction complete
    this.context.isActive = false;
    this.emit("interaction-complete", {
      input: result.text,
      response: jarvisResponse,
    });

    // Resume listening for next wake word
    if (this.wakeWordDetector && this.isRunning) {
      await this.wakeWordDetector.startListening();
    }
  }

  /**
   * Generate JARVIS response
   *
   * This is where the JARVIS Core would be called
   * For now, returning simulated response
   */
  private async generateResponse(userInput: string): Promise<string> {
    this.emit("jarvis-responding", { input: userInput });

    // In real implementation:
    // 1. Pass to JARVIS Core
    // 2. Process through agent pipeline
    // 3. Generate response
    // 4. Return text response

    console.log(`\n🤖 JARVIS processing: "${userInput}"`);

    // Simulated processing delay
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const simulated_response = `I received your command: "${userInput}". In the real system, I would process this through the agent pipeline and provide a meaningful response.`;

    console.log(`🤖 JARVIS: "${simulated_response}"`);
    return simulated_response;
  }

  /**
   * Get interface status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      isActive: this.context.isActive,
      conversationId: this.context.conversationId,
      messageCount: this.context.messageHistory.length,
      config: {
        wakeWord: this.config.wakeWord.keyword,
        speechModel: this.config.speechRecognition.model,
        voice: this.config.textToSpeech.voiceId,
        streaming: this.config.speechRecognition.streaming,
      },
    };
  }

  /**
   * Get conversation context
   */
  getContext(): VoiceInteractionContext {
    return { ...this.context };
  }

  /**
   * Clear conversation history
   */
  clearHistory() {
    this.context.messageHistory = [];
    console.log("📝 Conversation history cleared");
  }

  /**
   * Set sensitivity for wake word
   */
  setWakeWordSensitivity(sensitivity: number) {
    if (this.wakeWordDetector) {
      this.wakeWordDetector.setSensitivity(sensitivity);
    }
  }

  /**
   * Change speaking rate
   */
  setSpeakingRate(rate: number) {
    if (this.speechSynthesizer) {
      this.speechSynthesizer.setSpeakingRate(rate);
    }
  }

  /**
   * Change voice
   */
  setVoice(voiceId: string) {
    if (this.speechSynthesizer) {
      this.speechSynthesizer.setVoice(voiceId);
    }
  }

  /**
   * Print pipeline info
   */
  static printPipeline() {
    console.log("\n🎙️  JARVIS Voice Interface Pipeline");
    console.log("=".repeat(70));
    console.log(`
Microphone
    ↓
🎯 Wake Word Detection (openWakeWord)
    "JARVIS"
    ↓
🎤 Speech Recognition (Whisper)
    Audio → Text
    ↓
💭 JARVIS Core
    Process & Respond
    ↓
🔤 Text-to-Speech (Piper)
    Text → Audio
    ↓
🔊 Speaker
    Play Response

Key Features:
  ✓ Natural conversation (not commands)
  ✓ Context awareness (remembers message history)
  ✓ Interruption detection
  ✓ Streaming audio (low latency)
  ✓ Local processing (privacy-first)
  ✓ Background operation (always listening)

Technologies:
  • Wake Word: openWakeWord
  • STT: Whisper (${DEFAULT_VOICE_CONFIG.speechRecognition.model} model)
  • TTS: Piper (${DEFAULT_VOICE_CONFIG.textToSpeech.voiceId})
`);
    console.log("=".repeat(70));
  }
}
