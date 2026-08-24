/**
 * Model provider abstraction layer
 * Allows JARVIS to work with different model providers (Claude, local models, etc)
 * without depending on any single one.
 */

export interface ModelMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ModelResponse {
  content: string;
  tokensUsed: number;
  provider: string;
  model: string;
  confidence?: number;
}

export interface ModelProvider {
  name: string;
  available: () => Promise<boolean>;
  complete(
    messages: ModelMessage[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      systemPrompt?: string;
    }
  ): Promise<ModelResponse>;
}

export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}
