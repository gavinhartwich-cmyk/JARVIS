/**
 * Conversational Intelligence & Natural Interaction Layer
 *
 * This is the HEART of JARVIS as a persistent assistant.
 *
 * Core Principles:
 * 1. Conversation is a first-class citizen, not bolted-on
 * 2. Stateful across all interactions
 * 3. Model-agnostic (can swap LLM providers)
 * 4. Streaming-first (start speaking before response completes)
 * 5. Interruption-aware (natural barging-in)
 * 6. Memory-integrated (short + long-term)
 * 7. Personality-consistent (behavioral identity)
 * 8. Proactive (notices things, doesn't just react)
 */

import type { ConversationEngine, ConversationContext, ReasoningPath } from "../phase2/conversation-engine.ts";
import { createDefaultGateway, GatewayModelProvider } from "../models/llm-gateway";
import type { ModelProvider } from "../models/types";
import { findCachedAnswer, recordCacheableEpisode } from "./episode-cache";

export interface ConversationMemory {
  // Long-term episodic memory
  episodes: Array<{
    timestamp: Date;
    summary: string;
    key_entities: string[];
    outcomes: string[];
    importance: number;
  }>;

  // Semantic memory (facts about user)
  semanticFacts: Map<string, { fact: string; confidence: number; learnedAt: Date }>;

  // Procedural memory (how to do things for this user)
  procedures: Map<string, {
    steps: string[];
    commonVariations: Record<string, string[]>;
    frequency: number;
  }>;

  // Preferences
  preferences: {
    communicationStyle: "brief" | "detailed" | "mixed";
    responseTime: "immediate" | "thoughtful" | "adaptive";
    formality: "formal" | "casual" | "adaptive";
    proactivity: "passive" | "balanced" | "aggressive";
    interruptionTolerance: "low" | "medium" | "high";
  };
}

export interface StreamingResponse {
  id: string;
  text: string;
  tokens: string[];
  isComplete: boolean;
  confidence: number;
  startTime: Date;
  totalTokens: number;
  cancel: () => void;
}

export interface ModelRouter {
  selectModel(
    intention: string,
    reasoning: ReasoningPath,
    context: ConversationContext
  ): { model: string; provider: string; config: Record<string, unknown> };

  shouldStream(intention: string): boolean;
  shouldUseCache(context: ConversationContext): boolean;
}

export interface InterruptionContext {
  interruptingUtterance: string;
  interruptedAt: Date;
  wasStreaming: boolean;
  wasSpeaking: boolean;
}

/**
 * Conversational Intelligence Layer
 *
 * Orchestrates all conversation-related behavior independent of backend.
 */
export class ConversationalIntelligence {
  private conversationEngine: ConversationEngine;
  private memory: ConversationMemory;
  private currentStream?: StreamingResponse;
  private modelRouter: ModelRouter;
  private modelProvider: ModelProvider;
  private interruptionBuffer: InterruptionContext[] = [];

  // Proactive monitoring
  private proactiveMonitors: Map<string, () => Promise<string | null>> = new Map();
  private lastProactiveCheck: Date = new Date();

  constructor(engine: ConversationEngine, router: ModelRouter, modelProvider?: ModelProvider) {
    this.conversationEngine = engine;
    this.modelRouter = router;
    // Only used for the episode cache's "is this genuinely the same
    // question, and is the old answer still true" verification check —
    // the actual reply generation below (streamFromModel/streamFromBuffer)
    // is still a placeholder, not a real model call.
    this.modelProvider = modelProvider || new GatewayModelProvider(createDefaultGateway());
    this.memory = this.initializeMemory();

    console.log("\n🧠 Conversational Intelligence initialized");
    console.log("   Conversation: First-class citizen");
    console.log("   Memory: Long-term + working");
    console.log("   Streaming: Enabled");
    console.log("   Proactivity: Monitoring");
  }

  /**
   * Initialize long-term memory
   */
  private initializeMemory(): ConversationMemory {
    return {
      episodes: [],
      semanticFacts: new Map(),
      procedures: new Map(),
      preferences: {
        communicationStyle: "mixed",
        responseTime: "adaptive",
        formality: "casual",
        proactivity: "balanced",
        interruptionTolerance: "medium",
      },
    };
  }

