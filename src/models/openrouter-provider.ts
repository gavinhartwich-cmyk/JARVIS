import type {
  ModelMessage,
  ModelProvider,
  ModelRequestOptions,
  ModelResponse,
  ModelStreamChunk,
} from "./types";

interface OpenRouterResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: { total_tokens?: number };
}

interface OpenRouterStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: { total_tokens?: number };
}

export class OpenRouterProvider implements ModelProvider {
  name = "openrouter";
  private readonly apiKey: string;
  readonly model: string;
  private readonly baseUrl: string;

  constructor(apiKey?: string, model?: string, baseUrl?: string) {
    this.apiKey = apiKey || process.env.OPENROUTER_API_KEY || "";
    this.model = model || process.env.OPENROUTER_MODEL || "openrouter/free";
    this.baseUrl = (baseUrl || process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
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
    const data = (await response.json()) as OpenRouterResponse;
    const choice = data.choices?.[0];
    const content = choice?.message?.content || "";
    if (!content) throw new Error("OpenRouter returned an empty response.");
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
    if (!response.body) throw new Error("OpenRouter returned no streaming body.");
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
          let chunk: OpenRouterStreamChunk;
          try {
            chunk = JSON.parse(payload) as OpenRouterStreamChunk;
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
      throw new Error("OpenRouter provider is not configured. Set OPENROUTER_API_KEY in the local .env file.");
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
      throw new Error(`OpenRouter request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(`OpenRouter API error: ${response.status} ${response.statusText} — ${details}`);
    }
    return response;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "http://localhost",
      "X-Title": process.env.OPENROUTER_APP_NAME || "JARVIS",
    };
  }
}
