/**
 * JARVIS Phase 3 - Perception System
 *
 * Comprehensive perception layer giving JARVIS understanding of:
 * - Screen content (desktop, applications, UI)
 * - Camera input (real-world environment, people, objects)
 * - Context awareness (when to use which tool)
 *
 * Core principle: "Vision should not run unnecessarily"
 * Smart routing ensures visual analysis is only used when needed
 */

// Screen Capture
export {
  ScreenCapture,
  type Screenshot,
  type WindowInfo,
  type ScreenContext,
} from "./screen-capture";

// Vision Analysis
export {
  VisionSystem,
  type VisualAnalysis,
  type VisionProvider,
  ClaudeVisionProvider,
  GeminiVisionProvider,
} from "./vision-system";

// Context Routing
export {
  ContextRouter,
  type ContextType,
  type RoutingDecision,
} from "./context-router";

// Main Perception Module
export {
  Perception,
  type PerceptionQuery,
  type PerceptionResult,
} from "./perception";

/**
 * Phase 3 System Summary
 *
 * JARVIS Phase 3 adds comprehensive perception:
 *
 * 1. Screen Awareness
 *    - Screenshot capture with dimensions and metadata
 *    - Active application detection
 *    - Open windows enumeration
 *    - Screen change monitoring
 *    - Integration with vision AI for UI understanding
 *
 * 2. Camera Awareness (Framework Ready)
 *    - Camera capture capability
 *    - Real-world object detection
 *    - Person/gesture recognition
 *    - Scene understanding
 *    - Visual Q&A support
 *
 * 3. Intelligent Context Routing
 *    - Analyzes user queries to determine what tools are needed
 *    - Routes to appropriate context (screen, camera, memory, web, etc.)
 *    - Optimizes for efficiency
 *    - Avoids unnecessary vision processing
 *
 * 4. Vision Integration
 *    - Pluggable vision providers (Claude, Gemini, etc.)
 *    - Image analysis and object detection
 *    - Scene recognition and understanding
 *    - Text extraction and visual Q&A
 *    - Lazy loading (only initialized when needed)
 *
 * Key Design Principles:
 *    ✓ Vision is optional and provider-agnostic
 *    ✓ Context routing ensures efficiency
 *    ✓ All components are testable without hardware
 *    ✓ Streaming-ready architecture
 *    ✓ Event-driven pipeline
 *
 * Integration Points:
 *    → Phase 0 (Core): Perception feeds context to reasoning
 *    → Phase 1 (Developer): Complex perception tasks routed through agents
 *    → Phase 2 (Voice): Perception supports voice queries ("What's on screen?")
 *    → Phase 4 (Memory): Perception results stored for recall
 */
