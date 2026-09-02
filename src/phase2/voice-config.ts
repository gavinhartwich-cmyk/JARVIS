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

  // Text-to-speech (Piper locally, or Fish Audio - see provider below)
  textToSpeech: {
    enabled: boolean;
    voiceId: string; // Piper voice to use (and the fallback voice if provider is "fish-audio")
    speakingRate: number; // 1.0 = normal, <1 slower, >1 faster
    outputFormat: "wav" | "mp3"; // Audio format
    modelPath?: string; // Path to Piper model
    // Which TTS backend actually speaks. Added 2026-08-31 alongside the
    // Fish Audio integration - see src/phase2/tts-provider.ts. Undefined/
    // "piper" = local Piper only (original behavior, unchanged). "fish-audio"
    // = Gavin's real Fish Audio voice via fishAudio below, wrapped with an
    // automatic fallback to Piper if the Fish Audio call fails for any
    // reason (missing/bad key, network down, API outage).
    provider?: "piper" | "fish-audio" | "chatterbox";
    fishAudio?: {
      // Fish Audio voice model id - a specific voice on Gavin's own Fish
      // Audio account, not a stock/public voice name. Given directly by
      // Gavin 2026-08-31.
      referenceId: string;
      // Fish Audio model tier (s1 / s2-pro / s2.1-pro / s2.1-pro-free).
      // Left unset by default so Fish Audio's own default applies.
      model?: "s1" | "s2-pro" | "s2.1-pro" | "s2.1-pro-free";
    };
    // Local, $0 voice cloning via Resemble AI's open-source Chatterbox
    // model (see src/phase2/chatterbox-synthesizer.ts) - added 2026-08-31
    // after Fish Audio hit a real 402 Payment Required. Requires
    // scripts/setup-chatterbox.ps1 run once AND a real reference clip.
    chatterbox?: {
      // Path to a real ~10s reference audio clip of the voice to clone
      // (clean single speaker, minimal background noise). Empty until
      // Gavin has one - see tts-provider.ts, which falls back to Piper
      // rather than trying to launch Chatterbox with no clip.
      referenceClipPath: string;
      device?: "cuda" | "cpu" | "mps"; // default "cuda" - Gavin confirmed he has an NVIDIA GPU, 2026-08-31
    };
  };

  // Audio processing
  audio: {
    sampleRate: number; // Typically 16000 Hz
    channels: number; // 1 for mono, 2 for stereo
    bitDepth: number; // 16 for 16-bit
    vadEnabled: boolean; // Voice activity detection
    noiseSuppressionEnabled: boolean;
    // Case-insensitive substring match against the real input device
    // list (e.g. "C920" for an HD Pro Webcam C920) - see
    // mic_capture.py/mic-capture.ts. Empty/undefined = whatever the OS
    // currently calls the default input device, which is a real ambiguity
    // on any machine with more than one microphone, not a safe default.
    inputDeviceName?: string;
    // Linear gain multiplier applied to raw mic samples in mic_capture.py
    // before anything downstream ever sees them - added 2026-08-30 after
    // Gavin's real wake-word scores at normal talking volume through the
    // C920 topped out at 0.0175 (see wakeWord.sensitivity comment below
    // for the full data). A real, unvalidated hypothesis, not a proven
    // fix: 4.0 is a starting point, not a measured-correct value - watch
    // the "[mic] peak level" log line mic_capture.py now prints once/sec
    // (raw vs. post-gain, and whether post-gain is clipping) to tell
    // whether this needs to go higher, lower, or whether the real fix is
    // elsewhere (e.g. Windows mic boost/OS input volume).
    micGain?: number;
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
    // of "Jarvis" to trigger it, not just "hey Jarvis". Originally
    // measured against real Piper-synthesized clips (2026-08-26):
    // unrelated speech scores ~0.0001-0.0003 (noise floor); bare "jarvis"
    // utterances scored 0.25-0.99 depending on sentence position/cadence,
    // with one deeply-embedded mid-sentence case ("...if jarvis
    // knows...") scoring only 0.003. That data set 0.15 as the threshold.
    //
    // [UPDATE 2026-08-30] Real live data from Gavin's actual mic/room
    // told a very different story: with the wake-word score logging
    // added this session, 12 real samples while he talked at normal
    // volume through the C920 - genuinely trying the wake word, not
    // silence - ranged only 0.0000-0.0175. That's below even the OLD
    // noise floor for synthesized clips, and ~15-50x below where a real
    // "jarvis" utterance scored on 2026-08-26. Per Gavin: "the
    // sensitivity needs to be turned up clearly because I want it to
    // hear me at normal talking volume." Two changes together, not
    // threshold alone: (1) audio.micGain (see above) now boosts the raw
    // signal 4x before it ever reaches this model, since a gap this
    // large points at input level, not just trigger point; (2) this
    // threshold is lowered to 0.05 as a safety margin on top of that -
    // still ~15-75x above the observed real non-speech floor
    // (0.0000-0.0034) even before the gain fix helps separate signal
    // from noise further. Disclosed uncertainty: a threshold this far
    // below the original synthesized-clip data is unusual, and the two
    // fixes together are a real hypothesis grounded in Gavin's actual
    // numbers, not a proven fix yet - watch the wake-word score log
    // (still printed every cycle) and the new mic_capture.py peak-level
    // log after this change; if scores still don't clear 0.05 at normal
    // volume, that means the gain isn't enough yet (raise audio.micGain
    // or MIC_GAIN) rather than lowering this further into the noise
    // floor, which would just trade missed wake-ups for false triggers.
    sensitivity: 0.05,
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
    // set voiceId to match the filename. This voiceId/Piper path is now
    // the automatic FALLBACK voice (see provider below), not the primary
    // one, so it's kept real and working rather than removed.
    voiceId: "en_US-amy-medium",
    speakingRate: 1.0,
    outputFormat: "wav",
    // [UPDATE 2026-08-31] Per Gavin: "when the voice speaks i want to
    // connect it to fish audio i have a jarvis voice thats perfect for
    // it." Wired up Fish Audio as primary (reference_id below, given
    // directly by Gavin) with automatic fallback to the Piper voice
    // above - see src/phase2/tts-provider.ts. Confirmed LIVE (not
    // hypothetical): every real call returned "402 Payment Required -
    // Insufficient API credit" - the account needs funding Fish Audio
    // isn't free per-call the way Piper/Chatterbox are.
    //
    // [UPDATE 2026-08-31, second pass] Per Gavin, moving to Chatterbox
    // (local, $0, voice cloning - see src/phase2/chatterbox-synthesizer.ts)
    // instead of funding Fish Audio, to stay $0-first. He confirmed an
    // NVIDIA GPU but hadn't picked/recorded a reference clip yet, so
    // provider is temporarily back to plain "piper" - there's no reason
    // to keep dialing a provider that's confirmed to 402 on every call
    // (extra failed network round-trip + log noise for no benefit, the
    // fallback always lands on Piper anyway). fishAudio config is left
    // in place, not deleted, in case Gavin ever funds that account
    // instead. Once Gavin has a real reference clip: set provider to
    // "chatterbox", fill in chatterbox.referenceClipPath (or the
    // CHATTERBOX_VOICE_CLIP_PATH env var), and run
    // scripts/setup-chatterbox.ps1 first if that venv doesn't exist yet.
    // [UPDATE 2026-08-31, third pass] Gavin provided a real reference
    // clip (originally a .webm, converted to a proper WAV via ffmpeg -
    // see scripts/setup-chatterbox.ps1's printed instructions, since
    // Chatterbox's audio loader isn't documented to reliably handle
    // .webm) and confirmed an NVIDIA GPU.
    //
    // [UPDATE 2026-09-02] Flipped back to "piper" as the default. Real,
    // live-measured reason, not a guess: after fixing Chatterbox's real
    // redundant-conditioning bug (13-45s -> 1.4-2.4s in a clean isolated
    // test - a genuine, verified fix, see chatterbox_synthesize_daemon.py's
    // own comment), a second live `listen` session still saw real,
    // highly variable per-request latency (12-54s), even after ruling
    // out an actual confound found along the way (orphaned duplicate
    // daemon processes from this session's own testing, competing for
    // the same 4GB GPU). With those cleaned up, GPU telemetry showed no
    // thermal throttling (35°C) but a mid power-state (P2, not P0/full
    // boost) - the GPU isn't ramping to full clock for this kind of
    // bursty, single-request autoregressive workload, which is a real,
    // largely hardware-bound characteristic of a 350M-parameter model on
    // a 4GB card, not something more code changes can reliably fix
    // without real risk (a first attempt at deeper profiling already
    // introduced a subtle bug once this session - see the daemon's own
    // comment on that). Per Gavin, delay/thinking time is "the biggest
    // issue" - Chatterbox stays fully implemented and one line away
    // (flip this back to "chatterbox") for whenever the cloned voice
    // matters more than speed; tts-provider.ts's fallback wrapper means
    // switching back doesn't need any other code change.
    provider: "piper",
    fishAudio: {
      referenceId: "049975dde0a14889ad219f24a95e3a4f",
    },
    chatterbox: {
      referenceClipPath: "",
    },
  },
  audio: {
    sampleRate: 16000,
    channels: 1,
    bitDepth: 16,
    vadEnabled: true,
    noiseSuppressionEnabled: true,
    // Per Gavin (2026-08-30): "I want it to be from the HD Pro Webcam
    // C920" - explicit, not a guess. "C920" alone (not the full product
    // name) because Windows/driver naming for this exact device varies
    // ("Microphone (HD Pro Webcam C920)", "HD Pro Webcam C920", etc.) and
    // mic_capture.py does a substring match, so the short, stable part of
    // the name is the safer match target. Override with the
    // MIC_DEVICE_NAME env var if this ever needs to change without a
    // code edit.
    inputDeviceName: "C920",
    // 2026-08-30, real evidence (see wakeWord.sensitivity comment below
    // for the full log): Gavin's real wake-word scores at normal talking
    // volume never got above 0.0175, versus 0.25-0.99 measured on
    // 2026-08-26 for actual "jarvis" utterances - a gap way too large to
    // just be threshold tuning, so this boosts the raw signal itself
    // rather than only lowering the trigger point to chase a suppressed
    // one. 4.0 is a first real attempt, not a validated value - override
    // with MIC_GAIN if it needs adjusting before another code change.
    micGain: 4.0,
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
