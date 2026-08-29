import type {
  ModelMessage,
  ModelProvider,
  ModelRequestOptions,
  ModelResponse,
  ModelStreamChunk,
} from "./types";
import { GeminiProvider } from "./gemini-provider";
import { OllamaProvider } from "./ollama-provider";
import { OpenRouterProvider } from "./openrouter-provider";
import { OmniRouteProvider } from "./omniroute-provider";

export type ModelTier = "fast" | "general" | "deep" | "coding";

/**
 * `tier` is declared but not yet read anywhere in this file — flagged
 * honestly 2026-08-27 rather than left silently unused. Capability-aware
 * routing today happens two levels up: `IntelligentModelRouter` already
 * picks a temperature/token profile per reasoning path (fast/main/deep/
 * deterministic/creative — see model-router.ts), and OmniRoute's own
 * `model: "auto"` does capability-aware model selection across its 300+
 * upstreams by default. A per-provider `tier` → specific-model mapping
 * here would only matter for the fallback rungs (Ollama/Gemini/OpenRouter,
 * each fixed to one configured model), and guessing at that mapping
 * without a way to test it against a live provider isn't worth the risk —
 * left as a documented extension point, not built speculatively.
 */
export interface GatewayRequest extends ModelRequestOptions {
  tier?: ModelTier;
}

export interface ProviderHealth {
  provider: string;
  available: boolean;
  failures: number;
  lastFailureAt?: Date;
  lastSuccessAt?: Date;
  cooldownUntil?: Date;
}

export class LLMGateway {
  private readonly providers = new Map<string, ModelProvider>();
  private readonly health = new Map<string, ProviderHealth>();

  register(provider: ModelProvider): void {
    this.providers.set(provider.name, provider);
    this.health.set(provider.name, { provider: provider.name, available: true, failures: 0 });
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  async anyAvailable(): Promise<boolean> {
    for (const provider of this.providers.values()) {
      try {
        if (await provider.available()) return true;
      } catch {
        // A throwing availability check just means that provider isn't
        // usable right now, not that the whole gateway is down.
      }
    }
    return false;
  }

  getHealth(): ProviderHealth[] {
    return [...this.health.values()].map((entry) => ({ ...entry }));
  }

  /**
   * Cascades through every registered provider in preference order, not
   * just one fallback hop. Previously this tried the preferred provider,
   * then exactly one alternate, then gave up — so with all four providers
   * configured (OmniRoute, Ollama, Gemini, OpenRouter), an OmniRoute *and*
   * Ollama outage would surface as a failure even though Gemini/OpenRouter
   * were still reachable. Fixed 2026-08-27 per Gavin's OmniRoute Routing
   * Directive ("Provider failure, timeout, quota exhaustion, or rate
   * limiting → automatically fall back" / "never expose provider-specific
   * failures to the user unless every available provider has failed") —
   * now every registered provider gets a real attempt before this throws,
   * and the thrown error only surfaces once all of them have failed.
   */
  async generate(messages: ModelMessage[], request: GatewayRequest = {}): Promise<ModelResponse> {
    const attempted = new Set<string>();
    let lastError: unknown;

    for (let i = 0; i < this.providers.size; i++) {
      let provider: ModelProvider;
      try {
        provider = await this.selectProvider(request, attempted);
      } catch (error) {
        // No more providers left to try. Surface the last real failure
        // (e.g. an actual 401/timeout) rather than the generic
        // "no provider available" message, when we have one.
        throw lastError ?? error;
      }
      attempted.add(provider.name);
      try {
        const response = await provider.complete(messages, request);
        this.markSuccess(provider.name);
        return response;
      } catch (error) {
        this.markFailure(provider.name);
        lastError = error;
        // continue to the next provider
      }
    }

    throw lastError ?? new Error("No configured LLM provider is available. Configure OPENROUTER_API_KEY or another gateway provider.");
  }

  /**
   * Same full-cascade fallback as generate() above (fixed 2026-08-27) —
   * previously stream() had zero fallback at all: any error from the first
   * selected provider was thrown straight through, even with other healthy
   * providers registered.
   */
  async *stream(messages: ModelMessage[], request: GatewayRequest = {}): AsyncIterable<ModelStreamChunk> {
    const attempted = new Set<string>();
    let lastError: unknown;

    for (let i = 0; i < this.providers.size; i++) {
      let provider: ModelProvider;
      try {
        provider = await this.selectProvider(request, attempted);
      } catch (error) {
        throw lastError ?? error;
      }
      attempted.add(provider.name);
      try {
        for await (const chunk of provider.stream(messages, request)) {
          yield chunk;
        }
        this.markSuccess(provider.name);
        return;
      } catch (error) {
        this.markFailure(provider.name);
        lastError = error;
        // continue to the next provider
      }
    }

    throw lastError ?? new Error("No configured LLM provider is available. Configure OPENROUTER_API_KEY or another gateway provider.");
  }

  private async selectProvider(request: GatewayRequest, excluded: Set<string> = new Set()): Promise<ModelProvider> {
    const preferred = request.provider ? this.providers.get(request.provider) : undefined;
    const ordered = [preferred, ...this.providers.values()].filter(
      (candidate, index, list): candidate is ModelProvider =>
        candidate !== undefined && !excluded.has(candidate.name) && list.indexOf(candidate) === index
    );
    for (const provider of ordered) {
      const status = this.health.get(provider.name);
      if (status?.cooldownUntil && status.cooldownUntil > new Date()) continue;
      if (await provider.available()) return provider;
    }
    throw new Error("No configured LLM provider is available. Configure OPENROUTER_API_KEY or another gateway provider.");
  }

  private markSuccess(name: string): void {
    const status = this.health.get(name);
    if (!status) return;
    status.available = true;
    status.failures = 0;
    status.lastSuccessAt = new Date();
    status.cooldownUntil = undefined;
  }

  private markFailure(name: string): void {
    const status = this.health.get(name);
    if (!status) return;
    status.available = false;
    status.failures += 1;
    status.lastFailureAt = new Date();
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(status.failures - 1, 6));
    status.cooldownUntil = new Date(Date.now() + delay);
  }
}

