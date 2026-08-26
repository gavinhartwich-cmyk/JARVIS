import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { SpeechRecognizer } from "../phase2/speech-recognizer";
import { SpeechSynthesizer } from "../phase2/speech-synthesizer";

/**
 * Proves Phase 2 speech-to-text is real, not the old hardcoded
 * "This would be the transcribed text from Whisper" stub: synthesizes a
 * real sentence with Piper, feeds the raw PCM into SpeechRecognizer, and
 * checks the real faster-whisper model actually transcribed it back
 * correctly (full TTS -> STT round trip, matching the manual verification
 * already done via mcp__zo__transcribe_audio on 2026-08-26).
 *
 * Requires both scripts/setup-voice.sh outputs (Piper binary/model +
 * the faster-whisper venv). Skips instead of failing on a fresh clone.
 */

const piperAvailable =
  existsSync(process.env.PIPER_BINARY_PATH || "tools/piper/piper/piper") &&
  existsSync(process.env.PIPER_MODEL_PATH || "models/piper/en_US-amy-medium.onnx");
const whisperAvailable = existsSync(process.env.WHISPER_PYTHON_PATH || "tools/whisper/venv/bin/python");
const bothAvailable = piperAvailable && whisperAvailable;

describe.if(bothAvailable)("SpeechRecognizer (real faster-whisper)", () => {
  test("recognize() correctly transcribes real Piper-synthesized audio", async () => {
    const synth = new SpeechSynthesizer({
      voiceId: "en_US-amy-medium",
      speakingRate: 1.0,
      outputFormat: "wav",
      sampleRate: 22050,
    });
    const spoken = "The quick brown fox jumps over the lazy dog.";
    const synthResult = await synth.synthesize(spoken);

    // Strip the 44-byte WAV header piper produced -> raw PCM, matching
    // what SpeechRecognizer expects from a microphone stream.
    const pcm = synthResult.audio.subarray(44);

    const recognizer = new SpeechRecognizer({
      model: "tiny",
      language: "en",
      streaming: false,
      responseFormat: "text",
      sampleRate: 22050,
    });

    const result = await recognizer.recognize(pcm);

    expect(result.isFinal).toBe(true);
    expect(result.text.toLowerCase()).toContain("quick brown fox");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  }, 30000);
});

if (!bothAvailable) {
  test.skip("SpeechRecognizer (real faster-whisper) — skipped: run scripts/setup-voice.sh first", () => {});
}
