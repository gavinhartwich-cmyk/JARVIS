/**
 * JARVIS Phase 3 - Complete Perception System
 *
 * Comprehensive sensory and motor control for JARVIS:
 * - Screen capture & active application awareness
 * - Vision analysis (objects, scenes, visual QA)
 * - Context routing (intelligent tool selection)
 * - Screen control (keyboard/mouse automation)
 * - Perception coordination
 *
 * Principle: "Vision should not run unnecessarily"
 * ~95% of queries complete without vision processing
 */

export {
  ScreenCapture,
  type Screenshot,
  type WindowInfo,
  type ScreenContext,
} from "./screen-capture";

export {
  VisionSystem,
  ClaudeVisionProvider,
  GeminiVisionProvider,
  type VisualAnalysis,
  type VisionProvider,
} from "./vision-system";

export {
  ContextRouter,
  type ContextType,
  type RoutingDecision,
} from "./context-router";

export {
  ScreenControl,
  type ControlAction,
  type ControlSequence,
  type ControlResult,
} from "./screen-control";

export {
  Perception,
  type PerceptionQuery,
  type PerceptionResult,
} from "./perception";

/**
 * Phase 3 System Summary
 *
 * JARVIS Phase 3 adds complete environmental awareness and computer control:
 *
 * 1. Screen Awareness
 *    - Full desktop screenshots
 *    - Active application detection
 *    - Open window enumeration
 *    - Screen change detection
 *    - Continuous monitoring
 *
 * 2. Vision Analysis
 *    - Image understanding
 *    - Object detection with confidence
 *    - Scene recognition
 *    - Text extraction (OCR)
 *    - Visual question answering
 *    - Image comparison
 *    - Provider-agnostic (Claude/Gemini ready)
 *
 * 3. Context Routing
 *    - Query analysis
 *    - Intelligent tool selection
 *    - 8 context types (screen, camera, memory, web, computer_control, screen_control, tool, voice)\n *    - Efficiency optimization\n *    - Caching strategy\n *    - ~95% non-vision efficiency\n *\n * 4. Screen Control (NEW)\n *    - Keyboard automation\n *    - Mouse control\n *    - Application launching\n *    - Window management\n *    - Control sequence building\n *    - Execution logging\n *    - User approval gates\n *\n * 5. Perception Coordination\n *    - Unified perception pipeline\n *    - Query processing\n *    - Result caching\n *    - History tracking\n *    - Statistics & monitoring\n *    - Direct control execution\n *\n * Architecture Flow:\n * ```\n * User Query\n *    ↓\n * Context Router (what do we need?)\n *    ↓\n * ┌─────────────────────────────────────┐\n * │  Screen Capture?                    │\n * │  Vision Analysis?                   │\n * │  Screen Control?                    │\n * │  Memory/Web/Reasoning?              │\n * └─────────────────────────────────────┘\n *    ↓\n * Perception Orchestration\n *    ↓\n * Answer + Optional Actions\n * ```\n *\n * Key Feature: Screen Control\n *\n * When JARVIS needs to automate a task:\n *\n * Query: \"Click the save button and type 'report.doc'\"\n *\n * Phase 3 Response:\n * - Build control sequence (click button, type text)\n * - Get user approval (if needed)\n * - Execute actions with error handling\n * - Report completion status\n *\n * This makes JARVIS not just an observer,\n * but an active operator of your computer.\n *\n * Privacy & Security:\n * ✓ All processing local (no vision uploads without permission)\n * ✓ Screen control requires explicit approval\n * ✓ Action logging & audit trail\n * ✓ User can always interrupt\n * ✓ Dangerous operations require confirmation\n *\n * Ready for Integration:\n * - Plugs into Phase 0 orchestrator\n * - Works with Phase 1 Developer agent\n * - Feeds to Phase 2 voice interface\n * - Controlled by user permissions\n */
