/**
 * Phase 3: Perception Module
 *
 * Orchestrates screen capture, camera input, vision analysis, and screen control
 * Central hub for understanding and operating the world around JARVIS
 */

import { ScreenCapture, ScreenContext } from "./screen-capture";
import { VisionSystem, VisualAnalysis, VisionProvider } from "./vision-system";
import { OllamaVisionProvider } from "./ollama-vision-provider";
import { ContextRouter, ContextType, RoutingDecision } from "./context-router";
import { ScreenControl, ControlSequence, ControlResult } from "./screen-control";
import { identityEngine, type IdentityResult } from "../core/identity";

export interface PerceptionQuery {
  query: string;
  requiresVisual: boolean;
  requiresControl: boolean;
  contextTypes: ContextType[];
  reasoning: string;
}

export interface PerceptionResult {
  query: string;
  decision: RoutingDecision;
  screenContext?: ScreenContext;
  visualAnalysis?: VisualAnalysis;
  controlResult?: ControlResult;
  answer?: string;
  timestamp: Date;
  processingTimeMs: number;
}

/**
 * Perception Module
 *
 * JARVIS's complete sensory and motor system
 */
export class Perception {
  private screenCapture: ScreenCapture;
  private visionSystem: VisionSystem;
  private contextRouter: ContextRouter;
  private screenControl: ScreenControl;

  private perceptionHistory: PerceptionResult[] = [];
  private queryCache: Map<string, PerceptionResult> = new Map();
  private cachedIdentity: IdentityResult | null = null;

  private async getIdentity(): Promise<IdentityResult> {
    if (!this.cachedIdentity) {
      this.cachedIdentity = await identityEngine.resolveFromDeviceSession();
    }
    return this.cachedIdentity;
  }

  constructor(visionProvider?: VisionProvider) {
    console.log("\n🧠 Perception Module initialized");
    console.log("   Screen capture: ✓");
    console.log("   Vision system: ✓");
    console.log("   Context router: ✓");
    console.log("   Screen control: ✓");
    console.log('   Principle: "Vision should not run unnecessarily"');

    this.screenCapture = new ScreenCapture();
    this.visionSystem = new VisionSystem();
    // Same "default-wire the real provider, allow override for tests"
    // pattern Phase 2's VoiceInterface uses for its LLM gateway. Without
    // this, VisionSystem's real OllamaVisionProvider (verified working in
    // isolation) never actually got connected here — every real perceive()
    // call was silently falling back to the hardcoded office-desk stub.
    this.visionSystem.setProvider(visionProvider || new OllamaVisionProvider());
    this.contextRouter = new ContextRouter();
    this.screenControl = new ScreenControl();
  }

  /**
   * Process a query through the perception pipeline
   */
  async perceive(query: string): Promise<PerceptionResult> {
    const startTime = Date.now();
    console.log(`\n📡 JARVIS Perception: "${query}"`);
    console.log("─".repeat(60));

    // Check cache first
    if (this.queryCache.has(query)) {
      console.log("✓ Using cached perception result");
      return this.queryCache.get(query)!;
    }

    // Step 1: Route the query
    const decision = await this.contextRouter.routeQuery(query);

    // Step 2: Gather context if needed
    let screenContext: ScreenContext | undefined;
    if (decision.requiresScreenCapture) {
      console.log("\n📸 Capturing screen context...");
      screenContext = await this.screenCapture.getScreenContext();
    }

    // Step 3: Analyze visuals if needed
    let visualAnalysis: VisualAnalysis | undefined;
    if (decision.requiresVision && screenContext?.screenshot?.data) {
      console.log("\n👁️  Analyzing visual content...");
      visualAnalysis = await this.visionSystem.analyzeImage(
        screenContext.screenshot.data
      );
    }

    // Step 4: Execute screen control if needed
    let controlResult: ControlResult | undefined;
    if (decision.requiresScreenControl) {
      console.log("\n🖱️  Screen Control activated");
      // Build a control sequence based on the query
      const sequence = this.buildControlSequence(query);
      controlResult = await this.screenControl.executeSequence(sequence, await this.getIdentity());
    }

    // Step 5: Optimize for efficiency
    const optimizedContexts = await this.contextRouter.optimizeForEfficiency(
      decision.primaryContext,
      decision.secondaryContexts
    );

    // Step 6: Generate answer based on available context
    const answer = this.generateAnswer(query, decision, screenContext, visualAnalysis, controlResult);

    const processingTimeMs = Date.now() - startTime;

    const result: PerceptionResult = {
      query,
      decision,
      screenContext,
      visualAnalysis,
      controlResult,
      answer,
      timestamp: new Date(),
      processingTimeMs,
    };

    // Cache result
    this.queryCache.set(query, result);
    this.perceptionHistory.push(result);

    // Trim cache if it gets too large
    if (this.queryCache.size > 100) {
      const firstKey = this.queryCache.keys().next().value;
      if (firstKey !== undefined) {
        this.queryCache.delete(firstKey);
      }
    }

    console.log(`\n✅ Perception complete in ${processingTimeMs}ms`);
    console.log(`   Answer: "${answer.substring(0, 80)}..."`);
    console.log(`   Efficiency: ${(decision.estimatedEfficiency * 100).toFixed(0)}%`);

    return result;
  }

