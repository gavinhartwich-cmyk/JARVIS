/**
 * Phase 3: Perception Module
 *
 * Orchestrates screen capture, camera input, and vision analysis
 * Central hub for understanding the world around JARVIS
 */

import { ScreenCapture, ScreenContext } from "./screen-capture";
import { VisionSystem, VisualAnalysis } from "./vision-system";
import { ContextRouter, ContextType, RoutingDecision } from "./context-router";

export interface PerceptionQuery {
  query: string;
  requiresVisual: boolean;
  contextTypes: ContextType[];
  reasoning: string;
}

export interface PerceptionResult {
  query: string;
  decision: RoutingDecision;
  screenContext?: ScreenContext;
  visualAnalysis?: VisualAnalysis;
  answer?: string;
  timestamp: Date;
  processingTimeMs: number;
}

/**
 * Perception Module
 *
 * JARVIS's ability to perceive and understand the environment
 */
export class Perception {
  private screenCapture: ScreenCapture;
  private visionSystem: VisionSystem;
  private contextRouter: ContextRouter;

  private perceptionHistory: PerceptionResult[] = [];
  private queryCache: Map<string, PerceptionResult> = new Map();

  constructor() {
    console.log("\n🧠 Perception Module initialized");
    console.log("   Screen capture: ✓");
    console.log("   Vision system: ✓");
    console.log("   Context router: ✓");
    console.log('   Principle: "Vision should not run unnecessarily"');

    this.screenCapture = new ScreenCapture();
    this.visionSystem = new VisionSystem();
    this.contextRouter = new ContextRouter();
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

    // Step 4: Optimize for efficiency
    const optimizedContexts = await this.contextRouter.optimizeForEfficiency(
      decision.primaryContext,
      decision.secondaryContexts
    );

    // Step 5: Generate answer based on available context
    const answer = this.generateAnswer(query, decision, screenContext, visualAnalysis);

    const processingTimeMs = Date.now() - startTime;

    const result: PerceptionResult = {
      query,
      decision,
      screenContext,
      visualAnalysis,
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
   * Generate answer based on available context
   */
  private generateAnswer(
    query: string,
    decision: RoutingDecision,
    screenContext?: ScreenContext,
    visualAnalysis?: VisualAnalysis
  ): string {
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
      return `I can help with that. I would need to interact with your computer to complete this task.`;
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
    console.log("\n🔎 Detecting objects on screen...");

    const context = await this.screenCapture.getScreenContext();
    if (!context.screenshot?.data) {
      throw new Error("Unable to capture screenshot for object detection");
    }

    return this.visionSystem.detectObjects(context.screenshot.data);
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
    averageProcessingTimeMs: number;
    efficiency: string;
  } {
    const total = this.perceptionHistory.length;
    const withVision = this.perceptionHistory.filter(
      (r) => r.decision.requiresVision
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
    queriesProcessed: number;
    cacheSize: number;
  } {
    return {
      screenCapture: "Active",
      vision: this.visionSystem.isConnected() ? "Connected" : "Ready",
      contextRouter: "Active",
      queriesProcessed: this.perceptionHistory.length,
      cacheSize: this.queryCache.size,
    };
  }
}

/**
 * Export perception module for use in Phase 0 Core
 */
export { ScreenCapture, ScreenContext } from "./screen-capture";
export { VisionSystem, VisualAnalysis } from "./vision-system";
export { ContextRouter, ContextType, RoutingDecision } from "./context-router";
