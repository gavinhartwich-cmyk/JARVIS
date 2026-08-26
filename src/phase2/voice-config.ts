/**
 * Phase 2: Voice Configuration
 *
 * Settings and configuration for the natural voice interface
 */

export interface VoiceConfig {
  // Wake word detection
  wakeWord: {
    enabled: boolean;
    keyword: string; // "jarvis" or custom keyword
    sensitivity: number; // 0-1, higher = more sensitive
    modelPath?: string; // Path to openWakeWord model
  };

  // Speech recognition (Whisper)
  speechRecognition: {
    enabled: boolean;
    model: "tiny" | "base" | "small" | "medium" | "large"; // Whisper model size
    language: string; // "en" for English
    streaming: boolean; // Enable streaming STT
    responseFormat: "text" | "json" | "verbose_json";
  };

  // Text-to-speech (Piper)
  textToSpeech: {
    enabled: boolean;
    voiceId: string; // Voice to use
    speakingRate: number; // 1.0 = normal, <1 slower, >1 faster
    outputFormat: "wav" | "mp3"; // Audio format
    modelPath?: string; // Path to Piper model
  };

  // Audio processing
  audio: {
    sampleRate: number; // Typically 16000 Hz
    channels: number; // 1 for mono, 2 for stereo
    bitDepth: number; // 16 for 16-bit
    vadEnabled: boolean; // Voice activity detection
    noiseSuppressionEnabled: boolean;
  };

  // Conversation settings
  conversation: {
    contextWindowSize: number; // How many messages to remember
    maxTurnDuration: number; // Max seconds per turn
    allowInterruption: boolean;
    interruptionThreshold: number; // 0-1, sensitivity for detecting user trying to interrupt
    responseStreaming: boolean; // Stream response as it's generated
  };

  // Background operation
  backgroundOperation: {
    enabled: boolean;
    autoStartOnBoot: boolean;
    lowPowerMode: boolean; // Reduce resource usage
    batteryOptimization: boolean; // For mobile/laptop battery
  };
}

/**
 * Default configuration (English, high quality)
 */
export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  wakeWord: {
    enabled: true,
    keyword: "jarvis",
    // The underlying model (openWakeWord's "hey_jarvis") was trained on the
    // phrase "hey jarvis", not bare "jarvis" — but Gavin wants any mention
    // of "Jarvis" to trigger it, not just "hey Jarvis". Measured against
    // real Piper-synthesized clips (2026-08-26): unrelated speech scores
    // ~0.0001-0.0003 (noise floor); bare "jarvis" utterances scored
    // 0.25-0.99 depending on sentence position/cadence, with one
    // deeply-embedded mid-sentence case ("...if jarvis knows...") scoring
    // only 0.003. 0.15 sits ~50x above the noise floor (safe from false
    // triggers) while catching every measured "jarvis" case except that
    // one low-cadence outlier — see wake-word-detector.ts header comment
    // and jarvis-phase-1-developer memory for the full data. This is a
    // real accuracy tradeoff, not a guarantee: catching that remaining
    // case reliably would need training a dedicated "jarvis" model
    // (openWakeWord supports this, but it's a much bigger task — large
    // negative dataset + synthetic positive generation), not just a
    // threshold change.
    sensitivity: 0.15,
  },
  speechRecognition: {
    enabled: true,
    model: "base", // Good balance of speed/accuracy
    language: "en",
    streaming: true,
    responseFormat: "text",
  },
  textToSpeech: {
    enabled: true,
    // en_GB-alba-medium (British accent) was the aspirational original
    // default, but that voice model was never actually downloaded — until
    // 2026-08-26, voiceId was purely cosmetic (see speech-synthesizer.ts's
    // resolvePiperPaths) and every synthesis silently used en_US-amy-medium
    // regardless of this value. Now that voiceId really does select the
    // model, defaulting to the one actually downloaded and tested. To use
    // a different Piper voice, download its .onnx/.onnx.json into
    // models/piper/ (see https://huggingface.co/rhasspy/piper-voices) and
    // set voiceId to match the filename.
    voiceId: "en_US-amy-medium",
    speakingRate: 1.0,
    outputFormat: "wav",
  },
  audio: {
    sampleRate: 16000,
    channels: 1,
    bitDepth: 16,
    vadEnabled: true,
    noiseSuppressionEnabled: true,
  },
  conversation: {
    contextWindowSize: 10, // Remember last 10 messages
    maxTurnDuration: 300, // 5 minutes max per turn
    allowInterruption: true,
    interruptionThreshold: 0.7,
    responseStreaming: true,
  },
  backgroundOperation: {
    enabled: true,
    autoStartOnBoot: true,
    lowPowerMode: false,
    batteryOptimization: false,
  },
};

/**
 * Low-resource configuration (for laptop/mobile)
 */
export const LOW_RESOURCE_VOICE_CONFIG: VoiceConfig = {
  ...DEFAULT_VOICE_CONFIG,
  speechRecognition: {
    ...DEFAULT_VOICE_CONFIG.speechRecognition,
    model: "tiny", // Smallest model
    streaming: false, // Non-streaming for lower resource usage
  },
  textToSpeech: {
    ...DEFAULT_VOICE_CONFIG.textToSpeech,
    speakingRate: 1.2, // Slightly faster
  },
  backgroundOperation: {
    ...DEFAULT_VOICE_CONFIG.backgroundOperation,
    lowPowerMode: true,
    batteryOptimization: true,
  },
};

/**
 * High-quality configuration (for desktop)
 */
export const HIGH_QUALITY_VOICE_CONFIG: VoiceConfig = {
  ...DEFAULT_VOICE_CONFIG,
  speechRecognition: {
    ...DEFAULT_VOICE_CONFIG.speechRecognition,
    model: "large", // Best accuracy
    responseFormat: "verbose_json", // More details
  },
  wakeWord: {
    ...DEFAULT_VOICE_CONFIG.wakeWord,
    sensitivity: 0.7, // Higher sensitivity
  },
  conversation: {
    ...DEFAULT_VOICE_CONFIG.conversation,
    contextWindowSize: 20, // Remember more messages
    maxTurnDuration: 600, // 10 minutes
  },
};