  /**
   * Build a control sequence from a query
   * Uses pattern matching to determine what actions are needed
   */
  private buildControlSequence(query: string): ControlSequence {
    const lower = query.toLowerCase();

    // Pattern: "open [application]"
    if (lower.match(/^open\s+(\w+)/i)) {
      const match = lower.match(/^open\s+(\w+)/i);
      const appName = match?.[1] || "application";
      const seq = this.screenControl.buildSequence(`Open ${appName}`);
      this.screenControl.open(seq, appName);
      return seq;
    }

    // Pattern: "close [window/app]"
    if (lower.match(/^close\s+(.+)/i)) {
      const match = lower.match(/^close\s+(.+)/i);
      const target = match?.[1] || "window";
      const seq = this.screenControl.buildSequence(`Close ${target}`);
      this.screenControl.close(seq, target);
      return seq;
    }

    // Pattern: "click [target]"
    if (lower.match(/^click\s+(.+)/i)) {
      const match = lower.match(/^click\s+(.+)/i);
      const target = match?.[1] || "button";
      const seq = this.screenControl.buildSequence(`Click ${target}`);
      this.screenControl.click(seq, target);
      return seq;
    }

    // Pattern: "type [text]"
    // BUG FIX (2026-08-28, full-codebase review): this used to match
    // against `lower` (the fully lowercased query) and take the typed
    // text straight from that match — so "type Hello@Example.com" or
    // "type MyP@ssw0rd" got typed into the focused window as
    // "hello@example.com" / "myp@ssw0rd". Case-sensitive text (passwords,
    // URLs, proper nouns, code) was silently corrupted before it ever
    // reached the keyboard. Matched against the ORIGINAL-case `query` now
    // (re-deriving the match index from the lowercased match position, so
    // the "type" keyword itself still matches case-insensitively while
    // the captured text preserves whatever case the user actually typed).
    // The "d" flag gives precise [start, end] indices for each capture
    // group (match.indices[1]) instead of the original code's approach of
    // reading the captured text directly out of the lowercased string —
    // that's what let case get destroyed. Indices are position-stable
    // between `lower` and `query` since toLowerCase() doesn't change
    // string length for the characters this pattern matches.
    const typeMatchLower = lower.match(/^type\s+(.+)/id);
    if (typeMatchLower) {
      const indices = (typeMatchLower as unknown as { indices: Array<[number, number]> }).indices;
      const [start, end] = indices[1];
      const text = query.slice(start, end) || "text";
      const seq = this.screenControl.buildSequence(`Type text`);
      this.screenControl.type(seq, text);
      return seq;
    }

    // Pattern: "click [target] and type [text]"
    if (lower.includes("click") && lower.includes("and type")) {
      const seq = this.screenControl.buildSequence("Click and type");
      const clickMatch = lower.match(/click\s+([^,\s]+)/);
      const typeMatch = lower.match(/type\s+(.+?)(?:\.|$)/d);
      if (clickMatch?.[1]) {
        this.screenControl.click(seq, clickMatch[1]);
      }
      if (typeMatch?.[1]) {
        // Same original-case fix as the standalone "type" pattern above.
        const indices = (typeMatch as unknown as { indices: Array<[number, number]> }).indices;
        const [start, end] = indices[1];
        this.screenControl.type(seq, query.slice(start, end) || typeMatch[1]);
      }
      return seq;
    }

    // Default: generic automation sequence
    const seq = this.screenControl.buildSequence(query);
    this.screenControl.click(seq, "confirm");
    return seq;
  }

  /**
   * Generate answer based on available context
   */
  private generateAnswer(
    query: string,
    decision: RoutingDecision,
    screenContext?: ScreenContext,
    visualAnalysis?: VisualAnalysis,
    controlResult?: ControlResult
  ): string {
    if (controlResult) {
      if (controlResult.success) {
        return `✅ Successfully completed: ${controlResult.output}`;
      } else {
        return `❌ Failed to complete: ${controlResult.error}`;
      }
    }

    if (visualAnalysis) {
      return visualAnalysis.text;
    }

    if (screenContext) {
      return `Currently showing ${screenContext.activeApplication} - ${screenContext.activeWindow}. Resolution: ${screenContext.resolution.width}x${screenContext.resolution.height}. Open windows: ${screenContext.openWindows.length}.`;
    }

    // Reasoning-only answer
    if (decision.primaryContext === "memory") {
      return "I'm checking my memory of our previous conversation...";
    }

    if (decision.primaryContext === "web") {
      return "I would search the web for the latest information about this topic.";
    }

    if (decision.primaryContext === "computer_control") {
      return "I can help with that. I would need to interact with your computer to complete this task.";
    }

    if (decision.primaryContext === "screen_control") {
      return "I'm ready to automate this task. Please confirm and I'll proceed with the automation.";
    }

    // Default reasoning answer
    return "Based on my reasoning, I can help with that.";
  }

