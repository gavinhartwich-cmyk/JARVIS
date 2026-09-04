import { describe, expect, test } from "bun:test";
import { GeminiLiveSession } from "../prototypes/gemini-live/gemini-live-session";

/**
 * No live WebSocket connection in these tests (no GEMINI_API_KEY, no
 * network path to Google's endpoint in this sandbox) — covers what's
 * verifiable without one: the config/guard-rail behavior around
 * connecting, matching the "fail clearly, don't hang" convention the rest
 * of this codebase uses for unverified/hardware-gated code
 * (windows-control.ts, gemini-provider.ts).
 */
describe("GeminiLiveSession — connection guard rails (no live network)", () => {
  test("connect() rejects immediately with a clear message when no API key is configured", async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const session = new GeminiLiveSession({ apiKey: "" });
      await expect(session.connect()).rejects.toThrow(/GEMINI_API_KEY/);
    } finally {
      if (originalKey !== undefined) process.env.GEMINI_API_KEY = originalKey;
    }
  });

  test("sendText()/sendAudioChunk() before connect() fail clearly instead of hanging or silently dropping", () => {
    const session = new GeminiLiveSession({ apiKey: "fake-key-not-used" });
    expect(() => session.sendText("hi")).toThrow(/not connected/);
    expect(() => session.sendAudioChunk(new Uint8Array([1, 2, 3]))).toThrow(/not connected/);
  });

  test("currentSessionHandle starts as whatever resumeHandle was configured with", () => {
    const fresh = new GeminiLiveSession({ apiKey: "fake" });
    expect(fresh.currentSessionHandle).toBeUndefined();

    const resumed = new GeminiLiveSession({ apiKey: "fake", resumeHandle: "handle-123" });
    expect(resumed.currentSessionHandle).toBe("handle-123");
  });
});
