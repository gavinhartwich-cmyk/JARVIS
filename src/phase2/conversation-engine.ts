/**
 * Phase 2.5: Conversation Engine
 *
 * Core conversational intelligence layer that makes JARVIS feel like
 * a persistent assistant rather than an isolated request handler.
 *
 * This is NOT a LLM wrapper. This is a system layer that manages
 * conversation state, memory, context, and routing INDEPENDENTLY
 * from the underlying model provider.
 */

export type ConversationState = 
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "executing"
  | "waiting_for_user"
  | "error";

export interface ConversationTurn {
  timestamp: Date;
  userUtterance: string;
  userIntention?: string;
  jarvisResponse: string;
  actionsTaken?: string[];
  confidence: number;
  memory?: { episodic: string; semantic: string };
}

export interface WorkingMemory {
  // Current conversation context
  recentTurns: ConversationTurn[];
  currentTopic: string;
  currentTask?: string;
  
  // Reference resolution
  recentEntities: Map<string, unknown>;
  pronounReferents: Map<string, string>; // "that" → "calendar event"
  
  // State
  pendingActions: string[];
  recentDecisions: Array<{ decision: string; timestamp: Date }>;
  
  // Context
  temporaryContext: Record<string, unknown>;
}

export interface ConversationContext {
  workingMemory: WorkingMemory;
  state: ConversationState;
  lastUserUtterance: string;
  lastJarvisResponse: string;
  conversationId: string;
  sessionStartTime: Date;
  turnCount: number;
}

export interface ReasoningPath {
  type: "fast" | "main" | "deep" | "deterministic";
  costEstimate: "low" | "medium" | "high";
  latency: "immediate" | "fast" | "moderate" | "variable";
  description: string;
}

/**
 * Conversation Engine
 *
 * Independent from LLM provider, voice system, or storage backend.
 * Manages conversation state, context, memory, and routing.
 */
export class ConversationEngine {
  private state: ConversationState = "idle";
  private workingMemory: WorkingMemory;
  private conversationHistory: ConversationTurn[] = [];
  private conversationId: string;
  private sessionStartTime: Date = new Date();
  private turnCount: number = 0;

  // Interruption state
  private isCurrentlySpeaking: boolean = false;
  private currentSpeechCancellationToken?: AbortController;

  // Personality rules
  private personalityRules: PersonalityRules;

  constructor() {
    console.log("\n🧠 Conversation Engine initialized");
    console.log("   Role: Persistent conversational assistant");
    console.log("   Independence: Model-agnostic");
    
    this.conversationId = `conv-${Date.now()}`;
    this.workingMemory = this.initializeWorkingMemory();
    this.personalityRules = new PersonalityRules();
    
    this.setState("idle");
  }

  /**
   * Initialize working memory for new conversation
   */
  private initializeWorkingMemory(): WorkingMemory {
    return {
      recentTurns: [],
      currentTopic: "",
      currentTask: undefined,
      recentEntities: new Map(),
      pronounReferents: new Map(),
      pendingActions: [],
      recentDecisions: [],
      temporaryContext: {},
    };
  }

  /**
   * Set conversation state
   */
  setState(newState: ConversationState) {
    const oldState = this.state;
    this.state = newState;
    
    if (oldState !== newState) {
      console.log(`   [${oldState}] → [${newState}]`);
    }
  }

  /**
   * Get current state
   */
  getState(): ConversationState {
    return this.state;
  }

  /**
   * User begins speaking (wake word detected or explicit attention)
   */
  async beginListening(): Promise<void> {
    console.log("\n🎤 Listening...");
    this.setState("listening");
  }

  /**
   * User speech received
   *
   * Processes the raw utterance before routing to reasoning.
   */
  async processUserUtterance(utterance: string): Promise<{
    intention: string;
    requiresContext: boolean;
    reasoningPath: ReasoningPath;
  }> {
    console.log(`\n👤 User: "${utterance}"`);
    this.setState("thinking");

    // Step 1: Resolve references
    const resolved = this.resolveReferences(utterance);
    console.log(`   Resolved: "${resolved}"`);

    // Step 2: Detect intention
    const intention = this.detectIntention(resolved);
    console.log(`   Intention: ${intention}`);

    // Step 3: Track entities
    this.extractAndTrackEntities(resolved);

    // Step 4: Determine reasoning path
    const reasoningPath = this.selectReasoningPath(intention, resolved);
    console.log(`   Path: ${reasoningPath.type} (${reasoningPath.costEstimate})`);

    // Step 5: Assemble context
    const context = this.assembleContext(intention, resolved);

    return {
      intention,
      requiresContext: true,
      reasoningPath,
    };
  }

