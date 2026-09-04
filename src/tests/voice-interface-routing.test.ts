import { describe, expect, test } from "bun:test";
import { VoiceInterface } from "../phase2/voice-interface";
import { DEFAULT_VOICE_CONFIG } from "../phase2/voice-config";
import type { ModelProvider, ModelResponse } from "../models/types";

// [MERGE FIX 2026-09-04] This file's own docblock claims "no mic/TTS/DB
// involved," but DEFAULT_VOICE_CONFIG.textToSpeech.enabled is true, so
// every respondToText() call below was actually running real TTS
// synthesis too - harmless when Piper was the default (fast), but real
// desktop-tested Chatterbox is now the default provider (per Gavin's
// explicit choice - see JARVIS-MASTER-ARCHITECTURE-UPDATED.md), whose
// cold-start-then-fall-back-to-Piper path alone exceeds bun:test's 5000ms
// per-test timeout. These tests only assert routing (did the model get
// called), so TTS is disabled here to make the docblock's claim true and
// keep them fast, rather than raising the timeout to paper over it.
const ROUTING_TEST_CONFIG = {
  ...DEFAULT_VOICE_CONFIG,
  textToSpeech: { ...DEFAULT_VOICE_CONFIG.textToSpeech, enabled: false },
};

/**
 * Proves the Intent/Complexity Router (core/intent-router.ts) actually
 * changes what VoiceInterface does, not just what it logs, on its
 * no-`Orchestrator` fallback path:
 *   - a known action (TOOL) never reaches the model at all (section 8).
 *   - a plain question (FAST) still goes through the single model call,
 *     unchanged from before the router existed.
 *
 * [MERGE NOTE 2026-09-04] The DEEP path no longer has a handler on this
 * class at all — reconciling with the live voice-pipeline work found
 * `Orchestrator.processConversation()` already IS the primary dispatcher
 * whenever a real `Orchestrator` is supplied (see voice-interface.ts's
 * `generateResponse()`), so DEEP-path routing to the multi-agent
 * `orchestrate()` pipeline was added there instead (see orchestrator.ts's
 * `processConversation()`) rather than duplicated here via a separate
 * `DeepHandler` callback. On this no-orchestrator fallback path, a
 * DEEP-classified utterance just falls through to the same direct model
 * call a FAST one gets — there is nothing else here to hand it to.
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

    const voice = new VoiceInterface(ROUTING_TEST_CONFIG, provider);
    const { response } = await voice.respondToText("Open Notepad");

    expect(modelCalls).toBe(0);
    // On this sandbox (no Windows/PowerShell, no DB) the action itself
    // will fail — that's fine and expected; what matters is it degrades to
    // a spoken string instead of throwing, and never touched the model.
    expect(typeof response).toBe("string");
    expect(response.length).toBeGreaterThan(0);
  });

  test("a DEEP-classified request falls back to a direct model call with no Orchestrator configured", async () => {
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

    const voice = new VoiceInterface(ROUTING_TEST_CONFIG, provider); // no Orchestrator
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

    const voice = new VoiceInterface(ROUTING_TEST_CONFIG, provider);
    const { response } = await voice.respondToText("What's the capital of France?");

    expect(modelCalls).toBe(1);
    expect(response).toBe("Paris.");
  });
});