  /**
   * Answer a visual question
   */
  async askVisualQuestion(question: string, screenshot?: Buffer): Promise<string> {
    console.log(`\n❓ Visual Question: "${question}"`);

    if (!screenshot) {
      console.log("   Capturing screen for visual question...");
      const context = await this.screenCapture.getScreenContext();
      screenshot = context.screenshot?.data;
    }

    if (!screenshot) {
      throw new Error("Unable to capture screenshot for visual question");
    }

    return this.visionSystem.answerVisualQuestion(screenshot, question);
  }

  /**
   * Detect objects on screen
   */
  async detectScreenObjects(): Promise<
    Array<{ label: string; confidence: number }>
  > {
    console.log("\n🔍 Detecting objects on screen...");

    const context = await this.screenCapture.getScreenContext();
    if (!context.screenshot?.data) {
      throw new Error("Unable to capture screenshot for object detection");
    }

    return this.visionSystem.detectObjects(context.screenshot.data);
  }

  /**
   * Execute a control sequence directly
   */
  async executeControl(description: string): Promise<ControlResult> {
    console.log(`\n🖱️  Executing control: ${description}`);
    const seq = this.screenControl.buildSequence(description);
    return this.screenControl.executeSequence(seq, await this.getIdentity());
  }

  /**
   * Get screen context
   */
  async getScreenContext(): Promise<ScreenContext> {
    return this.screenCapture.getScreenContext();
  }

  /**
   * Monitor screen for changes
   */
  async *monitorPerception(
    intervalMs?: number
  ): AsyncGenerator<PerceptionResult> {
    console.log("\n👁️  Starting perception monitoring...");

    let lastResult: PerceptionResult | undefined;

    for await (const context of this.screenCapture.monitorScreen(intervalMs)) {
      if (
        !lastResult ||
        context.activeApplication !== lastResult.screenContext?.activeApplication
      ) {
        const result: PerceptionResult = {
          query: `Monitor: Screen changed`,
          decision: {
            primaryContext: "screen",
            secondaryContexts: [],
            reasoning: "Continuous screen monitoring for changes",
            requiresScreenCapture: true,
            requiresCamera: false,
            requiresVision: false,
            requiresScreenControl: false,
            estimatedEfficiency: 0.7,
          },
          screenContext: context,
          timestamp: new Date(),
          processingTimeMs: 0,
        };

        this.perceptionHistory.push(result);
        lastResult = result;

        yield result;
      }
    }
  }

  /**
   * Get perception history
   */
  getHistory(limit: number = 20): PerceptionResult[] {
    return this.perceptionHistory.slice(-limit);
  }

  /**
   * Get perception statistics
   */
  getStats(): {
    totalQueries: number;
    cacheHitRate: number;
    queriesRequiringVision: number;
    queriesRequiringControl: number;
    averageProcessingTimeMs: number;
    efficiency: string;
  } {
    const total = this.perceptionHistory.length;
    const withVision = this.perceptionHistory.filter(
      (r) => r.decision.requiresVision
    ).length;
    const withControl = this.perceptionHistory.filter(
      (r) => r.decision.requiresScreenControl
    ).length;
    const avgTime =
      total > 0
        ? this.perceptionHistory.reduce((sum, r) => sum + r.processingTimeMs, 0) /
          total
        : 0;

    return {
      totalQueries: total,
      cacheHitRate: this.queryCache.size / Math.max(total, 1),
      queriesRequiringVision: withVision,
      queriesRequiringControl: withControl,
      averageProcessingTimeMs: Math.round(avgTime),
      efficiency: `${(100 - (withVision / Math.max(total, 1)) * 100).toFixed(0)}% queries optimized (no vision)`,
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    const oldSize = this.queryCache.size;
    this.queryCache.clear();
    console.log(`🗑️  Cleared ${oldSize} cached perception results`);
  }

  /**
   * Get status
   */
  getStatus(): {
    screenCapture: string;
    vision: string;
    contextRouter: string;
    screenControl: string;
    queriesProcessed: number;
    cacheSize: number;
    systemOperating: boolean;
  } {
    const controlStatus = this.screenControl.getStatus();
    return {
      screenCapture: "Active",
      vision: this.visionSystem.isConnected() ? "Connected" : "Ready",
      contextRouter: "Active",
      screenControl: "Ready",
      queriesProcessed: this.perceptionHistory.length,
      cacheSize: this.queryCache.size,
      systemOperating: controlStatus.isOperating,
    };
  }

  /**
   * Get screen control system
   */
  getScreenControlSystem(): ScreenControl {
    return this.screenControl;
  }
}

/**
 * Export perception module for use in Phase 0 Core
 */
export { ScreenCapture, ScreenContext } from "./screen-capture";
export { VisionSystem, VisualAnalysis } from "./vision-system";
export { ContextRouter, ContextType, RoutingDecision } from "./context-router";
export { ScreenControl, ControlSequence, ControlResult, ControlAction } from "./screen-control";
