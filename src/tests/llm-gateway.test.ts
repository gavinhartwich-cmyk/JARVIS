import { describe, expect, test } from "bun:test";
import { LLMGateway, GatewayModelProvider } from "../models/llm-gateway";
import type { ModelMessage, ModelProvider, ModelResponse, ModelStreamChunk } from "../models/types";

/**
 * Proves the gateway's fallback/health-tracking logic is actually correct
 * — not just typechecked — using fake providers that succeed/fail on cue.
 * No live API keys needed: this is exactly the behavior that mattered in
 * practice (Gemini's free-tier 429 killing the whole Phase 0/1 pipeline).
 */

const MSGS: ModelMessage[] = [{ role: "user", content: "hi" }];

function fakeProvider(opts: {
  name: string;
  available?: boolean;
  failComplete?: boolean;
  failStream?: boolean;
}): ModelProvider {
  return {
    name: opts.name,
    async available() {
      return opts.available ?? true;
    },
    async complete(): Promise<ModelResponse> {
      if (opts.failComplete) throw new Error(`${opts.name}: simulated quota error (429)`);
      return { content: `response from ${opts.name}`, tokensUsed: 1, provider: opts.name, model: "fake" };
    },
    async *stream(): AsyncIterable<ModelStreamChunk> {
      if (opts.failStream) throw new Error(`${opts.name}: simulated stream error`);
      yield { delta: `hi from ${opts.name}`, done: true, provider: opts.name, model: "fake" };
    },
  };
}

describe("LLMGateway", () => {
  test("uses the first registered provider when it succeeds", async () => {
    const gateway = new LLMGateway();
    gateway.register(fakeProvider({ name: "primary" }));
    gateway.register(fakeProvider({ name: "backup" }));

    const result = await gateway.generate(MSGS);
    expect(result.provider).toBe("primary");
  });

  test("falls back to the next provider when the first throws (the actual Gemini-429 scenario)", async () => {
    const gateway = new LLMGateway();
    gateway.register(fakeProvider({ name: "gemini", failComplete: true }));
    gateway.register(fakeProvider({ name: "ollama" }));

    const result = await gateway.generate(MSGS);
    expect(result.provider).toBe("ollama");
  });

  test("throws when every registered provider is unavailable", async () => {
    const gateway = new LLMGateway();
    gateway.register(fakeProvider({ name: "gemini", available: false }));
    gateway.register(fakeProvider({ name: "ollama", available: false }));

    await expect(gateway.generate(MSGS)).rejects.toThrow(/No configured LLM provider/);
  });

  test("a provider that fails is put on cooldown and skipped on the next call", async () => {
    const gateway = new LLMGateway();
    gateway.register(fakeProvider({ name: "flaky", failComplete: true }));
    gateway.register(fakeProvider({ name: "stable" }));

    await gateway.generate(MSGS); // first call: flaky fails, falls back to stable
    const health = gateway.getHealth();
    const flaky = health.find((h) => h.provider === "flaky")!;
    expect(flaky.failures).toBe(1);
    expect(flaky.cooldownUntil).toBeInstanceOf(Date);

    // Second call should skip "flaky" (still in cooldown) and go straight
    // to "stable" without re-throwing.
    const result = await gateway.generate(MSGS);
    expect(result.provider).toBe("stable");
  });

  test("stream() falls back the same way complete() does", async () => {
    const gateway = new LLMGateway();
    gateway.register(fakeProvider({ name: "gemini" }));

    const chunks: ModelStreamChunk[] = [];
    for await (const chunk of gateway.stream(MSGS)) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].provider).toBe("gemini");
  });

  test("GatewayModelProvider adapts a gateway to the single-provider ModelProvider interface", async () => {
    const gateway = new LLMGateway();
    gateway.register(fakeProvider({ name: "primary", failComplete: true }));
    gateway.register(fakeProvider({ name: "backup" }));
    const provider = new GatewayModelProvider(gateway);

    expect(await provider.available()).toBe(true);
    const response = await provider.complete(MSGS);
    expect(response.provider).toBe("backup");

    const chunks: ModelStreamChunk[] = [];
    for await (const chunk of provider.stream(MSGS)) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("GatewayModelProvider.available() is false when no registered provider is reachable", async () => {
    const gateway = new LLMGateway();
    gateway.register(fakeProvider({ name: "gemini", available: false }));
    const provider = new GatewayModelProvider(gateway);
    expect(await provider.available()).toBe(false);
  });
});
