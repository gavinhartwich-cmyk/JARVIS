import { ModelProvider, ModelMessage, ModelResponse } from "./types";

/**
 * Gemini model provider — talks directly to Google's API, not through Zo.
 * This is what makes "provider-agnostic" and "$0-first" true rather than
 * aspirational: it's a second real path that doesn't depend on a Zo key.
 *
 * Free tier: aistudio.google.com/apikey. No SDK dependency — a raw fetch
 * call, same style as claude-provider.ts, to avoid adding a package.
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
  private model: string;

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

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? 2000,
      },
    };
    if (systemText) {
      body.systemInstruction = { parts: [{ text: systemText }] };
    }

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

    const content = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!content) {
      const finishReason = data.candidates?.[0]?.finishReason ?? "unknown";
      throw new Error(
        `Gemini returned no text (finishReason: ${finishReason}) — likely a safety block or empty response.`
      );
    }

    return {
      content,
      tokensUsed: data.usageMetadata?.totalTokenCount ?? 0,
      provider: "gemini",
      model: this.model,
    };
  }
}