  /**
   * CORE: Process utterance with full conversational context
   *
   * Returns streaming response that can start TTS immediately
   */
  async processWithStreaming(
    utterance: string
  ): Promise<StreamingResponse> {
    // Phase 1: Conversation Engine preprocessing
    const { intention, reasoningPath } = await this.conversationEngine.processUserUtterance(
      utterance
    );

    // Phase 2: Select model based on reasoning path
    const context = this.conversationEngine.getConversationContext();
    const model = this.modelRouter.selectModel(intention, reasoningPath, context);

    // Phase 3: Assemble complete prompt with memory
    const prompt = this.assemblePrompt(utterance, intention, context);

    // Phase 4: Check if we can use cached response
    if (this.modelRouter.shouldUseCache(context)) {
      const cached = await this.checkMemoryCache(utterance);
      if (cached) {
        return this.createStreamFromText(cached, "memory");
      }
    }

    // Phase 5: Start streaming from model
    if (this.modelRouter.shouldStream(intention)) {
      return this.streamFromModel(prompt, model, utterance);
    } else {
      // For non-streamed: still create streaming interface
      return this.streamFromBuffer(prompt, model, utterance);
    }
  }

  /**
   * Assemble prompt with full conversational context
   *
   * CRITICAL: This is what makes responses coherent and personal
   */
  private assemblePrompt(
    utterance: string,
    intention: string,
    context: ConversationContext
  ): string {
    const components: string[] = [];

    // System prompt segment
    components.push(`You are JARVIS, a persistent conversational AI assistant.`);
    components.push(`You maintain continuous conversation state across interactions.`);

    // Personality segment
    const prefs = this.memory.preferences;
    components.push(`\nCommunication Style: ${prefs.communicationStyle}`);
    components.push(`Formality: ${prefs.formality}`);
    components.push(`Response approach: ${prefs.responseTime}`);

    // Current context segment
    if (context.workingMemory.currentTask) {
      components.push(`\nCurrent task: ${context.workingMemory.currentTask}`);
    }
    if (context.lastUserUtterance) {
      components.push(`Previous exchange: "${context.lastUserUtterance}"`);
      components.push(`You responded: "${context.lastJarvisResponse}"`);
    }

    // Relevant semantic facts
    const relevantFacts = this.extractRelevantFacts(utterance);
    if (relevantFacts.length > 0) {
      components.push(`\nKnown facts:`);
      relevantFacts.forEach((fact) => {
        components.push(`  - ${fact.fact}`);
      });
    }

    // Relevant procedures
    const relevantProcedures = this.extractRelevantProcedures(utterance);
    if (relevantProcedures.length > 0) {
      components.push(`\nRelevant procedures:`);
      relevantProcedures.forEach((proc) => {
        components.push(`  - ${proc}`);
      });
    }

    // Current request
    components.push(`\nUser said: "${utterance}"`);
    components.push(`Detected intention: ${intention}`);

    return components.join("\n");
  }

  /**
   * Extract facts from memory relevant to current utterance
   */
  private extractRelevantFacts(
    utterance: string
  ): Array<{ fact: string; confidence: number }> {
    const relevant: Array<{ fact: string; confidence: number }> = [];
    const lowerUtterance = utterance.toLowerCase();

    for (const [key, value] of this.memory.semanticFacts) {
      if (lowerUtterance.includes(key.toLowerCase())) {
        relevant.push({
          fact: value.fact,
          confidence: value.confidence,
        });
      }
    }

    return relevant.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
  }

  /**
   * Extract procedures from memory relevant to current utterance
   */
  private extractRelevantProcedures(utterance: string): string[] {
    const relevant: string[] = [];
    const lowerUtterance = utterance.toLowerCase();

    for (const [key, value] of this.memory.procedures) {
      if (lowerUtterance.includes(key.toLowerCase())) {
        relevant.push(`${key}: ${value.steps.join(" → ")}`);
      }
    }

    return relevant.slice(0, 3);
  }

  /**
   * Check for a persistent, verified cached answer to this utterance.
   *
   * Delegates to the shared episode cache (core/episode-cache.ts) instead
   * of scanning the in-process `this.memory.episodes` array: that array is
   * wiped every restart and its old matching (first-10-characters prefix
   * overlap) was crude enough to conflate unrelated questions that happen
   * to start the same way. The persistent cache instead requires real
   * token-similarity plus an LLM-verified "still true" check, and survives
   * restarts.
   */
  private async checkMemoryCache(utterance: string): Promise<string | null> {
    return findCachedAnswer(utterance, this.modelProvider);
  }

