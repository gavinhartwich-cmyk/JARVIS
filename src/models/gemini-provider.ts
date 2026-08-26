import { ModelProvider, ModelMessage, ModelRequestOptions, ModelResponse, ModelStreamChunk } from "./types";

/**
 * Gemini model provider — talks directly to Google's API, not through Zo.
 * This is what makes "provider-agnostic" and "$0-first" true rather than
 * aspirational: it's a second real path that doesn't depend on a Zo key.
 *
 * Free tier: aistudio.google.com/apikey. No SDK dependency — a raw fetch
 * call, to avoid adding a package.
 *
 * NOTE: written and typechecked without a live API key to test against
 * (none available in this sandbox). The request/response shape matches
 * Google's documented Generative Language API, but treat the first real
 * call as the actual verification — if the model name in GEMINI_MODEL is
 * stale by the time you run this, Google's error message will say so
 * directly (400, model not found).
 */

export class GeminiProvider implements ModelProvider {
  name = "gemini";
  private apiKey: string;
  readonly model: string;

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY || "";
    this.model = model || process.env.GEMINI_MODEL || "gemini-2.5-flash";

    if (!this.apiKey) {
      console.warn(
        "⚠ Gemini provider initialized without API key. Set GEMINI_API_KEY environment variable."
      );
    }
  }

  private endpoint(): string {
    return `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
  }

  async available(): Promise<boolean> {
    if (!this.apiKey) return false;

    try {
      const response = await fetch(this.endpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: 5 },
        }),
      });
      return response.ok;
    } catch (error) {
      console.error("Gemini provider availability check failed:", error);
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
    if (!this.apiKey) {
      throw new Error(
        "Gemini provider not configured. Set GEMINI_API_KEY environment variable (free at aistudio.google.com/apikey)."
      );
    }

    // Gemini uses "model" instead of "assistant" for its own turns, and
    // takes system prompts via a dedicated field rather than as a message.
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const systemText = options?.systemPrompt ?? messages.find((m) => m.role === "system")?.content;
    // Structured system instruction telling the model exactly what to
    // return, on top of whatever the caller's own system prompt says.
    const structuredSystemText =
      (systemText ? systemText + "\n\n" : "") +
      "Respond with a JSON object matching the given schema: `content` holds your " +
      "full answer (markdown is fine inside the string), and `confidence` is your " +
      "genuine self-assessed confidence in that answer, from 0.0 to 1.0.";

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? 2000,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            content: { type: "STRING" },
            confidence: { type: "NUMBER" },
          },
          required: ["content", "confidence"],
        },
      },
      systemInstruction: { parts: [{ text: structuredSystemText }] },
    };

    const response = await fetch(this.endpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Gemini API error: ${response.status} ${response.statusText} — ${errText}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: { totalTokenCount?: number };
    };

    const rawText = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!rawText) {
      const finishReason = data.candidates?.[0]?.finishReason ?? "unknown";
      throw new Error(
        `Gemini returned no text (finishReason: ${finishReason}) — likely a safety block or empty response.`
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
      // Structured mode failed to produce valid JSON (rare, but possible)
      // — fall back to the raw text with no confidence rather than crash.
      content = rawText;
      confidence = undefined;
    }

    return {
      content,
      tokensUsed: data.usageMetadata?.totalTokenCount ?? 0,
      provider: "gemini",
      model: this.model,
      confidence,
    };
  }

  /**
   * Streaming variant for real-time conversational use (Phase 2 voice
   * interface). Unlike `complete()`, this does NOT request structured
   * JSON output — partial JSON fragments aren't meaningfully parseable
   * mid-stream, and a live voice response needs raw text deltas, not a
   * confidence score. Uses Gemini's documented `streamGenerateContent`
   * SSE endpoint. NOTE: written against Google's documented response
   * shape but not yet exercised against a live API key in this sandbox —
   * treat the first real call as the actual verification, same caveat as
   * `complete()` above.
   */
  async *stream(messages: ModelMessage[], options: ModelRequestOptions = {}): AsyncIterable<ModelStreamChunk> {
    if (!this.apiKey) {
      throw new Error(
        "Gemini provider not configured. Set GEMINI_API_KEY environment variable (free at aistudio.google.com/apikey)."
      );
    }

    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const systemText = options.systemPrompt ?? messages.find((m) => m.role === "system")?.content;

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 2000,
      },
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal || AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
    } catch (error) {
      throw new Error(`Gemini streaming request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok || !response.body) {
      const details = await response.text().catch(() => "");
      throw new Error(`Gemini API error: ${response.status} ${response.statusText} — ${details}`);
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
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;

          let chunk: {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
            usageMetadata?: { totalTokenCount?: number };
          };
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }

          tokensUsed = chunk.usageMetadata?.totalTokenCount ?? tokensUsed;
          const candidate = chunk.candidates?.[0];
          const delta = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
          const finishReason = candidate?.finishReason;
          if (delta || finishReason) {
            yield { delta, done: Boolean(finishReason), provider: this.name, model: this.model, tokensUsed, finishReason };
          }
        }
      }
      yield { delta: "", done: true, provider: this.name, model: this.model, tokensUsed };
    } finally {
      reader.releaseLock();
    }
  }
}
