import { ModelProvider, ModelMessage, ModelRequestOptions, ModelResponse, ModelStreamChunk } from "./types";

/**
 * Ollama model provider — talks to a local Ollama server, no API key, no
 * cloud quota, genuinely $0. This is the provider the master plan always
 * called for ("$0-first, local-capable") but never actually had code
 * behind it until now; Gemini's free-tier daily quotas turning out to be
 * far stricter than assumed (see PHASE-1-LLM-STRATEGY.md's 2026-08-26
 * correction) is what made this urgent rather than optional.
 *
 * Verified against a real local Ollama server (not just typechecked):
 * installed Ollama, pulled `qwen2.5-coder:1.5b` (a model that fits this
 * project's actual hardware constraint — a 4GB-VRAM GTX 1650 Super — not
 * a large model that only works on a dev machine), and confirmed the
 * exact request/response shape below with a live `/api/chat` call,
 * including structured JSON output via the `format` field.
 */

export class OllamaProvider implements ModelProvider {
  name = "ollama";
  private host: string;
  private model: string;

  constructor(host?: string, model?: string) {
    this.host = (host || process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");
    // qwen2.5-coder:1.5b is the default because it's small enough to run on
    // modest hardware (~1GB on disk, runs on CPU or a few GB of VRAM) while
    // still being coding-tuned, not a generic chat model. Bigger/better
    // local models exist (see PHASE-1-LLM-STRATEGY.md) — anyone with more
    // VRAM should override via OLLAMA_MODEL.
    this.model = model || process.env.OLLAMA_MODEL || "qwen2.5-coder:1.5b";
  }

  private chatEndpoint(): string {
    return `${this.host}/api/chat`;
  }

  async available(): Promise<boolean> {
    try {
      const response = await fetch(`${this.host}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return false;
      // Reachable server isn't enough — confirm the configured model is
      // actually pulled, otherwise every real call would 404.
      const data = (await response.json()) as { models?: Array<{ name: string; model?: string }> };
      const names = (data.models ?? []).flatMap((m) => [m.name, m.model].filter(Boolean) as string[]);
      const modelPulled = names.some((n) => n === this.model || n.startsWith(`${this.model}:`) || `${n}` === this.model.split(":")[0]);
      if (!modelPulled) {
        console.warn(
          `⚠ Ollama is running but "${this.model}" isn't pulled yet. Run: ollama pull ${this.model}`
        );
      }
      return modelPulled;
    } catch (error) {
      return false;
    }
  }

  async complete(
    messages: ModelMessage[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      systemPrompt?: string;
    }
  ): Promise<ModelResponse> {
    const systemText = options?.systemPrompt ?? messages.find((m) => m.role === "system")?.content;
    const structuredSystemText =
      (systemText ? systemText + "\n\n" : "") +
      "Respond with a JSON object matching the given schema: `content` holds your " +
      "full answer (markdown is fine inside the string), and `confidence` is your " +
      "genuine self-assessed confidence in that answer, from 0.0 to 1.0.";

    const chatMessages = [
      { role: "system", content: structuredSystemText },
      ...messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content })),
    ];

    const body = {
      model: this.model,
      messages: chatMessages,
      stream: false,
      format: {
        type: "object",
        properties: {
          content: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["content", "confidence"],
      },
      options: {
        temperature: options?.temperature ?? 0.7,
        num_predict: options?.maxTokens ?? 2000,
      },
    };

    let response: Response;
    try {
      response = await fetch(this.chatEndpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(
        `Could not reach Ollama at ${this.host} — is "ollama serve" running? (${error instanceof Error ? error.message : error})`
      );
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Ollama API error: ${response.status} ${response.statusText} — ${errText}`);
    }

    const data = (await response.json()) as {
      message?: { content?: string };
      done?: boolean;
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const rawText = data.message?.content ?? "";
    if (!rawText) {
      throw new Error(
        `Ollama returned no content (done_reason: ${data.done_reason ?? "unknown"}).`
      );
    }

    let content: string;
    let confidence: number | undefined;
    try {
      const parsed = JSON.parse(rawText) as { content?: string; confidence?: number };
      content = parsed.content ?? rawText;
      confidence =
        typeof parsed.confidence === "number" ? Math.min(Math.max(parsed.confidence, 0), 1) : undefined;
    } catch {
      // A 1.5B model is far more likely than Gemini to occasionally break
      // the schema — fall back to the raw text rather than throw, same as
      // GeminiProvider's fallback path.
      content = rawText;
      confidence = undefined;
    }

    return {
      content,
      tokensUsed: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      provider: "ollama",
      model: this.model,
      confidence,
    };
  }

  /**
   * Streaming variant for real-time conversational use (Phase 2 voice
   * interface). Skips the structured-JSON `format` field used by
   * `complete()` for the same reason as Gemini's stream(): partial JSON
   * isn't usable mid-stream, and a live voice response needs raw text
   * deltas. Uses Ollama's native NDJSON streaming (`stream: true`) — one
   * JSON object per line, `message.content` holds each incremental delta.
   */
  async *stream(messages: ModelMessage[], options: ModelRequestOptions = {}): AsyncIterable<ModelStreamChunk> {
    const systemText = options.systemPrompt ?? messages.find((m) => m.role === "system")?.content;
    const chatMessages = [
      ...(systemText ? [{ role: "system", content: systemText }] : []),
      ...messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })),
    ];

    const body = {
      model: this.model,
      messages: chatMessages,
      stream: true,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? 2000,
      },
    };

    let response: Response;
    try {
      response = await fetch(this.chatEndpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal || AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
    } catch (error) {
      throw new Error(
        `Could not reach Ollama at ${this.host} — is "ollama serve" running? (${error instanceof Error ? error.message : error})`
      );
    }

    if (!response.ok || !response.body) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Ollama API error: ${response.status} ${response.statusText} — ${errText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
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
          if (!trimmed) continue;

          let chunk: {
            message?: { content?: string };
            done?: boolean;
            done_reason?: string;
            prompt_eval_count?: number;
            eval_count?: number;
          };
          try {
            chunk = JSON.parse(trimmed);
          } catch {
            continue;
          }

          tokensUsed = (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0) || tokensUsed;
          const delta = chunk.message?.content ?? "";
          const isDone = Boolean(chunk.done);
          if (delta || isDone) {
            yield {
              delta,
              done: isDone,
              provider: this.name,
              model: this.model,
              tokensUsed,
              finishReason: chunk.done_reason,
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
