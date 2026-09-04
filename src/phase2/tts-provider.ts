/**
 * Phase 2: TTS Provider Selection
 *
 * Picks whichever real TTS backend textToSpeech.provider asks for -
 * "fish-audio" (Gavin's paid Fish Audio voice) or "chatterbox" (local,
 * $0, voice cloning via Resemble AI's Chatterbox) - wrapped so it
 * automatically falls back to the local Piper synthesizer if the primary
 * one errors: missing/bad key, network down, a real API error (Fish
 * Audio's 401/402/503), a missing Chatterbox venv/reference clip, etc.
 * Same $0-first / provider-agnostic resilience pattern this codebase
 * already applies to LLM providers (see model-provider.ts's fallback
 * chain), applied here so a primary-provider hiccup makes JARVIS fall
 * back to a local voice instead of going completely silent. Added
 * 2026-08-31 (Fish Audio), extended same day (Chatterbox) after Fish
 * Audio hit a real, confirmed 402 Payment Required live.
 */

import {
  SpeechSynthesizer,
  type ISpeechSynthesizer,
  type SynthesisResult,
} from "./speech-synthesizer";
import { FishAudioSynthesizer } from "./fish-audio-synthesizer";
import { ChatterboxSynthesizer } from "./chatterbox-synthesizer";
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

  shutdown() {
    this.primary.shutdown?.();
    this.fallback.shutdown?.();
  }

  // [ADDED 2026-09-02] Real bug found and fixed live: this class never
  // forwarded warmUp() at all - shutdown() (right above) WAS correctly
  // forwarded when it was added, but warmUp() (added later, same
  // session) was missed. Since voice-interface.ts calls it as
  // `this.speechSynthesizer?.warmUp?.()` (optional chaining, by design,
  // so a synthesizer with no real warm-up cost - Piper/Fish Audio - is a
  // silent no-op), a MISSING method here looked byte-for-byte identical
  // to "nothing needs warming up": no error, no log, nothing - the fix
  // silently never engaged. Confirmed live: Gavin's real Chatterbox
  // session paid the full ~65-93s cold-start cost mid-reply again, with
  // zero trace of a warm-up attempt anywhere in the log. Only the
  // primary needs warming (the fallback, Piper, has no real persistent-
  // process cold-start cost worth front-loading).
  async warmUp(): Promise<void> {
    await this.primary.warmUp?.();
  }
}

/**
 * Build whichever ISpeechSynthesizer the config asks for:
 * - "chatterbox" with a real referenceClipPath configured (or
 *   CHATTERBOX_VOICE_CLIP_PATH set) -> Chatterbox wrapped with a Piper
 *   fallback.
 * - "fish-audio" with a real fishAudio.referenceId configured -> Fish
 *   Audio wrapped with a Piper fallback.
 * - anything else (including "chatterbox"/"fish-audio" configured but
 *   missing the piece they need) -> plain Piper, with a console warning
 *   in the misconfigured case so it's obvious why the "primary" voice
 *   never actually engages.
 */
/**
 * [ADDED 2026-09-02] A standalone, always-Piper synthesizer - real, live
 * finding: voice-interface.ts's "thinking" filler acknowledgment
 * ("Mm-hm, one moment.") was reusing the SAME synthesizer instance as the
 * real reply, meaning whenever the configured provider is Chatterbox, the
 * filler - whose entire purpose is to fill dead air quickly while the
 * real (slow) reply generates - was itself paying Chatterbox's real
 * multi-second-to-tens-of-seconds latency on its first use per session,
 * defeating the point. The filler's job is speed, not voice-clone
 * fidelity, so it always gets a plain, fast, local Piper instance
 * regardless of what textToSpeech.provider is configured to. Factored out
 * of createSpeechSynthesizer() below so both share one real construction
 * path, not two that could drift.
 */
export function createPiperSynthesizer(config: VoiceConfig): ISpeechSynthesizer {
  const tts = config.textToSpeech;
  return new SpeechSynthesizer({
    voiceId: tts.voiceId,
    speakingRate: tts.speakingRate,
    outputFormat: tts.outputFormat,
    modelPath: tts.modelPath,
    sampleRate: config.audio.sampleRate,
  });
}

export function createSpeechSynthesizer(config: VoiceConfig): ISpeechSynthesizer {
  const tts = config.textToSpeech;
  const piper = createPiperSynthesizer(config);

  if (tts.provider === "chatterbox") {
    const referenceClipPath = tts.chatterbox?.referenceClipPath || process.env.CHATTERBOX_VOICE_CLIP_PATH;
    if (referenceClipPath) {
      const chatterbox = new ChatterboxSynthesizer({
        referenceClipPath,
        speakingRate: tts.speakingRate,
        outputFormat: "wav",
        device: tts.chatterbox?.device,
      });
      return new FallbackSpeechSynthesizer(chatterbox, piper, "Chatterbox");
    }
    console.error(
      '⚠️  textToSpeech.provider is "chatterbox" but no reference clip is configured ' +
        "(set textToSpeech.chatterbox.referenceClipPath or the CHATTERBOX_VOICE_CLIP_PATH env var) - using Piper only."
    );
    return piper;
  }

  if (tts.provider === "fish-audio" && tts.fishAudio?.referenceId) {
    const fishAudio = new FishAudioSynthesizer({
      referenceId: tts.fishAudio.referenceId,
      speakingRate: tts.speakingRate,
      outputFormat: tts.outputFormat === "mp3" ? "mp3" : "wav",
      model: tts.fishAudio.model,
    });
    return new FallbackSpeechSynthesizer(fishAudio, piper, "Fish Audio");
  }

  return piper;
}