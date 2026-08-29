/**
 * Intelligent Model Router
 *
 * Selects the optimal LLM based on:
 * - Reasoning complexity (fast vs deep)
 * - Conversation context
 * - User preferences
 * - Available models
 * - Cost/latency tradeoffs
 *
 * This allows swapping between providers without changing conversation logic.
 */

import type { ConversationContext, ReasoningPath } from "../phase2/conversation-engine.ts";
import type { ModelRouter as IModelRouter } from "./conversation-intelligence.ts";

export interface LLMConfig {
  provider: "omniroute" | "ollama" | "gemini" | "openrouter";
  model: string;
  temperature: number;
  maxTokens: number;
  topP?: number;
  frequencyPenalty?: number;
  stream: boolean;
}

export interface ModelChoice {
  model: string;
  provider: string;
  config: LLMConfig;
  reasoning: string;
}

/**
 * Intelligent Model Router Implementation
 */
export class IntelligentModelRouter implements IModelRouter {
  private availableModels: Map<string, LLMConfig>;
  private userPreferences: { preferredProvider?: string; budget?: "free" | "standard" | "premium" };
  private requestLog: Array<{ intent: string; chosen: string; timestamp: Date }> = [];

  constructor(models?: Map<string, LLMConfig>) {
    this.availableModels = models || this.getDefaultModels();
    this.userPreferences = {};

    console.log("\n🧭 Intelligent Model Router initialized");
    console.log(`   Available models: ${this.availableModels.size}`);
  }

  /**
   * Get default model configuration.
   *
   * Provider is OmniRoute everywhere (2026-08-27, matches the gateway's
   * registration order in src/models/llm-gateway.ts — per Gavin's request
   * to stop depending on any single provider's daily quota). OmniRoute is
   * a self-hosted aggregator across 300+ providers with its own
   * auto-fallback, so it absorbs a single upstream's quota exhaustion
   * before JARVIS ever sees an error. "auto" (env-overridable via
   * OMNIROUTE_MODEL) lets OmniRoute pick the best available model per its
   * own routing strategy rather than JARVIS hardcoding one. Gemini is kept
   * only as the `LLMConfig.provider` union member for the legacy fallback
   * rung — it is no longer assigned to any tier here.
   */
  private getDefaultModels(): Map<string, LLMConfig> {
    const models = new Map<string, LLMConfig>();
    const omnirouteModel = process.env.OMNIROUTE_MODEL || "auto";

    // Fast - quick response for simple tasks
    models.set("fast-reasoning", {
      provider: "omniroute",
      model: omnirouteModel,
      temperature: 0.3,
      maxTokens: 500,
      stream: true,
    });

    // Main - balanced performance
    models.set("main-reasoning", {
      provider: "omniroute",
      model: omnirouteModel,
      temperature: 0.7,
      maxTokens: 2000,
      stream: true,
    });

    // Deep reasoning - complex analysis
    models.set("deep-reasoning", {
      provider: "omniroute",
      model: omnirouteModel,
      temperature: 0.5,
      maxTokens: 4000,
      stream: true,
    });

    // Deterministic - system operations
    models.set("deterministic", {
      provider: "omniroute",
      model: omnirouteModel,
      temperature: 0.0,
      maxTokens: 1000,
      stream: false,
    });

    // Creative - brainstorming
    models.set("creative", {
      provider: "omniroute",
      model: omnirouteModel,
      temperature: 1.0,
      maxTokens: 2000,
      stream: true,
    });

    return models;
  }

  /**
   * PRIMARY: Select model based on reasoning path and context
   */
  selectModel(
    intention: string,
    reasoning: ReasoningPath,
    context: ConversationContext
  ): { model: string; provider: string; config: Record<string, unknown> } {
    let modelKey = "main-reasoning"; // Default

    // Route based on reasoning path type
    switch (reasoning.type) {
      case "fast":
        modelKey = "fast-reasoning";
        break;

      case "deep":
        modelKey = "deep-reasoning";
        break;

      case "deterministic":
        modelKey = "deterministic";
        break;

      case "main":
        modelKey = "main-reasoning";
        break;
    }

    // Override based on intention
    if (intention === "creative" || intention === "brainstorm") {
      modelKey = "creative";
    }

    const config = this.availableModels.get(modelKey) ||
      this.availableModels.get("main-reasoning")!;

    // Apply user preferences
    const finalConfig = this.applyPreferences(config, context);

    // Log selection
    this.requestLog.push({
      intent: intention,
      chosen: `${finalConfig.provider}/${finalConfig.model}`,
      timestamp: new Date(),
    });

    return {
      model: finalConfig.model,
      provider: finalConfig.provider,
      config: finalConfig as unknown as Record<string, unknown>,
    };
  }

