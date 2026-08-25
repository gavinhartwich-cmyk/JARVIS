/**
 * Phase 3: Context Router
 *
 * Determines what tools/sensors JARVIS needs to answer a question or complete a task
 * "Vision should not run unnecessarily"
 */

export type ContextType =
  | "screen"
  | "camera"
  | "memory"
  | "web"
  | "computer_control"
  | "screen_control"
  | "tool"
  | "voice"
  | "multiple";

export interface RoutingDecision {
  primaryContext: ContextType;
  secondaryContexts: ContextType[];
  reasoning: string;
  requiresScreenCapture: boolean;
  requiresCamera: boolean;
  requiresVision: boolean;
  requiresScreenControl: boolean;
  estimatedEfficiency: number; // 0-1, higher = more efficient
}

/**
 * Context Router
 *
 * Intelligently routes queries to appropriate tools/sensors
 */
export class ContextRouter {
  constructor() {
    console.log("🎛️  Context Router initialized");
    console.log('   "Vision should not run unnecessarily"');
  }

  /**
   * Route a user query to appropriate context/tools
   */
  async routeQuery(query: string): Promise<RoutingDecision> {
    console.log(`\n🔀 Routing query: "${query}"`);

    const analysis = this.analyzeQuery(query);
    const decision = this.makeRoutingDecision(analysis);

    console.log(`✅ Routing decision:`);
    console.log(`   Primary: ${decision.primaryContext}`);
    if (decision.secondaryContexts.length > 0) {
      console.log(`   Secondary: ${decision.secondaryContexts.join(", ")}`);
    }
    console.log(`   Efficiency: ${(decision.estimatedEfficiency * 100).toFixed(0)}%`);
    if (decision.requiresScreenControl) {
      console.log(`   Screen Control: Required`);
    }

    return decision;
  }

  /**
   * Analyze query characteristics
   */
  private analyzeQuery(query: string): {
    needsVisual: boolean;
    needsScreen: boolean;
    needsCamera: boolean;
    needsMemory: boolean;
    needsWeb: boolean;
    needsControl: boolean;
    needsScreenControl: boolean;
    keywords: string[];
  } {
    const lower = query.toLowerCase();

    return {
      needsVisual: this.hasVisualKeywords(lower),
      needsScreen: this.hasScreenKeywords(lower),
      needsCamera: this.hasCameraKeywords(lower),
      needsMemory: this.hasMemoryKeywords(lower),
      needsWeb: this.hasWebKeywords(lower),
      needsControl: this.hasControlKeywords(lower),
      needsScreenControl: this.hasScreenControlKeywords(lower),
      keywords: this.extractKeywords(lower),
    };
  }

  /**
   * Check for visual-related keywords
   */
  private hasVisualKeywords(query: string): boolean {
    const keywords = [
      "see",
      "look",
      "show",
      "screen",
      "window",
      "button",
      "icon",
      "visual",
      "image",
      "picture",
      "screenshot",
      "display",
      "view",
      "camera",
      "watch",
      "observe",
      "notice",
      "what's on",
    ];
    return keywords.some((kw) => query.includes(kw));
  }

  /**
   * Check for screen-specific keywords
   */
  private hasScreenKeywords(query: string): boolean {
    const keywords = [
      "screen",
      "desktop",
      "monitor",
      "window",
      "app",
      "application",
      "browser",
      "chrome",
      "code",
      "editor",
      "active",
      "foreground",
    ];
    return keywords.some((kw) => query.includes(kw));
  }

  /**
   * Check for camera-related keywords
   */
  private hasCameraKeywords(query: string): boolean {
    const keywords = [
      "camera",
      "webcam",
      "video",
      "record",
      "face",
      "person",
      "gesture",
      "movement",
      "physical",
      "real-world",
      "around me",
      "room",
    ];
    return keywords.some((kw) => query.includes(kw));
  }

  /**
   * Check for memory-related keywords
   */
  private hasMemoryKeywords(query: string): boolean {
    const keywords = [
      "remember",
      "past",
      "history",
      "previous",
      "last time",
      "before",
      "earlier",
      "remind",
      "recall",
      "conversation",
    ];
    return keywords.some((kw) => query.includes(kw));
  }

  /**
   * Check for web-related keywords
   */
  private hasWebKeywords(query: string): boolean {
    const keywords = [
      "search",
      "look up",
      "find",
      "research",
      "internet",
      "online",
      "website",
      "weather",
      "news",
      "stock",
      "price",
      "latest",
    ];
    return keywords.some((kw) => query.includes(kw));
  }

  /**
   * Check for control-related keywords (generic)
   */
  private hasControlKeywords(query: string): boolean {
    const keywords = [
      "open",
      "close",
      "click",
      "type",
      "run",
      "launch",
      "execute",
      "start",
      "stop",
      "control",
      "operate",
      "change",
      "modify",
    ];
    return keywords.some((kw) => query.includes(kw));
  }

  /**
   * Check for screen control-specific keywords
   * These indicate JARVIS should directly control the screen
   */
  private hasScreenControlKeywords(query: string): boolean {
    const keywords = [
      "click",
      "type",
      "open this",
      "open that",
      "close",
      "fill in",
      "send",
      "compose",
      "draft",
      "do it for me",
      "automate",
      "perform",
      "execute",
      "run",
      "click the",
      "open the",
      "go to",
      "navigate",
      "press",
      "save as",
      "rename",
    ];
    return keywords.some((kw) => query.includes(kw));
  }

