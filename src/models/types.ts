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
  // Per-call timeout passed through to the provider's AbortSignal.timeout().
  // Every provider defaults to 60_000ms if this is left unset - found via a
  // live run where a single Architect-agent call (real reasoning over a
  // real prompt, via OmniRoute's free auto-routed backend) exceeded 60s and
  // got hard-aborted mid-request, surfacing only as an opaque
  // "The operation timed out." several layers up. BaseAgent now forwards
  // this so pipelines whose calls are known to run long (code generation,
  // multi-step reasoning) can ask for more room than the provider default.
  timeoutMs?: number;
}
