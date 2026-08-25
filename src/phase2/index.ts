/**
 * JARVIS Phase 2 - Natural Voice Interface
 *
 * Complete voice interaction system with local technologies:
 * - Wake word detection (openWakeWord)
 * - Speech recognition (Whisper)
 * - Text-to-speech synthesis (Piper)
 * - Conversation context management
 * - Interruption support
 *
 * Pipeline: Microphone → Wake Word → STT → JARVIS Core → TTS → Speaker
 */

export {
  VoiceConfig,
  DEFAULT_VOICE_CONFIG,
  LOW_RESOURCE_VOICE_CONFIG,
  HIGH_QUALITY_VOICE_CONFIG,
} from "./voice-config";

export {
  WakeWordDetector,
  type WakeWordEvent,
  type WakeWordDetectorConfig,
} from "./wake-word-detector";

export {
  SpeechRecognizer,
  type RecognitionResult,
  type SpeechRecognizerConfig,
} from "./speech-recognizer";

export {
  SpeechSynthesizer,
  type SynthesisResult,
  type SynthesizerConfig,
} from "./speech-synthesizer";

export {
  VoiceInterface,
  type VoiceInteractionContext,
  type VoiceInteractionResult,
} from "./voice-interface";

/**
 * Phase 2 System Summary
 *
 * JARVIS Phase 2 adds natural voice interaction:
 *
 * 1. Wake Word Detection
 *    - Efficient local detection using openWakeWord
 *    - Customizable sensitivity
 *    - Low-power operation
 *
 * 2. Speech Recognition (STT)
 *    - Whisper for high-accuracy speech-to-text
 *    - Multiple model sizes (tiny to large)
 *    - Streaming and batch processing modes
 *    - Multi-language support
 *
 * 3. Text-to-Speech (TTS)
 *    - Piper for natural-sounding speech synthesis
 *    - Multiple voice options
 *    - Adjustable speaking rate
 *    - Streaming audio output
 *
 * 4. Conversation Management
 *    - Context window (remembers recent messages)
 *    - Message history tracking
 *    - Interruption support
 *    - Natural multi-turn conversations
 *
 * 5. Audio Pipeline
 *    - Microphone input (when hardware available)
 *    - Voice activity detection
 *    - Noise suppression
 *    - Streaming audio processing
 *
 * Privacy & Performance:
 *    ✓ All processing local (no cloud required)
 *    ✓ No audio uploaded to external services
 *    ✓ Efficient inference (works on modest hardware)
 *    ✓ Always-on listening (optional)
 *    ✓ Background operation support
 */
