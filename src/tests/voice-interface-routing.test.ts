import { describe, expect, test } from "bun:test";
import { VoiceInterface } from "../phase2/voice-interface";
import { DEFAULT_VOICE_CONFIG } from "../phase2/voice-config";
import type { ModelProvider, ModelResponse } from "../models/types";

/**
 * Proves the Intent/Complexity Router (core/intent-router.ts) actually
 * changes what VoiceInterface does, not just what it logs:
 *   - a known action (TOOL) never reaches the model at all (section 8).
 *   - a DEEP-classified request is handed to the configured deep handler,
 *     also without touching the model directly.
 *   - a plain question (FAST) still goes through the single model call,
 *     unchanged from before the router existed.
 *
 * No mic/TTS/DB involved — DEFAULT_VOICE_CONFIG's wake word/STT/TTS
 * components get constructed (cheap — see phase2/voice-interface.ts) but
 * are never started, and executeKnownAction degrades gracefully without a
 * database (see its try/catch around identity resolution).
 */
describe("VoiceInterface — intent routing", () => {
  test("a known action (TOOL) never calls the model", async () => {
    let modelCalls = 0;
    const provider: ModelProvider = {
      name: "unreachable",
      async available() {
        return true;
      },
      async complete(): Promise<ModelResponse> {
        modelCalls++;
        throw new Error("model should not have been called for a TOOL request");
      },
      async *stream() {
        throw new Error("not used");
      },
    };

    const voice = new VoiceInterface(DEFAULT_VOICE_CONFIG, provider);
    const { response } = await voice.respondToText("Open Notepad");

    expect(modelCalls).toBe(0);
    // On this sandbox (no Windows/PowerShell, no DB) the action itself
    // will fail — that's fine and expected; what matters is it degrades to
    // a spoken string instead of throwing, and never touched the model.
    expect(typeof response).toBe("string");
    expect(response.length).toBeGreaterThan(0);
  });

  test("a DEEP-classified request is handed to the deep handler, not the model directly", async () => {
    let modelCalls = 0;
    let deepCalls = 0;
    const provider: ModelProvider = {
      name: "unreachable",
      async available() {
        return true;
      },
      async complete(): Promise<ModelResponse> {
        modelCalls++;
        throw new Error("model should not have been called directly for a DEEP request");
      },
      async *stream() {
        throw new Error("not used");
      },
    };

    const voice = new VoiceInterface(DEFAULT_VOICE_CONFIG, provider, async (utterance) => {
      deepCalls++;
      return `deep answer to: ${utterance}`;
    });

    const { response } = await voice.respondToText(
      "Can you research this thoroughly and write a report on it?"
    );

    expect(modelCalls).toBe(0);
    expect(deepCalls).toBe(1);
    expect(response).toContain("deep answer to:");
  });

  test("a DEEP request with no deep handler configured falls back to a direct model call", async () => {
    let modelCalls = 0;
    const provider: ModelProvider = {
      name: "fake",
      async available() {
        return true;
      },
      async complete(): Promise<ModelResponse> {
        modelCalls++;
        return { content: "fallback reply", tokensUsed: 1, provider: "fake", model: "fake" };
      },
      async *stream() {
        throw new Error("not used");
      },
    };

    const voice = new VoiceInterface(DEFAULT_VOICE_CONFIG, provider); // no deep handler
    const { response } = await voice.respondToText(
      "Can you research this thoroughly and write a report on it?"
    );

    expect(modelCalls).toBe(1);
    expect(response).toBe("fallback reply");
  });

  test("a plain question (FAST) still goes through a direct model call, unchanged", async () => {
    let modelCalls = 0;
    const provider: ModelProvider = {
      name: "fake",
      async available() {
        return true;
      },
      async complete(): Promise<ModelResponse> {
        modelCalls++;
        return { content: "Paris.", tokensUsed: 1, provider: "fake", model: "fake" };
      },
      async *stream() {
        throw new Error("not used");
      },
    };

    const voice = new VoiceInterface(DEFAULT_VOICE_CONFIG, provider);
    const { response } = await voice.respondToText("What's the capital of France?");

    expect(modelCalls).toBe(1);
    expect(response).toBe("Paris.");
  });
});
