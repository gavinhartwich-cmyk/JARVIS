import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SpeechSynthesizer } from "../phase2/speech-synthesizer";
import { WakeWordDetector, WakeWordEvent } from "../phase2/wake-word-detector";

/**
 * Proves Phase 2 wake word detection is real, not the old
 * Math.random()-based stub: synthesizes a real "hey jarvis" clip with
 * Piper, resamples it to the 16kHz openWakeWord requires (via ffmpeg),
 * and checks the actual pretrained hey_jarvis model fires the event —
 * while an unrelated sentence, run through the identical pipeline, does
 * not. Matches the manual verification already done on 2026-08-26
 * (positive ~0.999, negative ~0.00003 — see jarvis-phase-1-developer
 * memory, Phase 2 update).
 *
 * Requires scripts/setup-voice.sh's Piper output plus openwakeword
 * installed in the whisper venv (WAKEWORD_PYTHON_PATH / _SCRIPT_PATH env
 * vars, defaulting to tools/whisper/venv/bin/python and
 * scripts/wakeword_detect.py), and a system `ffmpeg` for resampling.
 * Skips instead of failing on a fresh clone that hasn't run setup yet.
 */

const piperAvailable =
  existsSync(process.env.PIPER_BINARY_PATH || "tools/piper/piper/piper") &&
  existsSync(process.env.PIPER_MODEL_PATH || "models/piper/en_US-amy-medium.onnx");
const wakewordAvailable = existsSync(process.env.WAKEWORD_PYTHON_PATH || "tools/whisper/venv/bin/python");
let ffmpegAvailable = true;
try {
  execSync("ffmpeg -version", { stdio: "ignore" });
} catch {
  ffmpegAvailable = false;
}
const allAvailable = piperAvailable && wakewordAvailable && ffmpegAvailable;

/** Piper's 22050Hz WAV -> raw 16kHz mono PCM16, via ffmpeg. */
function resampleTo16kPcm(wavPath: string): Buffer {
  const outPath = join(tmpdir(), `jarvis-wakeword-test-${randomUUID()}.wav`);
  execSync(`ffmpeg -y -loglevel error -i "${wavPath}" -ar 16000 -ac 1 -sample_fmt s16 "${outPath}"`);
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return readFileSync(outPath).subarray(44); // strip the WAV header
  } finally {
    try {
      unlinkSync(outPath);
    } catch {
      // best-effort cleanup
    }
  }
}

async function detectOnce(text: string): Promise<WakeWordEvent | null> {
  const synth = new SpeechSynthesizer({
    voiceId: "en_US-amy-medium",
    speakingRate: 1.0,
    outputFormat: "wav",
    sampleRate: 22050,
  });
  const synthResult = await synth.synthesize(text);

  const tempWav = join(tmpdir(), `jarvis-wakeword-src-${randomUUID()}.wav`);
  writeFileSync(tempWav, synthResult.audio);
  let pcm16k: Buffer;
  try {
    pcm16k = resampleTo16kPcm(tempWav);
  } finally {
    try {
      unlinkSync(tempWav);
    } catch {
      // best-effort cleanup
    }
  }

  const detector = new WakeWordDetector({
    keyword: "jarvis",
    sensitivity: 0.5,
    sampleRate: 16000,
  });

  const detected = new Promise<WakeWordEvent | null>((resolve) => {
    detector.on("wake-word-detected", (event: WakeWordEvent) => resolve(event));
  });

  await detector.startListening();
  await detector.processAudioChunk(pcm16k);
  await detector.stopListening();

  return Promise.race([detected, new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))]);
}

describe.if(allAvailable)("WakeWordDetector (real openWakeWord)", () => {
  test("detects the real 'hey jarvis' wake word in synthesized speech", async () => {
    const event = await detectOnce("hey jarvis, what's the weather like today");
    expect(event).not.toBeNull();
    expect(event!.keyword).toBe("jarvis");
    expect(event!.confidence).toBeGreaterThan(0.5);
    expect(event!.confidence).toBeLessThanOrEqual(1);
  }, 30000);

  test("does not fire on unrelated speech", async () => {
    const event = await detectOnce("the quick brown fox jumps over the lazy dog");
    expect(event).toBeNull();
  }, 30000);
});

if (!allAvailable) {
  test.skip("WakeWordDetector (real openWakeWord) — skipped: run scripts/setup-voice.sh first", () => {});
}
