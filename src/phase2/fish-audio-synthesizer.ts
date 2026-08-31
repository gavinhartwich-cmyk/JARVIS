/**
 * Phase 2: Fish Audio Text-to-Speech
 *
 * Real HTTP TTS synthesis via the Fish Audio API (https://fish.audio),
 * using a specific voice model Gavin already has on his Fish Audio
 * account (reference_id below) instead of one of Piper's stock local
 * voices. Added 2026-08-31 per Gavin: "when the voice speaks i want to
 * connect it to fish audio i have a jarvis voice thats perfect for it."
 *
 * Auth: reads FISH_AUDIO_API_KEY from the environment. Gavin added the
 * real key to .env himself (his explicit choice - never asked him to
 * paste it in chat, never hardcoded here). If the key is missing or the
 * API call fails for any reason, synthesize() throws rather than
 * silently returning empty/fake audio - see tts-provider.ts, which
 * catches that and falls back to the local Piper synthesizer so JARVIS
 * doesn't just go silent on a Fish Audio outage or a bad/missing key.
 *
 * Endpoint/request shape confirmed against the real API docs
 * (https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)
 * on 2026-08-31: POST https://api.fish.audio/v1/tts, JSON body, response
 * is raw audio bytes (not JSON) in the requested format, streamed via
 * chunked transfer-encoding. Error responses (401/402/503) are JSON.
 */

import type { SynthesisResult, ISpeechSynthesizer } from "./speech-synthesizer";

export interface FishAudioSynthesizerConfig {
  referenceId: string; // Fish Audio voice model id (Gavin's "jarvis" voice)
  speakingRate: number; // mapped to Fish Audio's prosody.speed (0.5-2.0)
  outputFormat: "wav" | "mp3";
  apiKeyEnvVar?: string; // default FISH_AUDIO_API_KEY
  // Fish Audio model tier (s1 / s2-pro / s2.1-pro / s2.1-pro-free).
  // Left undefined by default so Fish Audio's own default (s2.1-pro as
  // of 2026-08-31) applies - only set this if Gavin wants a specific tier.
  model?: "s1" | "s2-pro" | "s2.1-pro" | "s2.1-pro-free";
}

/**
 * Real duration from a WAV header, same header-walk logic as
 * speech-synthesizer.ts's wavDurationMs - duplicated locally (not
 * imported) so this file has zero dependency on Piper. For mp3 output
 * there's no cheap header-based duration; returns 0 in that case (the
 * duration field is informational/logging only, playback doesn't use it).
 */
function wavDurationMs(audio: Buffer, format: string): number {
  if (format !== "wav" || audio.length < 44) return 0;
  try {
    const byteRate = audio.readUInt32LE(28);
    let offset = 12;
    while (offset + 8 <= audio.length) {
      const chunkId = audio.toString("ascii", offset, offset + 4);
      const chunkSize = audio.readUInt32LE(offset + 4);
      if (chunkId === "data") {
        return byteRate > 0 ? (chunkSize / byteRate) * 1000 : 0;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
  } catch {
    // Malformed/unexpected header - fall through to 0 rather than throw;
    // this is a logging nicety, not something worth failing synthesis over.
  }
  return 0;
}

export class FishAudioSynthesizer implements ISpeechSynthesizer {
  private referenceId: string;
  private speakingRate: number;
  private outputFormat: "wav" | "mp3";
  private apiKeyEnvVar: string;
  private model?: string;
  private isSynthesizing = false;

  constructor(config: FishAudioSynthesizerConfig) {
    this.referenceId = config.referenceId;
    this.speakingRate = config.speakingRate;
    this.outputFormat = config.outputFormat;
    this.apiKeyEnvVar = config.apiKeyEnvVar || "FISH_AUDIO_API_KEY";
    this.model = config.model;
  }

  async synthesize(text: string): Promise<SynthesisResult> {
    if (this.isSynthesizing) {
      throw new Error("Synthesis already in progress");
    }
    if (!text || text.trim().length === 0) {
      throw new Error("Text cannot be empty");
    }

    const apiKey = process.env[this.apiKeyEnvVar];
    if (!apiKey) {
      throw new Error(
        `${this.apiKeyEnvVar} is not set - add your real key to .env (get one from https://fish.audio) before Fish Audio TTS can run.`
      );
    }

    console.log("\n🐟 Starting Fish Audio text-to-speech synthesis");
    console.log(`   Text: "${text.substring(0, 100)}${text.length > 100 ? "..." : ""}"`);
    console.log(`   Voice (reference_id): ${this.referenceId}`);
    console.log(`   Speaking Rate: ${this.speakingRate}x`);

    this.isSynthesizing = true;
    const startTime = Date.now();

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      if (this.model) headers.model = this.model;

      const body: Record<string, unknown> = {
        text,
        reference_id: this.referenceId,
        format: this.outputFormat,
        prosody: { speed: this.speakingRate },
      };

      const response = await fetch("https://api.fish.audio/v1/tts", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        let detail = "";
        try {
          detail = await response.text();
        } catch {
          // best-effort only - the status code alone is still useful
        }
        throw new Error(
          `Fish Audio API returned ${response.status} ${response.statusText}: ${detail.substring(0, 300)}`
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      const audio = Buffer.from(arrayBuffer);
      if (audio.length === 0) {
        throw new Error("Fish Audio API returned an empty response body");
      }

      const audioDuration = wavDurationMs(audio, this.outputFormat);
      const wallTime = Date.now() - startTime;

      const result: SynthesisResult = {
        text,
        audio,
        duration: audioDuration,
        voiceId: this.referenceId,
        speakingRate: this.speakingRate,
        timestamp: new Date(),
      };

      console.log(
        `✅ Fish Audio synthesis complete: ${audio.length} bytes${
          audioDuration ? `, ${audioDuration.toFixed(0)}ms of audio` : ""
        } (${wallTime}ms wall time)`
      );
      return result;
    } finally {
      this.isSynthesizing = false;
    }
  }

  getStatus() {
    return {
      isSynthesizing: this.isSynthesizing,
      voiceId: this.referenceId,
      speakingRate: this.speakingRate,
      outputFormat: this.outputFormat,
    };
  }

  setVoice(referenceId: string) {
    if (this.isSynthesizing) {
      throw new Error("Cannot change voice while synthesizing");
    }
    this.referenceId = referenceId;
    console.log(`🐟 Fish Audio voice changed to reference_id ${referenceId}`);
  }

  setSpeakingRate(rate: number) {
    if (this.isSynthesizing) {
      throw new Error("Cannot change speaking rate while synthesizing");
    }
    this.speakingRate = Math.max(0.5, Math.min(2.0, rate));
    console.log(`📊 Fish Audio speaking rate changed to ${this.speakingRate}x`);
  }
}