  /**
   * Resolve pronouns and references
   *
   * "Move that to Thursday" → Determine what "that" refers to
   * "Open it" → What does "it" refer to?
   * "Tell him" → Who is "him"?
   */
  private resolveReferences(utterance: string): string {
    let resolved = utterance;

    // Reference patterns
    const referencePatterns = [
      { pattern: /\bthat\b/, resolve: () => this.resolveReference("that") },
      { pattern: /\bit\b/, resolve: () => this.resolveReference("it") },
      { pattern: /\bhim\b/, resolve: () => this.resolveReference("him") },
      { pattern: /\bher\b/, resolve: () => this.resolveReference("her") },
      { pattern: /\bthere\b/, resolve: () => this.resolveReference("there") },
      { pattern: /\bthe one/i, resolve: () => this.resolveReference("the one") },
    ];

    for (const { pattern, resolve } of referencePatterns) {
      if (pattern.test(resolved)) {
        const referent = resolve();
        if (referent) {
          console.log(`      "${pattern.source}" → "${referent}"`);
          resolved = resolved.replace(pattern, referent);
        }
      }
    }

    return resolved;
  }

  /**
   * Resolve a single reference
   */
  private resolveReference(pronoun: string): string | null {
    // Check pronoun map first
    if (this.workingMemory.pronounReferents.has(pronoun)) {
      return this.workingMemory.pronounReferents.get(pronoun) || null;
    }

    // Fall back to recent context
    if (this.workingMemory.recentTurns.length > 0) {
      const lastTurn = this.workingMemory.recentTurns[
        this.workingMemory.recentTurns.length - 1
      ];
      
      if (pronoun === "that" || pronoun === "it") {
        // Find the most recent noun in last response
        const nouns = this.extractNouns(lastTurn.jarvisResponse);
        return nouns[0] || null;
      }
    }

    return null;
  }

  /**
   * Extract nouns from text (simplified)
   */
  private extractNouns(text: string): string[] {
    // Simplified noun extraction - in production would use NLP library
    //
    // BUG FIX (2026-08-28, full-codebase review): this used to treat ANY
    // capitalized word as a "noun," including the sentence-initial word
    // of an ordinary English sentence (always capitalized regardless of
    // part of speech — "The meeting is at 3pm" -> "The") and the pronoun
    // "I". This feeds directly into live pronoun resolution:
    // resolveReference() -> extractNouns(lastJarvisResponse) ->
    // updatePronounReferents() sets pronounReferents.set("that", "The"),
    // so the user's next turn "cancel that" got rewritten to "cancel The"
    // before intention detection / the LLM ever saw it — corrupting real
    // conversational turns (this path is genuinely reachable via `bun run
    // dev conversation`), not just a theoretical edge case. Now tracks
    // sentence boundaries (a word immediately following [.!?]-terminated
    // punctuation, or the very first word, is sentence-initial and
    // skipped) and excludes the standalone pronoun "I".
    const words = text.split(/\s+/);
    const nouns: string[] = [];
    let sentenceStart = true;

    for (const word of words) {
      const isSentenceStart = sentenceStart;
      sentenceStart = /[.!?]$/.test(word);

      if (isSentenceStart) continue;
      // Very simple heuristic: capitalized words are likely proper nouns
      if (/^[A-Z]/.test(word)) {
        const cleaned = word.replace(/[.,!?;:]/g, "");
        if (cleaned && cleaned !== "I") {
          nouns.push(cleaned);
        }
      }
    }

    return nouns;
  }

