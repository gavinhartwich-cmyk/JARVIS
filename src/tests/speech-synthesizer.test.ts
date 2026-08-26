import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { SpeechSynthesizer } from "../phase2/speech-synthesizer";

/**
 * Proves Phase 2 text-to-speech is real, not the old mocked sine-wave
 * generator: runs the actual Piper binary and checks the returned audio
 * is a well-formed, non-silent WAV whose duration matches its own header.
 *
 * Requires the downloaded Piper binary + voice model from
 * scripts/setup-voice.sh (see PIPER_BINARY_PATH / PIPER_MODEL_PATH env
 * vars, defaulting to tools/piper/piper/piper and
 * models/piper/en_US-amy-medium.onnx). Skips instead of failing if those
 * aren't present, since a fresh clone won't have run that setup step yet.
 */

const binaryPath = process.env.PIPER_BINARY_PATH || "tools/piper/piper/piper";
const modelPath = process.env.PIPER_MODEL_PATH || "models/piper/en_US-amy-medium.onnx";
const piperAvailable = existsSync(binaryPath) && existsSync(modelPath);

describe.if(piperAvailable)("SpeechSynthesizer (real Piper)", () => {
  test("synthesize() returns a real, non-silent WAV buffer", async () => {
    const synth = new SpeechSynthesizer({
      voiceId: "en_US-amy-medium",
      speakingRate: 1.0,
      outputFormat: "wav",
      sampleRate: 22050,
    });

    const result = await synth.synthesize("This is a real test of the speech synthesizer.");

    // RIFF/WAVE header present
    expect(result.audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(result.audio.subarray(8, 12).toString("ascii")).toBe("WAVE");

    // Real speech, not an empty/near-empty buffer
    expect(result.audio.length).toBeGreaterThan(1000);

    // Duration parsed from the WAV header should be sane for this sentence
    expect(result.duration).toBeGreaterThan(500);
    expect(result.duration).toBeLessThan(15000);

    // Not silence: at least some samples should have meaningful amplitude
    const samples = new Int16Array(
      result.audio.buffer,
      result.audio.byteOffset + 44,
      (result.audio.length - 44) / 2,
    );
    const maxAbs = samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
    expect(maxAbs).toBeGreaterThan(1000); // silence would be ~0
  });

  test("rejects empty text before ever touching piper", async () => {
    const synth = new SpeechSynthesizer({
      voiceId: "en_US-amy-medium",
      speakingRate: 1.0,
      outputFormat: "wav",
      sampleRate: 22050,
    });
    await expect(synth.synthesize("")).rejects.toThrow("Text cannot be empty");
  });
});

if (!piperAvailable) {
  test.skip("SpeechSynthesizer (real Piper) — skipped: run scripts/setup-voice.sh first", () => {});
}
