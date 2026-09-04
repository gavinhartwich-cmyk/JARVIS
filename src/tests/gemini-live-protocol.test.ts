import { describe, expect, test } from "bun:test";
import { buildAudioChunkMessage, decodeAudioPart, isAudioPart } from "../prototypes/gemini-live/protocol";
import type { InlineAudioPart, InlineTextPart } from "../prototypes/gemini-live/protocol";

describe("Gemini Live protocol helpers", () => {
  test("buildAudioChunkMessage base64-encodes raw PCM into the documented realtimeInput shape", () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 250, 251]);
    const message = buildAudioChunkMessage(pcm);

    expect("realtimeInput" in message).toBe(true);
    if ("realtimeInput" in message) {
      expect(message.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
      const decoded = Buffer.from(message.realtimeInput.audio.data, "base64");
      expect([...decoded]).toEqual([...pcm]);
    }
  });

  test("decodeAudioPart round-trips base64 PCM back to bytes and reads the sample rate from mimeType", () => {
    const original = new Uint8Array([10, 20, 30, 40]);
    const part: InlineAudioPart = {
      inlineData: { data: Buffer.from(original).toString("base64"), mimeType: "audio/pcm;rate=24000" },
    };

    const { pcm, sampleRateHz } = decodeAudioPart(part);
    expect([...pcm]).toEqual([...original]);
    expect(sampleRateHz).toBe(24000);
  });

  test("decodeAudioPart falls back to 24000Hz if the mimeType has no rate", () => {
    const part: InlineAudioPart = { inlineData: { data: "AAA=", mimeType: "audio/pcm" } };
    expect(decodeAudioPart(part).sampleRateHz).toBe(24000);
  });

  test("isAudioPart distinguishes inline audio from text parts", () => {
    const audio: InlineAudioPart = { inlineData: { data: "AAA=", mimeType: "audio/pcm;rate=24000" } };
    const text: InlineTextPart = { text: "hello" };
    expect(isAudioPart(audio)).toBe(true);
    expect(isAudioPart(text)).toBe(false);
  });
});