  /**
   * Detect user intention from utterance
   */
  private detectIntention(utterance: string): string {
    const lower = utterance.toLowerCase();

    // Question detection
    if (lower.match(/^\s*(what|when|where|who|why|how)/)) {
      return "question";
    }

    // Command detection
    if (lower.match(/^(open|close|click|type|send|save|delete|create)/)) {
      return "command";
    }

    // Request detection
    if (lower.match(/^(can you|could you|would you|will you|please)/i)) {
      return "request";
    }

    // BUG FIX (2026-08-28, full-codebase review): "correction" and
    // "conversational" both matched utterances starting with "no", and
    // since this function returns on first match, "correction" was
    // unreachable for that entire class of input when checked second —
    // e.g. "No, actually I meant Thursday" was always classified
    // "conversational". Correction is now checked first, with its "no"
    // branch tightened to require something after it (a comma or more
    // words) so a bare "no"/"no." reply — genuinely conversational, not a
    // correction — still falls through to the conversational check below
    // exactly as before. (Currently low practical impact: nothing
    // downstream — selectReasoningPath()/model-router.ts — differentiates
    // on "correction" today, so this only fixes the classification
    // itself, not yet any behavior built on it.)
    if (lower.match(/^(no\s*,|no\s+(actually|wait)\b|actually|wait|hold on|change that)/i)) {
      return "correction";
    }

    // Conversational detection
    if (lower.match(/^(yes|no|ok|sure|thanks|hello|hi)/i)) {
      return "conversational";
    }

    // Default: general conversation
    return "statement";
  }

  /**
   * Extract entities from utterance
   */
  private extractAndTrackEntities(utterance: string): void {
    // In production: use NER (Named Entity Recognition)
    // For now: simple pattern matching

    const patterns = [
      { pattern: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g, type: "person" },
      { pattern: /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g, type: "day" },
      { pattern: /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/g, type: "month" },
    ];

    for (const { pattern, type } of patterns) {
      const matches = utterance.match(pattern);
      if (matches) {
        for (const match of matches) {
          this.workingMemory.recentEntities.set(match, { type, mentioned: new Date() });
        }
      }
    }
  }

  /**
   * Select appropriate reasoning path
   */
  private selectReasoningPath(
    intention: string,
    utterance: string
  ): ReasoningPath {
    const lower = utterance.toLowerCase();

    // Fast path: simple interactions
    if (intention === "conversational" || intention === "question") {
      if (lower.length < 20) {
        return {
          type: "fast",
          costEstimate: "low",
          latency: "immediate",
          description: "Simple greeting or short question",
        };
      }
    }

    // Deterministic path: system operations
    if (intention === "command") {
      if (
        lower.match(/^(turn|open|close|click|type|save|delete)/) &&
        !lower.includes("analyze") &&
        !lower.includes("research")
      ) {
        return {
          type: "deterministic",
          costEstimate: "low",
          latency: "fast",
          description: "Direct system operation",
        };
      }
    }

    // Deep reasoning path: complex tasks
    if (
      lower.match(/^(plan|design|analyze|research|create|build|debug|optimize)/)
    ) {
      return {
        type: "deep",
        costEstimate: "high",
        latency: "moderate",
        description: "Complex reasoning required",
      };
    }

    // Main path: default for most requests
    return {
      type: "main",
      costEstimate: "medium",
      latency: "fast",
      description: "Standard reasoning",
    };
  }

  /**
   * Assemble context for reasoning
   *
   * This is CRITICAL: Do not blindly send entire history.
   * Dynamically assemble only relevant context.
   */
  private assembleContext(intention: string, utterance: string): string {
    const components: string[] = [];

    // Component 1: Current task/topic
    if (this.workingMemory.currentTask) {
      components.push(`Current task: ${this.workingMemory.currentTask}`);
    }
    if (this.workingMemory.currentTopic) {
      components.push(`Current topic: ${this.workingMemory.currentTopic}`);
    }

    // Component 2: Recent conversation (last 2-3 turns, not entire history)
    if (this.workingMemory.recentTurns.length > 0) {
      const relevantTurns = this.workingMemory.recentTurns.slice(-2);
      components.push(
        `Recent: ${relevantTurns.map((t) => `U: "${t.userUtterance}", A: "${t.jarvisResponse}"`).join(" | ")}`
      );
    }

    // Component 3: Pending actions
    if (this.workingMemory.pendingActions.length > 0) {
      components.push(`Pending: ${this.workingMemory.pendingActions.join(", ")}`);
    }

    // Component 4: Recent entities (relevant to current utterance)
    const mentionedEntities = Array.from(
      this.workingMemory.recentEntities.keys()
    ).filter((entity) => utterance.includes(entity));
    if (mentionedEntities.length > 0) {
      components.push(`Entities: ${mentionedEntities.join(", ")}`);
    }

    return components.join("\n");
  }

