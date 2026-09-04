import { ModelProvider, ModelMessage, ModelRequestOptions, ModelResponse, ModelStreamChunk } from "./types";

/**
 * Gemini model provider — talks directly to Google's API, not through Zo.
 * This is what makes "provider-agnostic" and "$0-first" true rather than
 * aspirational: it's a second real path that doesn't depend on a Zo key.
 *
 * Free tier: aistudio.google.com/apikey. No SDK dependency — a raw fetch
 * call, to avoid adding a package.
 *
 * [UPDATE 2026-09-04] First real live call against an actual GEMINI_API_KEY
 * (added this session) found the disclosed staleness risk below had
 * already happened: both `gemini-2.0-flash` and this file's own former
 * default, `gemini-2.5-flash`, now 404 with "This model ... is no longer
 * available[/to new users]. Please update your code to use
 * models/gemini-3.6-flash" — confirmed directly against
 * generativelanguage.googleapis.com, not guessed. Default bumped to
 * `gemini-3.6-flash`, verified live to return a real completion.
 *
 * NOTE: the request/response shape matches Google's documented Generative
 * Language API; if `GEMINI_MODEL`/this default is stale again by the time
 * you run this, Google's error message will say so directly (404, model
 * not found) the same way it did here — that's still the real signal to
 * watch for, not a one-time fix.
 */

// [ADDED 2026-09-04] Real floor, found by live-testing against the actual
// API, not guessed: even with thinkingConfig.thinkingLevel set to "low"
// (see complete()'s own comment), gemini-3.6-flash's thinking overhead ate
// enough of a 200-token budget - JARVIS's real FAST-tier default, per
// model-router.ts - to truncate `content` into garbage ("Here is the")
// rather than the real answer. 250 was observed to just barely work; 300
// gives real margin against the run-to-run variance thinking token counts
// showed live (character reasoning isn't deterministic in length). Only
// raises the request actually sent to Gemini - a caller that asked for
// less still gets whatever Gemini returns, this just stops silently
// starving it below where this model can produce real output at all.
const GEMINI_MIN_OUTPUT_TOKENS = 300;

export class GeminiProvider implements ModelProvider {
  name = "gemini";
  private apiKey: string;
  readonly model: string;

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY || "";
    this.model = model || process.env.GEMINI_MODEL || "gemini-3.6-flash";

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
      // BUG FIX (2026-08-28, full-codebase review): this fetch had no
      // signal/timeout at all — unlike every other provider's available()
      // (Ollama 3s, OpenRouter/OmniRoute 5s) and unlike this file's own
      // stream() method (which does set a 60s AbortSignal.timeout).
      // selectProvider() in llm-gateway.ts awaits each candidate's
      // available() sequentially in registration order (OmniRoute ->
      // Ollama -> Gemini -> OpenRouter): if GEMINI_API_KEY is set and this
      // network path stalls (not a clean connection-refused, but a
      // firewall silently dropping packets, a DNS hang, a slow proxy)
      // while OmniRoute/Ollama are both down, this await blocks forever
      // and OpenRouter — the otherwise-healthy next provider in line —
      // never gets a chance to be tried at all. 5s matches the other
      // providers' health-check budgets.
      const response = await fetch(this.endpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
          // [ADDED 2026-09-04] gemini-3.6-flash is a "thinking" model by
          // default — its internal reasoning tokens count against
          // maxOutputTokens, so this tiny 5-token check would otherwise
          // burn its whole budget on invisible thinking before ever
          // reaching a real output token. Doesn't change the result here
          // (response.ok is all this checks), just avoids paying for
          // thinking on every health-check ping. See complete()'s own
          // comment for the real, live-found bug this same setting fixes.
          generationConfig: { maxOutputTokens: 5, thinkingConfig: { thinkingLevel: "low" } },
        }),
        signal: AbortSignal.timeout(5_000),
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
      timeoutMs?: number;
      signal?: AbortSignal;
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
        maxOutputTokens: Math.max(options?.maxTokens ?? 2000, GEMINI_MIN_OUTPUT_TOKENS),
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            content: { type: "STRING" },
            confidence: { type: "NUMBER" },
          },
          required: ["content", "confidence"],
        },
        // [ADDED 2026-09-04] Real, live-found bug: gemini-3.6-flash (this
        // file's new default after the old one 404'd — see the header
        // comment) is a "thinking" model whose internal reasoning tokens
        // count against maxOutputTokens. Confirmed directly against the
        // real API: a 200-token budget (JARVIS's actual FAST-tier
        // default, per model-router.ts) came back with `content` set to
        // literal garbage ("Here is the JSON requested:") because
        // thinking alone ate nearly the whole budget before any real
        // output token was emitted; a 20-token budget failed outright
        // (finishReason MAX_TOKENS, zero output). `thinkingBudget: 0`
        // is rejected by this model as an invalid argument (thinking
        // can't be fully disabled here) - `thinkingLevel: "low"`
        // is the real, live-verified fix: same 200-token budget now
        // returns the actual correct answer instead of silently
        // fabricating one.
        thinkingConfig: { thinkingLevel: "low" },
      },
      systemInstruction: { parts: [{ text: structuredSystemText }] },
    };

    // BUG FIX (2026-08-28, full-codebase review): this fetch also had no
    // signal/timeout — contrast with stream() in this same file (line
    // ~199), which correctly applies
    // `options.signal || AbortSignal.timeout(options.timeoutMs ?? 60_000)`.
    // This is the streaming-vs-non-streaming divergence that mattered:
    // production only ever calls complete(), never stream(). Once
    // selectProvider() picked Gemini (e.g. OmniRoute/Ollama both
    // unavailable), any network stall here — not just a slow response,
    // a connection that's accepted but never answered — hung this call
    // forever. A promise that never settles is never caught by the
    // gateway's try/catch, so it never fell back to OpenRouter and never
    // surfaced an error upward either.
    const response = await fetch(this.endpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options?.signal || AbortSignal.timeout(options?.timeoutMs ?? 60_000),
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
        maxOutputTokens: Math.max(options.maxTokens ?? 2000, GEMINI_MIN_OUTPUT_TOKENS),
        // See complete()'s own comment - same live-found thinking-token
        // bug, same fix.
        thinkingConfig: { thinkingLevel: "low" },
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