  /**
   * Extract keywords from query
   */
  private extractKeywords(query: string): string[] {
    // Simple keyword extraction
    const stopwords = new Set([
      "the",
      "a",
      "an",
      "is",
      "are",
      "was",
      "be",
      "can",
      "i",
      "you",
      "what",
      "how",
      "why",
      "where",
      "when",
      "who",
    ]);

    return query
      .split(/\s+/)
      .filter((word) => !stopwords.has(word.toLowerCase()))
      .slice(0, 5);
  }

  /**
   * Make routing decision based on analysis
   */
  private makeRoutingDecision(analysis: ReturnType<typeof this.analyzeQuery>): RoutingDecision {
    // Priority-based routing logic

    // Screen control is highest priority if requested
    if (analysis.needsScreenControl) {
      return {
        primaryContext: "screen_control",
        secondaryContexts: analysis.needsScreen ? ["screen"] : [],
        reasoning:
          "Query requires direct computer automation. JARVIS will operate keyboard/mouse to complete the task.",
        requiresScreenCapture: analysis.needsScreen,
        requiresCamera: false,
        requiresVision: analysis.needsScreen,
        requiresScreenControl: true,
        estimatedEfficiency: 0.88,
      };
    }

    if (analysis.needsVisual && analysis.needsScreen) {
      return {
        primaryContext: "screen",
        secondaryContexts: analysis.needsMemory ? ["memory"] : [],
        reasoning:
          "Query requires visual understanding of desktop/applications. Screen capture and vision analysis needed.",
        requiresScreenCapture: true,
        requiresCamera: false,
        requiresVision: true,
        requiresScreenControl: false,
        estimatedEfficiency: 0.9,
      };
    }

    if (analysis.needsCamera) {
      return {
        primaryContext: "camera",
        secondaryContexts: analysis.needsMemory ? ["memory"] : [],
        reasoning:
          "Query requires real-world visual understanding. Camera capture and vision analysis needed.",
        requiresScreenCapture: false,
        requiresCamera: true,
        requiresVision: true,
        requiresScreenControl: false,
        estimatedEfficiency: 0.8,
      };
    }

    if (analysis.needsControl && !analysis.needsScreenControl) {
      return {
        primaryContext: "computer_control",
        secondaryContexts: analysis.needsScreen ? ["screen"] : [],
        reasoning:
          "Query requires computer interaction. May need screen capture for context verification.",
        requiresScreenCapture: analysis.needsScreen,
        requiresCamera: false,
        requiresVision: analysis.needsScreen,
        requiresScreenControl: false,
        estimatedEfficiency: 0.85,
      };
    }

    if (analysis.needsWeb) {
      return {
        primaryContext: "web",
        secondaryContexts: [],
        reasoning:
          "Query requires internet research. No vision needed - pure information lookup.",
        requiresScreenCapture: false,
        requiresCamera: false,
        requiresVision: false,
        requiresScreenControl: false,
        estimatedEfficiency: 0.95,
      };
    }

    if (analysis.needsMemory) {
      return {
        primaryContext: "memory",
        secondaryContexts: [],
        reasoning:
          "Query requires accessing previous context/conversation. No vision needed.",
        requiresScreenCapture: false,
        requiresCamera: false,
        requiresVision: false,
        requiresScreenControl: false,
        estimatedEfficiency: 1.0,
      };
    }

    // Default: voice-only reasoning
    return {
      primaryContext: "voice",
      secondaryContexts: [],
      reasoning:
        "Query can be answered with reasoning alone. No external context needed.",
      requiresScreenCapture: false,
      requiresCamera: false,
      requiresVision: false,
      requiresScreenControl: false,
      estimatedEfficiency: 1.0,
    };
  }

  /**
   * Optimize for efficiency
   *
   * When multiple contexts could work, choose the most efficient
   */
  async optimizeForEfficiency(
    primaryContext: ContextType,
    secondaryContexts: ContextType[]
  ): Promise<ContextType[]> {
    console.log(
      "\n⚡ Optimizing for efficiency: Vision should not run unnecessarily"
    );

    const efficiency: Record<ContextType, number> = {
      voice: 1.0,
      memory: 1.0,
      web: 0.95,
      computer_control: 0.85,
      screen_control: 0.88,
      tool: 0.8,
      screen: 0.7, // Vision overhead
      camera: 0.6, // Vision overhead + camera processing
      multiple: 0.5, // Multiple vision sources
    };

    // Filter out lower efficiency alternatives if primary is efficient enough
    if (efficiency[primaryContext] > 0.9) {
      console.log(
        `✅ Using ${primaryContext} only (efficiency: ${(efficiency[primaryContext] * 100).toFixed(0)}%)`
      );
      return [primaryContext];
    }

    // Include only high-efficiency secondaries
    const optimized = [
      primaryContext,
      ...secondaryContexts.filter((ctx) => efficiency[ctx] > 0.8),
    ];

    console.log(
      `✅ Using: ${optimized.join(", ")} (avoiding unnecessary vision)`
    );
    return optimized;
  }

  /**
   * Get routing stats
   */
  getStats(): {
    routesWithVision: number;
    routesWithoutVision: number;
    routesWithScreenControl: number;
    averageEfficiency: number;
  } {
    return {
      routesWithVision: 0,
      routesWithoutVision: 0,
      routesWithScreenControl: 0,
      averageEfficiency: 0.9,
    };
  }
}