  /**
   * Begin reasoning (streaming if available)
   *
   * Do not wait for full response before starting TTS
   */
  async beginStreaming(
    model: { name: string; provider: string },
    prompt: string
  ): Promise<{
    streamToken: () => Promise<string | null>;
    cancel: () => void;
  }> {
    console.log(`\n💭 Reasoning (${model.provider})`);
    this.setState("thinking");

    // Note: Real implementation would stream from LLM
    // For now: prepare for streaming
    const abortController = new AbortController();

    return {
      streamToken: async () => {
        // Each call returns next token or null when done
        // In production: yield from LLM stream
        return null;
      },
      cancel: () => {
        abortController.abort();
        this.setState("interrupted");
      },
    };
  }

  /**
   * Start speaking response
   */
  async startSpeaking(text: string): Promise<{
    cancel: () => void;
  }> {
    console.log(`\n🔊 Jarvis: "${text.substring(0, 80)}..."`);
    this.setState("speaking");
    this.isCurrentlySpeaking = true;
    this.currentSpeechCancellationToken = new AbortController();

    return {
      cancel: () => {
        this.isCurrentlySpeaking = false;
        this.currentSpeechCancellationToken?.abort();
        this.setState("interrupted");
        console.log(`   [Speech cancelled]`);
      },
    };
  }

  /**
   * Handle interruption (user speaks while JARVIS is speaking)
   *
   * This is CRITICAL for natural interaction.
   */
  async handleInterruption(newUtterance: string): Promise<void> {
    console.log(`\n🔄 Interruption detected`);
    
    if (this.isCurrentlySpeaking) {
      this.currentSpeechCancellationToken?.abort();
      this.isCurrentlySpeaking = false;
      console.log(`   Cancelled current response`);
    }

    // Cancel pending reasoning
    console.log(`   Discarding previous request`);

    // Process new request
    this.setState("listening");
    const result = await this.processUserUtterance(newUtterance);
    console.log(`   Processing new request: "${result.intention}"`);
  }

  /**
   * Detect natural turn end
   *
   * CRITICAL: Distinguish between:
   * - Natural pause (wait)
   * - Hesitation (wait)
   * - Sentence break (wait)
   * - End of request (respond)
   */
  async detectTurnEnd(
    audioStream: { isSilent: boolean; silenceDurationMs: number }
  ): Promise<boolean> {
    // Minimum silence required: 500ms
    // But check for sentence-ending cues

    // BUG FIX (2026-08-28, full-codebase review): the doc comment above
    // ("Minimum silence required: 500ms") and this first guard both say
    // 500ms is the real threshold, but the two branches below only
    // returned true for >=1000ms or >=3000ms — the 500-999ms range fell
    // through both and hit the final `return false`, silently
    // contradicting the function's own stated contract. No caller
    // exercises this yet (the real-mic pipeline it supports doesn't exist
    // in this codebase yet), so this was latent rather than live, but
    // fixed to match the documented 500ms threshold before anything gets
    // wired up to it.
    if (audioStream.silenceDurationMs < 500) {
      return false; // Too short, likely a pause
    }

    return true; // >= 500ms silence: treat as end of turn
  }

  /**
   * Record completed turn
   */
  recordTurn(
    userUtterance: string,
    jarvisResponse: string,
    actionsTaken?: string[]
  ): void {
    this.turnCount++;

    const turn: ConversationTurn = {
      timestamp: new Date(),
      userUtterance,
      jarvisResponse,
      actionsTaken,
      confidence: 0.85, // Would be calculated from reasoning
    };

    this.workingMemory.recentTurns.push(turn);
    this.conversationHistory.push(turn);

    // Keep working memory size manageable (last 10 turns)
    if (this.workingMemory.recentTurns.length > 10) {
      this.workingMemory.recentTurns.shift();
    }

    // Update pronouns for next turn
    this.updatePronounReferents(userUtterance, jarvisResponse);
  }

  /**
   * Update pronoun referents after a turn
   */
  private updatePronounReferents(userUtterance: string, response: string): void {
    // Extract the main noun from the response to use for future "that" references
    const nouns = this.extractNouns(response);
    if (nouns.length > 0) {
      this.workingMemory.pronounReferents.set("that", nouns[0]);
      this.workingMemory.pronounReferents.set("it", nouns[0]);
    }
  }

