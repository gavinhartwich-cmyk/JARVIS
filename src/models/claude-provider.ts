import { ModelProvider, ModelMessage, ModelResponse } from "./types";

/**
 * Claude/Zo model provider
 * Uses Zo's /zo/ask API endpoint
 */

export class ClaudeProvider implements ModelProvider {
  name = "claude";
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    this.apiKey = apiKey || process.env.ZO_API_KEY || "";
    this.baseUrl = baseUrl || "https://api.zo.computer";

    if (!this.apiKey) {
      console.warn(
        "⚠ Claude provider initialized without API key. Set ZO_API_KEY environment variable."
      );
    }
  }

  async available(): Promise<boolean> {
    if (!this.apiKey) return false;

    try {
      const response = await fetch(`${this.baseUrl}/zo/ask`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: "ping",
          model_name: "byok:f7a8a82a-01c3-4bd5-bed4-88361685d27f",
        }),
      });

      return response.ok;
    } catch (error) {
      console.error("Claude provider availability check failed:", error);
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
        "Claude provider not configured. Set ZO_API_KEY environment variable."
      );
    }

    // Convert messages to a single prompt
    let prompt = "";
    if (options?.systemPrompt) {
      prompt += `System: ${options.systemPrompt}\n\n`;
    }

    for (const msg of messages) {
      if (msg.role === "system") {
        prompt += `System: ${msg.content}\n\n`;
      } else if (msg.role === "user") {
        prompt += `User: ${msg.content}\n\n`;
      } else if (msg.role === "assistant") {
        prompt += `Assistant: ${msg.content}\n\n`;
      }
    }

    const response = await fetch(`${this.baseUrl}/zo/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: prompt,
        model_name: "byok:f7a8a82a-01c3-4bd5-bed4-88361685d27f",
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Claude API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as {
      output: string;
      tokens_used?: number;
    };

    return {
      content: data.output,
      tokensUsed: data.tokens_used || 0,
      provider: "claude",
      model: "claude-haiku-4-5",
    };
  }
}