  /**
   * Create streaming response from cached text
   */
  private createStreamFromText(
    text: string,
    source: string
  ): StreamingResponse {
    const tokens = this.tokenize(text);
    const response: StreamingResponse = {
      id: `stream-${Date.now()}`,
      text,
      tokens,
      isComplete: false,
      confidence: 0.95,
      startTime: new Date(),
      totalTokens: tokens.length,
      cancel: () => {
        /* no-op for cached response */
      },
    };

    // Simulate token arrival
    setImmediate(() => {
      response.isComplete = true;
    });

    return response;
  }

  /**
   * Stream response from model (placeholder for real streaming)
   */
  private async streamFromModel(
    prompt: string,
    model: { model: string; provider: string; config: Record<string, unknown> },
    originalUtterance: string
  ): Promise<StreamingResponse> {
    const response: StreamingResponse = {
      id: `stream-${Date.now()}`,
      text: "",
      tokens: [],
      isComplete: false,
      confidence: 0.8,
      startTime: new Date(),
      totalTokens: 0,
      cancel: () => {
        response.isComplete = true;
      },
    };

    this.currentStream = response;

    // In production: stream from LLM
    // For now: simulate streaming
    const mockResponse = `I understand you'd like to ${originalUtterance.substring(0, 20)}. Let me help with that.`;
    const tokens = this.tokenize(mockResponse);

    // Simulate token-by-token arrival
    let tokenIndex = 0;
    const streamInterval = setInterval(() => {
      if (tokenIndex < tokens.length) {
        response.tokens.push(tokens[tokenIndex]);
        response.text += (tokenIndex > 0 ? " " : "") + tokens[tokenIndex];
        response.totalTokens = tokenIndex + 1;
        tokenIndex++;
      } else {
        response.isComplete = true;
        clearInterval(streamInterval);
      }
    }, 50); // 50ms per token ≈ natural speech rate

    return response;
  }

  /**
   * Create streaming response from buffered text
   */
  private async streamFromBuffer(
    prompt: string,
    model: { model: string; provider: string; config: Record<string, unknown> },
    originalUtterance: string
  ): Promise<StreamingResponse> {
    // Non-streaming path: wait for full response, then stream it
    const mockResponse = `I'd be happy to help with that. Let me think about the best approach...`;
    return this.createStreamFromText(mockResponse, "model");
  }

  /**
   * Tokenize text (simplified)
   */
  private tokenize(text: string): string[] {
    return text
      .split(/\s+/)
      .filter((token) => token.length > 0);
  }

  /**
   * Handle interruption with full context awareness
   */
  async handleInterruption(
    newUtterance: string,
    isStreaming: boolean,
    isSpeaking: boolean
  ): Promise<void> {
    const context: InterruptionContext = {
      interruptingUtterance: newUtterance,
      interruptedAt: new Date(),
      wasStreaming: isStreaming,
      wasSpeaking: isSpeaking,
    };

    this.interruptionBuffer.push(context);

    // Cancel current stream
    if (this.currentStream) {
      this.currentStream.cancel();
      this.currentStream = undefined;
    }

    // Process new utterance
    console.log(`\n🔄 Interruption: "${newUtterance}"`);
    await this.conversationEngine.handleInterruption(newUtterance);

    // Record interruption in memory (useful for learning)
    this.recordInterruptionPattern();
  }

  /**
   * Learn from interruption patterns
   */
  private recordInterruptionPattern(): void {
    if (this.interruptionBuffer.length > 5) {
      // Analyze if certain types of responses trigger interruptions
      // This helps JARVIS learn to be more concise or direct in future
    }
  }

  /**
   * PROACTIVE: Check for things to bring up
   *
   * This is what makes JARVIS feel like an intelligent assistant,
   * not just a reactive system.
   */
  async checkProactiveOpportunities(): Promise<string | null> {
    const now = new Date();
    const timeSinceLastCheck = now.getTime() - this.lastProactiveCheck.getTime();

    // Check every 30 seconds during active conversation
    if (timeSinceLastCheck < 30000) {
      return null;
    }

    this.lastProactiveCheck = now;

    // Check each proactive monitor
    for (const [name, checker] of this.proactiveMonitors) {
      const notification = await checker();
      if (notification) {
        console.log(`\n💡 Proactive: ${notification}`);
        return notification;
      }
    }

    return null;
  }

  /**
   * Register proactive monitor
   *
   * Example:
   * registerProactiveMonitor("meeting-soon", async () => {
   *   const calendar = await getCalendar();
   *   if (calendar.nextMeeting < 10 minutes) {
   *     return "You have a meeting in 10 minutes";
   *   }
   *   return null;
   * });
   */
  registerProactiveMonitor(
    name: string,
    checker: () => Promise<string | null>
  ): void {
    this.proactiveMonitors.set(name, checker);
  }

