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
import type { ModelProvider } from "../models/types";
import { JARVIS_PERSONALITY_PROMPT } from "./jarvis-personality";

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
 * The real, already-happened result of an action JARVIS took before
 * generating this reply — e.g. `Orchestrator.parseAppControlIntent()`
 * detecting "open Spotify" and actually calling `ScreenControl.openApp()`
 * ahead of the LLM call. Added 2026-08-27 (Gavin: "when something like
 * that is asked it [should] complete the task and stay conversational...
 * it needs to be proactive not reactive"). The point of passing this in
 * as *outcome*, not *intent* — the action has already run by the time the
 * LLM sees it — is so the reply is grounded in what genuinely happened
 * (including a genuine failure) instead of the model guessing or, worse,
 * confidently claiming success it never verified.
 */
export interface ActionOutcome {
  description: string; // e.g. `Open "Spotify"`
  success: boolean;
  detail: string; // human-readable result text, or the error if it failed
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

  constructor(engine: ConversationEngine, router: ModelRouter, modelProvider: ModelProvider) {
    this.conversationEngine = engine;
    this.modelRouter = router;
    this.modelProvider = modelProvider;
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
        // [UPDATE 2026-08-31] Was "casual" - directly contradicted the
        // real personality spec (JARVIS is "slightly formal" per Gavin's
        // movie-JARVIS characterization, not casual). Formality is now a
        // fixed part of JARVIS's character (see jarvis-personality.ts),
        // not a per-user adaptive dial, so this default just needs to
        // stop actively fighting it - see assemblePrompt() below, which
        // no longer surfaces this field to the model at all.
        formality: "formal",
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
    utterance: string,
    actionOutcome?: ActionOutcome,
    visionContext?: string
  ): Promise<StreamingResponse> {
    // Phase 1: Conversation Engine preprocessing
    const { intention, reasoningPath } = await this.conversationEngine.processUserUtterance(
      utterance
    );

    // Phase 2: Select model based on reasoning path
    const context = this.conversationEngine.getConversationContext();
    const model = this.modelRouter.selectModel(intention, reasoningPath, context);

    // Phase 3: Assemble complete prompt with memory
    const prompt = this.assemblePrompt(utterance, intention, context, actionOutcome, visionContext);

    // Phase 4: Check if we can use cached response
    // Never serve a cached reply when a real action was just taken, or a
    // real screen was just looked at — a stale cached line has no idea
    // Spotify just opened (or failed to) or what's actually on screen
    // right now, and would contradict what actually happened.
    if (!actionOutcome && !visionContext && this.modelRouter.shouldUseCache(context)) {
      const cached = this.checkMemoryCache(utterance);
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
    context: ConversationContext,
    actionOutcome?: ActionOutcome,
    visionContext?: string
  ): string {
    const components: string[] = [];

    // System prompt segment - [UPDATE 2026-08-31] was a generic one-liner
    // ("You are JARVIS, a persistent conversational AI assistant.") with
    // zero actual personality direction. Now uses the real, shared
    // movie-JARVIS spec (see jarvis-personality.ts) - the same text every
    // other system prompt in this codebase uses, so personality is
    // consistent regardless of which path generated the reply.
    components.push(JARVIS_PERSONALITY_PROMPT);
    components.push(`You maintain continuous conversation state across interactions.`);

    // Real action outcome, if one was taken before this reply was
    // generated (e.g. "open Spotify" → ScreenControl actually ran it).
    // This section exists specifically so JARVIS reports what genuinely
    // happened instead of guessing or promising to do something it
    // already either did or failed to do.
    if (actionOutcome) {
      if (actionOutcome.success) {
        components.push(
          `\nYou just took a real action, before generating this reply: ${actionOutcome.description} — it succeeded.`
        );
        components.push(
          `Confirm this briefly and naturally in past/present tense (it's already done, don't say "I will..."). ` +
            `Be proactive, not just reactive: if there's an obvious, natural next question for this kind of app or ` +
            `action (e.g. a music app → what to play; a browser → what to search; a document/notes app → what to ` +
            `write or open), ask it in the same reply. If there's no obvious follow-up, just confirm naturally — ` +
            `don't force one.`
        );
      } else {
        components.push(
          `\nYou just attempted a real action, before generating this reply: ${actionOutcome.description} — it FAILED. ` +
            `Reason: ${actionOutcome.detail}`
        );
        components.push(
          `Be honest about this. Do not claim it succeeded or that you're doing it now. Briefly say it didn't work, ` +
            `and if the reason suggests something the user could fix (e.g. the app isn't installed, or isn't a ` +
            `recognized name), mention that naturally.`
        );
      }
    }

    // Real, live vision result, if the user's utterance triggered one -
    // either screen vision (orchestrator.ts's parseScreenVisionIntent()/
    // classifyScreenVisionIntent(), a real screenshot analyzed via
    // OllamaVisionProvider) or video understanding (parseVideoIntent()/
    // executeVideoIntent(), real ffmpeg-sampled frames each analyzed the
    // same way — see video-analyzer.ts). Generic wording here on purpose:
    // visionContext's own content already says what was actually looked
    // at ("Screen description: ..." vs. "Video analysis (N frames over
    // Ts): ..."), so this wrapper doesn't need to assume which. Mirrors
    // the actionOutcome pattern above: ground the reply in what JARVIS
    // genuinely just perceived instead of letting the model guess or
    // claim it can't see/watch anything.
    if (visionContext) {
      components.push(
        `\nYou just used real vision (screen capture and/or video frame sampling, analyzed just now, whichever ` +
          `applies below) to help answer this. What you saw:\n${visionContext}`
      );
      components.push(
        `Answer using what you actually saw above. Speak naturally as if you genuinely looked/watched — don't ` +
          `mention "screenshot"/"frames"/"vision provider" mechanics, just answer like you can see it, because ` +
          `you can. If the description leaves something genuinely ambiguous, say so honestly rather than guessing.`
      );
    }

    // Response-shape preferences - [UPDATE 2026-08-31] dropped the
    // "Formality" line entirely: formality is now fixed by JARVIS's
    // character (jarvis-personality.ts above), not a separate adaptive
    // dial that could contradict it. communicationStyle/responseTime are
    // kept - "brief vs. detailed" and "immediate vs. thoughtful" are
    // real, compatible personalization axes that don't fight the voice.
    const prefs = this.memory.preferences;
    components.push(`\nCommunication Style: ${prefs.communicationStyle}`);
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
   * Check if response exists in episodic memory
   */
  private checkMemoryCache(utterance: string): string | null {
    const lowerUtterance = utterance.toLowerCase();

    // Look for similar episodes
    for (const episode of this.memory.episodes) {
      const summary = episode.summary.toLowerCase();
      if (summary.includes(lowerUtterance.substring(0, 10))) {
        // Simple similarity check
        return `Based on what happened before: ${episode.summary}`;
      }
    }

    return null;
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
   * Call the real model provider (same LLMGateway everything else in
   * JARVIS uses — OmniRoute → Ollama → Gemini → OpenRouter, per
   * src/models/llm-gateway.ts) with the assembled conversational prompt.
   *
   * Previously this whole layer returned hardcoded strings like "I
   * understand you'd like to <first 20 chars>..." regardless of what was
   * actually said — meaning Phase 1.5 was wired up (constructed, methods
   * called from orchestrator.ts) but not functionally real: no reasoning,
   * no LLM call, ever. Fixed 2026-08-27 to match how Phase 0 (BaseAgent)
   * and Phase 2 (voice-interface.ts) already call the real gateway.
   *
   * Two more real bugs fixed 2026-08-27 per Gavin's OmniRoute Routing
   * Directive:
   * 1. `model` — the tier `IntelligentModelRouter.selectModel()` already
   *    picked (fast/main/deep/deterministic/creative, each with its own
   *    temperature/maxTokens) — was passed into this call chain from
   *    `processWithStreaming()` but silently discarded here in favor of a
   *    single hardcoded {temperature: 0.7, maxTokens: 800} for every
   *    request. That's the opposite of "capability-aware": a "fast" reply
   *    and a "deep reasoning" one got identical model settings. Now the
   *    selected config is actually used.
   * 2. No try/catch here meant that once the gateway exhausted every
   *    provider (see llm-gateway.ts's generate() cascade), the raw error
   *    propagated straight up through processWithStreaming() →
   *    processConversation() → cli.ts's "conversation" command with no
   *    handler in between — a raw stack trace instead of JARVIS staying
   *    conversational. Now caught here and turned into the same clean,
   *    honest fallback line voice-interface.ts already uses.
   */
  private async callModel(
    prompt: string,
    originalUtterance: string,
    model: { model: string; provider: string; config: Record<string, unknown> }
  ): Promise<{ text: string; tokensUsed: number }> {
    const config = model.config as { temperature?: number; maxTokens?: number };
    try {
      const response = await this.modelProvider.complete(
        [
          { role: "system", content: prompt },
          { role: "user", content: originalUtterance },
        ],
        {
          temperature: config.temperature ?? 0.7,
          maxTokens: config.maxTokens ?? 800,
          provider: model.provider,
          model: model.model,
        }
      );
      return { text: response.content, tokensUsed: response.tokensUsed };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      console.error("❌ Conversational model call failed (all providers exhausted):", err);
      // [UPDATE 2026-08-31] In-character fallback text, not a generic
      // apology - this is the one line JARVIS says without any LLM
      // behind it at all, so it's hand-written rather than generated.
      return { text: "I'm afraid none of my model providers are reachable at the moment, sir.", tokensUsed: 0 };
    }
  }

  /**
   * Stream response from model.
   *
   * Honestly labeled like Phase 2's TTS/STT classes: this drips out an
   * already-complete real response token-by-token for a natural-feeling
   * cadence, rather than true incremental generation — a persistent-stream
   * rework (consuming ModelProvider.stream()) is the next step once
   * real-time latency actually matters, same as noted for Phase 2.
   *
   * REAL BUG, found and fixed 2026-08-27 (Gavin: "I want it to work
   * fully"): this function used to return `response` right after starting
   * the drip-out `setInterval`, while `response.text` was still `""` —
   * nothing awaited the drip finishing. Its only real caller today,
   * `Orchestrator.processConversation()`, reads `stream.text`
   * synchronously the moment this promise resolves (there's no live
   * consumer of the incremental `.tokens` frames yet — see the comment
   * above), so every conversational reply that took the streaming path
   * (the default — see `IntelligentModelRouter.shouldStream()`) came back
   * as an empty string. The action side of app-control still worked (it
   * runs before this is even called), which is exactly why Notepad kept
   * opening/closing for real while JARVIS's own spoken/printed reply text
   * was silently blank. Fixed by awaiting the drip's completion before
   * resolving, so the promise this function returns actually means "the
   * full response is ready" for its current synchronous caller — the
   * token-by-token pacing itself is unchanged, for whenever a real
   * incremental consumer exists.
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

    const { text: realResponse } = await this.callModel(prompt, originalUtterance, model);
    const tokens = this.tokenize(realResponse);

    // Drip out the real response token-by-token at a natural speech rate —
    // and WAIT for the drip to finish before this function returns (see
    // the bug note above). If nothing has flagged completion externally,
    // finishing the drip resolves this on its own.
    await new Promise<void>((resolve) => {
      let tokenIndex = 0;
      const streamInterval = setInterval(() => {
        if (response.isComplete) {
          clearInterval(streamInterval);
          resolve();
          return;
        }
        if (tokenIndex < tokens.length) {
          response.tokens.push(tokens[tokenIndex]);
          response.text += (tokenIndex > 0 ? " " : "") + tokens[tokenIndex];
          response.totalTokens = tokenIndex + 1;
          tokenIndex++;
        } else {
          response.isComplete = true;
          clearInterval(streamInterval);
          resolve();
        }
      }, 50); // 50ms per token ≈ natural speech rate
    });

    return response;
  }

  /**
   * Create streaming response from a real (non-streamed) model call.
   */
  private async streamFromBuffer(
    prompt: string,
    model: { model: string; provider: string; config: Record<string, unknown> },
    originalUtterance: string
  ): Promise<StreamingResponse> {
    const { text: realResponse } = await this.callModel(prompt, originalUtterance, model);
    return this.createStreamFromText(realResponse, "model");
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
