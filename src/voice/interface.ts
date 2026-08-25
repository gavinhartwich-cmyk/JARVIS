/**
 * Voice Interface
 * Main coordinator for voice I/O
 * Ties together STT, TTS, wake word, and location
 */

import { SpeechToText } from "./stt";
import { TextToSpeech } from "./tts";
import { WakeWordDetector, matchWakeWord } from "./wake-word";
import { LocationTracker } from "../location/tracker";
import { Orchestrator } from "../core/orchestrator";

export interface VoiceInterfaceConfig {
  zoApiKey: string;
  sttModel?: string;
  ttsVoice?: string;
  wakeWords?: string[];
  locationTracking?: boolean;
  autoPlay?: boolean; // automatically play TTS output
}

export class VoiceInterface {
  private stt: SpeechToText;
  private tts: TextToSpeech;
  private wakeWord: WakeWordDetector;
  private location: LocationTracker;
  private orchestrator: Orchestrator;
  private isListening: boolean = false;
  private config: VoiceInterfaceConfig;

  constructor(
    orchestrator: Orchestrator,
    config: VoiceInterfaceConfig
  ) {
    this.orchestrator = orchestrator;
    this.config = config;

    // Initialize modules
    this.stt = new SpeechToText(config.zoApiKey, {
      modelName: config.sttModel || "whisper-1",
      language: "en",
    });

    this.tts = new TextToSpeech({
      voice: config.ttsVoice || "en-us-libritts-high",
      speed: 1.0,
    });

    this.wakeWord = new WakeWordDetector({
      wakeWords: config.wakeWords || ["hey jarvis", "jarvis"],
      sensitivity: 0.7,
    });

    this.location = new LocationTracker(config.zoApiKey);

    // Set up wake word listener
    this.wakeWord.on((event) => {
      this.onWakeWord(event);
    });
  }

  /**
   * Start voice interface
   * Listen for wake word, then process voice commands
   */
  async start(): Promise<void> {
    console.log("\n🎤 Voice Interface Starting...");
    console.log("   Waiting for wake word: 'Hey JARVIS'");

    this.isListening = true;

    // Start location tracking if enabled
    if (this.config.locationTracking) {
      this.location.startTracking();
    }

    // Start wake word detection
    await this.wakeWord.startListening();
  }

  /**
   * Stop voice interface
   */
  async stop(): Promise<void> {
    console.log("\n🎤 Voice Interface Stopping...");

    this.isListening = false;
    this.wakeWord.stopListening();

    if (this.config.locationTracking) {
      this.location.stopTracking();
    }
  }

  /**
   * Called when wake word detected
   */
  private async onWakeWord(event: any): Promise<void> {
    console.log(`\n✨ Wake word detected: "${event.wakeWord}"`);
    console.log("   Listening for command...");

    try {
      // Listen for command (10 second timeout)
      const transcription = await this.listenForCommand(10000);

      if (!transcription || transcription.trim().length === 0) {
        console.log("   (No command received)");
        return;
      }

      console.log(`   Heard: "${transcription}"`);

      // Process command through orchestrator
      await this.processCommand(transcription);
    } catch (error) {
      console.error(
        `Voice command failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Listen for voice command
   */
  private async listenForCommand(timeoutMs: number): Promise<string> {
    // Placeholder: In production, this would:
    // 1. Open microphone stream
    // 2. Transcribe using STT
    // 3. Return transcript

    console.log("   [Listening... microphone input needed for real STT]");

    return "test command"; // For testing
  }

  /**
   * Process voice command through orchestrator
   */
  async processCommand(command: string): Promise<void> {
    try {
      console.log(`\n🧠 Processing: "${command}"`);

      // Enhance command with location context if available
      let enhancedCommand = command;
      if (this.config.locationTracking) {
        const roomContext = await this.location.getRoomContext();
        enhancedCommand = `${command}\n\nContext: ${roomContext}`;
      }

      // Run through orchestrator
      const result = await this.orchestrator.orchestrate(enhancedCommand);

      console.log(`\n✅ Result: ${result.finalResult}`);

      // Speak response
      await this.speak(result.finalResult);
    } catch (error) {
      const errorMsg = `Error: ${error instanceof Error ? error.message : String(error)}`;
      console.error(errorMsg);
      await this.speak(errorMsg);
    }
  }

  /**
   * Speak text response
   */
  async speak(text: string): Promise<void> {
    try {
      console.log(`\n🔊 Speaking...`);

      const result = await this.tts.synthesize(text);

      // Play audio if configured
      if (this.config.autoPlay) {
        await this.tts.play(result.audioPath);
      }

      // Clean up after playing
      setTimeout(() => {
        this.tts.cleanup(result.audioPath);
      }, result.duration * 1000 + 500);
    } catch (error) {
      console.error(
        `Speech synthesis failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Set voice for TTS
   */
  setVoice(voice: string): void {
    this.tts.setVoice(voice);
    console.log(`🎤 Voice set to: ${voice}`);
  }

  /**
   * Get available voices
   */
  getAvailableVoices(): string[] {
    return this.tts.getAvailableVoices();
  }

  /**
   * Add custom wake word
   */
  addWakeWord(word: string): void {
    this.wakeWord.addWakeWord(word);
    console.log(`👂 Added wake word: "${word}"`);
  }

  /**
   * Get current location context
   */
  async getLocationContext(): Promise<string> {
    return this.location.getRoomContext();
  }

  /**
   * Get orchestrator for testing
   */
  getOrchestrator(): Orchestrator {
    return this.orchestrator;
  }
}