  /**
   * Learn fact from conversation
   */
  recordSemanticFact(key: string, fact: string, confidence: number = 0.9): void {
    this.memory.semanticFacts.set(key, {
      fact,
      confidence,
      learnedAt: new Date(),
    });
    console.log(`   Learned: ${key} = "${fact}"`);
  }

  /**
   * Learn procedure
   */
  recordProcedure(
    name: string,
    steps: string[],
    variations?: Record<string, string[]>
  ): void {
    this.memory.procedures.set(name, {
      steps,
      commonVariations: variations || {},
      frequency: 0,
    });
  }

  /**
   * Record episode in memory
   */
  recordEpisode(
    summary: string,
    entities: string[],
    outcomes: string[],
    importance: number = 0.5
  ): void {
    this.memory.episodes.push({
      timestamp: new Date(),
      summary,
      key_entities: entities,
      outcomes,
      importance,
    });

    // Trim oldest episodes if memory gets too large
    if (this.memory.episodes.length > 1000) {
      this.memory.episodes.sort((a, b) => b.importance - a.importance);
      this.memory.episodes = this.memory.episodes.slice(0, 500);
    }
  }

  /**
   * Update user preferences based on observed behavior
   */
  updatePreferences(
    changes: Partial<ConversationMemory["preferences"]>
  ): void {
    this.memory.preferences = {
      ...this.memory.preferences,
      ...changes,
    };
    console.log(`   Preferences updated:`, changes);
  }

  /**
   * Get memory status
   */
  getMemoryStatus(): {
    episodesCount: number;
    factsCount: number;
    proceduresCount: number;
    oldestEpisode: Date | null;
  } {
    return {
      episodesCount: this.memory.episodes.length,
      factsCount: this.memory.semanticFacts.size,
      proceduresCount: this.memory.procedures.size,
      oldestEpisode: this.memory.episodes.length > 0
        ? this.memory.episodes[0].timestamp
        : null,
    };
  }

  /**
   * Complete conversation turn with full recording
   */
  completeTurn(
    userUtterance: string,
    jarvisResponse: string,
    actionsTaken?: string[]
  ): void {
    // Record in conversation engine
    this.conversationEngine.recordTurn(
      userUtterance,
      jarvisResponse,
      actionsTaken
    );

    // Extract and record facts
    this.extractAndRecordLearnings(userUtterance, jarvisResponse);
  }

  /**
   * Extract learnings from conversation turn
   */
  private extractAndRecordLearnings(
    userUtterance: string,
    response: string
  ): void {
    // Simple extraction (in production: use NER + relation extraction)
    const timePattern = /(?:every|each)?\s*(morning|evening|day|week|month)/i;
    const timeMatch = userUtterance.match(timePattern);
    if (timeMatch) {
      this.recordSemanticFact(
        `schedule_preference_${timeMatch[1].toLowerCase()}`,
        `User prefers to handle this ${timeMatch[1].toLowerCase()}`,
        0.7
      );
    }

    // Record the episode
    const entities = this.extractEntities(userUtterance);
    this.recordEpisode(
      `User asked: ${userUtterance.substring(0, 50)}`,
      entities,
      ["responded"],
      0.6
    );

    // Persist the full question/answer pair for future cache lookups —
    // recordEpisode above only keeps a truncated summary in the in-process
    // array, which was never enough to actually answer a repeat question
    // from. No-ops for action requests / time-dependent questions.
    void recordCacheableEpisode(userUtterance, response);
  }

  /**
   * Extract entities from text (simplified)
   */
  private extractEntities(text: string): string[] {
    const entities: string[] = [];
    const patterns = [
      /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*/g, // Names
      /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g, // Days
    ];

    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) {
        entities.push(...matches);
      }
    }

    return [...new Set(entities)]; // Deduplicate
  }

  /**
   * Get conversation status
   */
  getStatus(): {
    engineStatus: ReturnType<ConversationEngine["getStatus"]>;
    memoryStatus: ReturnType<ConversationalIntelligence["getMemoryStatus"]>;
    currentStream: boolean;
    interruptionsRecorded: number;
    proactiveMonitorsActive: number;
  } {
    return {
      engineStatus: this.conversationEngine.getStatus(),
      memoryStatus: this.getMemoryStatus(),
      currentStream: !!this.currentStream && !this.currentStream.isComplete,
      interruptionsRecorded: this.interruptionBuffer.length,
      proactiveMonitorsActive: this.proactiveMonitors.size,
    };
  }
}
