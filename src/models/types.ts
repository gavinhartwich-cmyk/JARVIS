export interface ModelMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ModelRequestOptions {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  responseFormat?: {
    type: "json_object" | "json_schema";
    schema?: Record<string, unknown>;
  };
}

export interface ModelResponse {
  content: string;
  tokensUsed: number;
  provider: string;
  model: string;
  confidence?: number;
  requestId?: string;
  finishReason?: string;
}

export interface ModelStreamChunk {
  delta: string;
  done: boolean;
  provider: string;
  model: string;
  tokensUsed?: number;
  confidence?: number;
  requestId?: string;
  finishReason?: string;
}

export interface ModelProvider {
  name: string;
  available(): Promise<boolean>;
  complete(messages: ModelMessage[], options?: ModelRequestOptions): Promise<ModelResponse>;
  stream(messages: ModelMessage[], options?: ModelRequestOptions): AsyncIterable<ModelStreamChunk>;
}

export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}
