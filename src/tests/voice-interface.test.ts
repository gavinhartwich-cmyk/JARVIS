import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { VoiceInterface } from "../phase2/voice-interface";
import { DEFAULT_VOICE_CONFIG } from "../phase2/voice-config";
import { OllamaProvider } from "../models/ollama-provider";

/**
 * Proves respondToText() (and the generateResponse() it calls internally)
 * is a real LLM call, not the old canned "I received your command..."
 * stub: runs it against the real local Ollama provider (no API key
 * needed, matches Phase 0/1's $0-path verification pattern) and checks
 * the reply is neither the old literal stub text nor an empty/error
 * string.
 *
 * Requires Ollama running locally (jarvis-ollama service, see
 * jarvis-phase-1-developer memory) — skips instead of failing if it's not
 * reachable, since a fresh clone/CI box won't have it running.
 */

let ollamaAvailable = true;
try {
  execSync("curl -sf -o /dev/null http://localhost:11434/api/tags", { timeout: 2000 });
} catch {
  ollamaAvailable = false;
}

describe.if(ollamaAvailable)("VoiceInterface.respondToText (real LLM)", () => {
  test("returns a real model reply, not the old canned stub string", async () => {
    const voice = new VoiceInterface(DEFAULT_VOICE_CONFIG, new OllamaProvider());
    const { response } = await voice.respondToText("What is 2 plus 2?");

    expect(typeof response).toBe("string");
    expect(response.length).toBeGreaterThan(0);
    expect(response).not.toContain("I received your command");
    expect(response).not.toContain("agent pipeline");
  }, 60000);

  test("two different questions get two different real answers", async () => {
    const voice = new VoiceInterface(DEFAULT_VOICE_CONFIG, new OllamaProvider());
    const a = await voice.respondToText("Say the word 'apple' and nothing else.");
    const b = await voice.respondToText("Say the word 'banana' and nothing else.");

    expect(a.response.toLowerCase()).toContain("apple");
    expect(b.response.toLowerCase()).toContain("banana");
  }, 60000);
});

if (!ollamaAvailable) {
  test.skip("VoiceInterface.respondToText (real LLM) — skipped: Ollama not reachable at localhost:11434", () => {});
}
