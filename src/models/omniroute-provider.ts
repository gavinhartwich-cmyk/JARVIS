import type {
  ModelMessage,
  ModelProvider,
  ModelRequestOptions,
  ModelResponse,
  ModelStreamChunk,
} from "./types";

/**
 * OmniRoute is a self-hosted, OpenAI-compatible AI gateway (MIT license,
 * https://github.com/diegosouzapw/OmniRoute) that aggregates 300+ LLM
 * providers — 90+ of them free — behind one local endpoint with its own
 * quota-aware auto-fallback across providers. Point JARVIS at it and a
 * single provider's daily cap stops being a JARVIS-level failure at all:
 * OmniRoute itself routes around it before this provider ever sees an
 * error. Wire format is identical to OpenRouter's — same request/response
 * shape — so this mirrors openrouter-provider.ts almost exactly, just
 * against a local base URL by default.
 */

interface OmniRouteResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: { total_tokens?: number };
}

interface OmniRouteStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: { total_tokens?: number };
}

export class OmniRouteProvider implements ModelProvider {
  name = "omniroute";
  private readonly apiKey: string;
  readonly model: string;
  private readonly baseUrl: string;

  constructor(apiKey?: string, model?: string, baseUrl?: string) {
    this.apiKey = apiKey || process.env.OMNIROUTE_API_KEY || "";
    // "auto" lets OmniRoute itself pick the best available free/paid model
    // per its own routing strategy, instead of JARVIS hardcoding one.
    this.model = model || process.env.OMNIROUTE_MODEL || "auto";
    this.baseUrl = (baseUrl || process.env.OMNIROUTE_BASE_URL || "http://localhost:20128/v1").replace(/\/$/, "");
  }

  async available(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async complete(messages: ModelMessage[], options: ModelRequestOptions = {}): Promise<ModelResponse> {
    const response = await this.request(messages, { ...options, stream: false });
    const data = (await response.json()) as OmniRouteResponse;
    const choice = data.choices?.[0];
    const content = choice?.message?.content || "";
    if (!content) throw new Error("OmniRoute returned an empty response.");
    return {
      content,
      tokensUsed: data.usage?.total_tokens ?? 0,
      provider: this.name,
      model: data.model || this.model,
      requestId: data.id,
      finishReason: choice?.finish_reason,
    };
  }

  async *stream(messages: ModelMessage[], options: ModelRequestOptions = {}): AsyncIterable<ModelStreamChunk> {
    const response = await this.request(messages, { ...options, stream: true });
    if (!response.body) throw new Error("OmniRoute returned no streaming body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let requestId: string | undefined;
    let model = this.model;
    let tokensUsed = 0;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") {
            yield { delta: "", done: true, provider: this.name, model, tokensUsed, requestId };
            return;
          }
          let chunk: OmniRouteStreamChunk;
          try {
            chunk = JSON.parse(payload) as OmniRouteStreamChunk;
          } catch {
            continue;
          }
          requestId = chunk.id || requestId;
          model = chunk.model || model;
          tokensUsed = chunk.usage?.total_tokens ?? tokensUsed;
          const choice = chunk.choices?.[0];
          const delta = choice?.delta?.content || "";
          const finishReason = choice?.finish_reason || undefined;
          if (delta || finishReason) {
            yield { delta, done: Boolean(finishReason), provider: this.name, model, tokensUsed, requestId, finishReason };
          }
        }
      }
      yield { delta: "", done: true, provider: this.name, model, tokensUsed, requestId };
    } finally {
      reader.releaseLock();
    }
  }

  private async request(messages: ModelMessage[], options: ModelRequestOptions & { stream?: boolean }): Promise<Response> {
    if (!this.apiKey) {
      throw new Error("OmniRoute provider is not configured. Set OMNIROUTE_API_KEY in the local .env file (get it from the OmniRoute dashboard).");
    }

    const body: Record<string, unknown> = {
      model: options.model || this.model,
      messages,
      stream: options.stream ?? false,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 2000,
    };
    if (options.responseFormat) body.response_format = options.responseFormat;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: options.signal || AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
    } catch (error) {
      throw new Error(`OmniRoute request failed: ${error instanceof Error ? error.message : String(error)} — is OmniRoute running (npm start / omniroute) on this machine?`);
    }
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(`OmniRoute API error: ${response.status} ${response.statusText} — ${details}`);
    }
    return response;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }
}
