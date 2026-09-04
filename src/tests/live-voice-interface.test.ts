import { describe, expect, test } from "bun:test";
import { pcmToWav, LiveVoiceInterface } from "../phase2/live-voice-interface";
import { DEFAULT_VOICE_CONFIG } from "../phase2/voice-config";

/**
 * No real mic/wake-word daemon/PowerShell playback/live Gemini connection
 * in these tests - covers what's verifiable without any of that: the WAV
 * encoding this file's own playback path depends on, and that
 * construction/status reporting is cheap and side-effect-free (matches
 * voice-interface-routing.test.ts's own convention for the same reason -
 * WakeWordDetector's constructor doesn't spawn anything until
 * startListening() is actually called).
 */
describe("pcmToWav", () => {
  test("produces a valid, parseable 16-bit mono WAV header", () => {
    const pcm = Buffer.from(new Int16Array([0, 1000, -1000, 32767, -32768]).buffer);
    const wav = pcmToWav(pcm, 24000);

    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM format tag
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.length).toBe(44 + pcm.length);
    // The actual PCM bytes survive unmodified, appended right after the header.
    expect(wav.subarray(44)).toEqual(pcm);
  });

  test("byte rate and block align are derived correctly for a non-default sample rate", () => {
    const wav = pcmToWav(Buffer.alloc(100), 16000);
    expect(wav.readUInt32LE(28)).toBe(16000 * 1 * 16 / 8); // byteRate
    expect(wav.readUInt16LE(32)).toBe((1 * 16) / 8); // blockAlign
  });
});

describe("LiveVoiceInterface", () => {
  test("constructs without side effects and reports an idle initial status", () => {
    const live = new LiveVoiceInterface(DEFAULT_VOICE_CONFIG);
    const status = live.getStatus();
    expect(status.isRunning).toBe(false);
    expect(status.isSending).toBe(false);
    expect(status.isPlaying).toBe(false);
    expect(status.sessionConnected).toBe(false);
  });

  test("processMicChunk() before start() is a safe no-op, not a throw", async () => {
    const live = new LiveVoiceInterface(DEFAULT_VOICE_CONFIG);
    await expect(live.processMicChunk(Buffer.alloc(100))).resolves.toBeUndefined();
  });

  test("stop() before start() is a safe no-op, not a throw", async () => {
    const live = new LiveVoiceInterface(DEFAULT_VOICE_CONFIG);
    await expect(live.stop()).resolves.toBeUndefined();
  });
});
