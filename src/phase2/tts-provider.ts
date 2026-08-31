/**
 * Phase 2: TTS Provider Selection
 *
 * Picks Fish Audio (Gavin's own custom "jarvis" voice) as the primary
 * speech synthesizer when configured, wrapped so it automatically falls
 * back to the local Piper synthesizer if Fish Audio errors - missing/bad
 * API key, network down, the API itself returning 401/402/503, etc. Same
 * $0-first / provider-agnostic resilience pattern this codebase already
 * applies to LLM providers (see model-provider.ts's fallback chain),
 * applied here so a Fish Audio hiccup makes JARVIS fall back to a local
 * voice instead of going completely silent. Added 2026-08-31.
 *
 * Real limitation, disclosed: this has not yet been run against a real
 * Fish Audio account/key end-to-end (that needs Gavin's real hardware) -
 * the fallback path is what protects a real run from a bad first attempt
 * (wrong reference_id, key typo, etc.) rather than losing the turn.
 */

import {
  SpeechSynthesizer,
  type ISpeechSynthesizer,
  type SynthesisResult,
} from "./speech-synthesizer";
import { FishAudioSynthesizer } from "./fish-audio-synthesizer";
import type { VoiceConfig } from "./voice-config";

class FallbackSpeechSynthesizer implements ISpeechSynthesizer {
  constructor(
    private primary: ISpeechSynthesizer,
    private fallback: ISpeechSynthesizer,
    private primaryName: string
  ) {}

  async synthesize(text: string): Promise<SynthesisResult> {
    try {
      return await this.primary.synthesize(text);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      console.error(
        `⚠️  ${this.primaryName} synthesis failed, falling back to local Piper voice: ${err}`
      );
      return await this.fallback.synthesize(text);
    }
  }

  getStatus() {
    return this.primary.getStatus();
  }

  setVoice(voiceId: string) {
    this.primary.setVoice(voiceId);
  }

  setSpeakingRate(rate: number) {
    this.primary.setSpeakingRate(rate);
    this.fallback.setSpeakingRate(rate);
  }
}

/**
 * Build whichever ISpeechSynthesizer the config asks for. Piper alone if
 * textToSpeech.provider isn't "fish-audio" (or fishAudio.referenceId is
 * missing); otherwise Fish Audio wrapped with an automatic Piper fallback.
 */
export function createSpeechSynthesizer(config: VoiceConfig): ISpeechSynthesizer {
  const tts = config.textToSpeech;
  const piper = new SpeechSynthesizer({
    voiceId: tts.voiceId,
    speakingRate: tts.speakingRate,
    outputFormat: tts.outputFormat,
    modelPath: tts.modelPath,
    sampleRate: config.audio.sampleRate,
  });

  if (tts.provider !== "fish-audio" || !tts.fishAudio?.referenceId) {
    return piper;
  }

  const fishAudio = new FishAudioSynthesizer({
    referenceId: tts.fishAudio.referenceId,
    speakingRate: tts.speakingRate,
    outputFormat: tts.outputFormat === "mp3" ? "mp3" : "wav",
    model: tts.fishAudio.model,
  });

  return new FallbackSpeechSynthesizer(fishAudio, piper, "Fish Audio");
}