  /**
   * Determine if response should be streamed
   */
  shouldStream(intention: string): boolean {
    // Always stream for conversational responses
    if (intention === "conversational" || intention === "question") {
      return true;
    }

    // Stream for commands if they take time
    if (intention === "command") {
      return false; // Commands should be instant
    }

    // Stream for reasoning
    if (intention === "analysis" || intention === "reasoning") {
      return true;
    }

    // Default: stream
    return true;
  }

  /**
   * Determine if we should use cached response
   */
  shouldUseCache(context: ConversationContext): boolean {
    // Use cache if:
    // 1. Same question was asked in last 10 turns
    // 2. User is in "quick mode" (rapid back-and-forth)
    // 3. Network latency is high

    if (context.turnCount === 0) {
      return false; // First turn
    }

    // If user asks very frequently (more than 1 per 2 seconds), use cache
    const turnDuration = context.sessionStartTime.getTime() > 0
      ? (new Date().getTime() - context.sessionStartTime.getTime()) / context.turnCount
      : 1000;

    return turnDuration < 2000; // Less than 2 seconds per turn
  }

  /**
   * Apply user preferences to model config
   */
  private applyPreferences(
    config: LLMConfig,
    context: ConversationContext
  ): LLMConfig {
    const adjusted = { ...config };

    // If user has limited budget, use faster model
    if (this.userPreferences.budget === "free") {
      adjusted.model = process.env.OMNIROUTE_MODEL || "auto"; // Let OmniRoute pick a free-tier option
      adjusted.maxTokens = Math.min(adjusted.maxTokens, 1000);
    }

    // If user is in a meeting (inferred from context), reduce latency
    if (context.turnCount > 50) {
      // Probably a long conversation, optimize for speed
      adjusted.temperature = Math.max(0.3, adjusted.temperature - 0.2);
      adjusted.maxTokens = Math.min(adjusted.maxTokens, 1500);
    }

    // Preferred provider override
    if (this.userPreferences.preferredProvider) {
      adjusted.provider = this.userPreferences.preferredProvider as LLMConfig["provider"];
    }

    return adjusted;
  }

  /**
   * Analyze request patterns and suggest optimizations
   */
  analyzePatterns(): {
    mostCommonIntention: string;
    averageResponseTime: number;
    recommendedDefaultModel: string;
    suggestions: string[];
  } {
    if (this.requestLog.length === 0) {
      return {
        mostCommonIntention: "unknown",
        averageResponseTime: 0,
        recommendedDefaultModel: "main-reasoning",
        suggestions: [],
      };
    }

    // Find most common intention
    const intentionCounts = new Map<string, number>();
    for (const log of this.requestLog) {
      intentionCounts.set(log.intent, (intentionCounts.get(log.intent) || 0) + 1);
    }

    const mostCommon = Array.from(intentionCounts.entries()).sort(
      ([, a], [, b]) => b - a
    )[0][0];

    // Calculate average response time
    const avgTime = this.requestLog.length > 0
      ? this.requestLog.reduce((sum, log, i, arr) => {
          if (i === 0) return 0;
          return sum + (log.timestamp.getTime() - arr[i - 1].timestamp.getTime());
        }, 0) / Math.max(1, this.requestLog.length - 1)
      : 0;

    // Generate suggestions
    const suggestions: string[] = [];

    if (mostCommon === "conversational") {
      suggestions.push("Consider using streaming for better perceived latency");
    }

    if (avgTime > 2000) {
      suggestions.push("Average response time is high; consider faster models");
    }

    if (intentionCounts.get("command") || 0 > intentionCounts.size * 0.3) {
      suggestions.push("Many commands; ensure deterministic model is configured");
    }

    return {
      mostCommonIntention: mostCommon,
      averageResponseTime: avgTime,
      recommendedDefaultModel: "main-reasoning",
      suggestions,
    };
  }

  /**
   * Set user preference
   */
  setPreference(
    key: "preferredProvider" | "budget",
    value: unknown
  ): void {
    if (key === "preferredProvider") {
      this.userPreferences.preferredProvider = value as string;
    } else if (key === "budget") {
      this.userPreferences.budget = value as "free" | "standard" | "premium";
    }

    console.log(`   Model preference updated: ${key} = ${value}`);
  }

  /**
   * Add custom model
   */
  addModel(key: string, config: LLMConfig): void {
    this.availableModels.set(key, config);
    console.log(`   Added model: ${key} (${config.provider}/${config.model})`);
  }

  /**
   * Get router status
   */
  getStatus(): {
    modelsAvailable: number;
    requestsProcessed: number;
    mostRecentModel: string | null;
    patterns: ReturnType<IntelligentModelRouter["analyzePatterns"]>;
  } {
    const mostRecent = this.requestLog.length > 0
      ? this.requestLog[this.requestLog.length - 1].chosen
      : null;

    return {
      modelsAvailable: this.availableModels.size,
      requestsProcessed: this.requestLog.length,
      mostRecentModel: mostRecent,
      patterns: this.analyzePatterns(),
    };
  }
}