  /**
   * Update current task
   */
  setCurrentTask(task: string): void {
    this.workingMemory.currentTask = task;
    console.log(`   Task: "${task}"`);
  }

  /**
   * Add pending action
   */
  addPendingAction(action: string): void {
    this.workingMemory.pendingActions.push(action);
  }

  /**
   * Mark action as complete
   */
  completePendingAction(action: string): void {
    const index = this.workingMemory.pendingActions.indexOf(action);
    if (index > -1) {
      this.workingMemory.pendingActions.splice(index, 1);
    }
  }

  /**
   * Get context for reasoning
   */
  getReasoningContext(): string {
    return this.assembleContext("general", "");
  }

  /**
   * Get conversation context
   */
  getConversationContext(): ConversationContext {
    return {
      workingMemory: this.workingMemory,
      state: this.state,
      lastUserUtterance:
        this.workingMemory.recentTurns.length > 0
          ? this.workingMemory.recentTurns[
              this.workingMemory.recentTurns.length - 1
            ].userUtterance
          : "",
      lastJarvisResponse:
        this.workingMemory.recentTurns.length > 0
          ? this.workingMemory.recentTurns[
              this.workingMemory.recentTurns.length - 1
            ].jarvisResponse
          : "",
      conversationId: this.conversationId,
      sessionStartTime: this.sessionStartTime,
      turnCount: this.turnCount,
    };
  }

  /**
   * Get conversation history (for memory storage)
   */
  getConversationHistory(): ConversationTurn[] {
    return this.conversationHistory;
  }

  /**
   * End conversation
   */
  endConversation(): void {
    console.log(`\n👋 Conversation ended (${this.turnCount} turns)`);
    this.setState("idle");
  }

  /**
   * Get status
   */
  getStatus(): {
    state: ConversationState;
    turnCount: number;
    sessionDuration: number;
    currentTask: string | undefined;
    recentTurnsCount: number;
    pendingActionsCount: number;
  } {
    const now = new Date();
    const sessionDuration = now.getTime() - this.sessionStartTime.getTime();

    return {
      state: this.state,
      turnCount: this.turnCount,
      sessionDuration,
      currentTask: this.workingMemory.currentTask,
      recentTurnsCount: this.workingMemory.recentTurns.length,
      pendingActionsCount: this.workingMemory.pendingActions.length,
    };
  }
}

/**
 * Personality Rules
 *
 * Distinct from LLM. Defines JARVIS's behavioral identity.
 * Can be applied regardless of underlying model.
 */
export class PersonalityRules {
  private tone: "professional" | "casual" | "technical" = "casual";
  private formality: "formal" | "neutral" | "casual" = "neutral";
  private conciseness: "brief" | "moderate" | "detailed" = "moderate";
  private humor: boolean = true;
  private proactivity: "passive" | "balanced" | "proactive" = "balanced";

  constructor() {
    // Default personality: like the movie JARVIS
    // Professional but warm, helpful but not obsequious
  }

  /**
   * Apply personality rules to response
   */
  applyPersonality(response: string): string {
    // Adjust formality
    if (this.formality === "formal") {
      response = response.replace(/\bcan't\b/g, "cannot");
      response = response.replace(/\bwon't\b/g, "will not");
    }

    // Adjust tone
    if (this.tone === "technical") {
      // Remove casual language
      response = response.replace(/\bthing\b/g, "item");
      response = response.replace(/\bstuff\b/g, "material");
    }

    // Ensure appropriate length based on conciseness
    if (this.conciseness === "brief") {
      const sentences = response.split(/[.!?]+/);
      if (sentences.length > 3) {
        response = sentences.slice(0, 2).join(". ") + ".";
      }
    }

    return response;
  }

  /**
   * Determine when to challenge user
   */
  shouldChallenge(statement: string): boolean {
    // Movie JARVIS would gently challenge illogical requests
    // This is a simple placeholder
    return false;
  }

  /**
   * Determine when to remain silent
   */
  shouldBeQuiet(): boolean {
    // Sometimes the best response is no response
    return false;
  }

  /**
   * Communicate uncertainty
   */
  expressUncertainty(confidence: number): string {
    if (confidence > 0.9) {
      return "";
    } else if (confidence > 0.7) {
      return "I believe that ";
    } else if (confidence > 0.5) {
      return "It's possible that ";
    } else {
      return "I'm uncertain, but ";
    }
  }
}