/**
 * Adapts an LLMGateway (multi-provider, health-tracked, auto-failover) to
 * the single-provider ModelProvider interface, so every existing call site
 * (BaseAgent, JARVISDeveloper) gets real cross-provider fallback without
 * changing its own code. This is what turns a Gemini free-tier 429 from
 * "the whole pipeline fails" into "the gateway quietly retries on the next
 * registered provider" — see llm-gateway.test.ts, which proves the
 * fallback logic itself with fake providers (no live API keys needed to
 * verify the routing/health-tracking behavior is correct).
 */
export class GatewayModelProvider implements ModelProvider {
  name = "gateway";

  constructor(private readonly gateway: LLMGateway) {}

  async available(): Promise<boolean> {
    return this.gateway.anyAvailable();
  }

  async complete(messages: ModelMessage[], options?: ModelRequestOptions): Promise<ModelResponse> {
    return this.gateway.generate(messages, options ?? {});
  }

  async *stream(messages: ModelMessage[], options?: ModelRequestOptions): AsyncIterable<ModelStreamChunk> {
    yield* this.gateway.stream(messages, options ?? {});
  }
}

/**
 * Builds the standard JARVIS gateway. Preference order (2026-08-27, per
 * Gavin's request to stop depending on any single provider's daily quota):
 *
 * 1. OmniRoute (if OMNIROUTE_API_KEY is set) — self-hosted gateway that
 *    itself aggregates 300+ providers (90+ free) with its own auto-fallback,
 *    so a single upstream running dry no longer surfaces as a JARVIS-level
 *    failure at all; OmniRoute routes around it before we ever see an error.
 * 2. Ollama — local, no API key, no quota, works even if OmniRoute's local
 *    process isn't running. The zero-cost floor that never runs out.
 * 3. Gemini (if GEMINI_API_KEY is set) — legacy direct provider, kept as an
 *    extra rung since it costs nothing to leave registered.
 * 4. OpenRouter (if OPENROUTER_API_KEY is set) — same reasoning as Gemini.
 *
 * Registration order is gateway preference order when the caller doesn't
 * request a specific provider via `request.provider`.
 */
export function createDefaultGateway(): LLMGateway {
  const gateway = new LLMGateway();
  if (process.env.OMNIROUTE_API_KEY) {
    gateway.register(new OmniRouteProvider());
  }
  gateway.register(new OllamaProvider());
  if (process.env.GEMINI_API_KEY) {
    gateway.register(new GeminiProvider());
  }
  if (process.env.OPENROUTER_API_KEY) {
    gateway.register(new OpenRouterProvider());
  }
  return gateway;
}
