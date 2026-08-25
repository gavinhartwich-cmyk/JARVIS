/**
 * JARVIS Phase 1 - JARVIS Developer
 *
 * Autonomous software engineering system for building itself
 *
 * Exports all Phase 1 capabilities:
 * - Repository understanding
 * - Code modification
 * - Git integration
 * - Developer orchestration
 * - Agent pipeline
 */

export {
  RepositoryExplorer,
  CodeReader,
  DependencyAnalyzer,
  type FileInfo,
  type RepositoryStructure,
} from "./repository";

export { GitManager, type GitStatus, type CommitInfo } from "./git";

export {
  ARCHITECT_ROLE,
  CODER_ROLE,
  TESTER_ROLE,
  DEBUGGER_ROLE,
  REVIEWER_ROLE,
  VERIFIER_ROLE,
  PHASE_1_AGENT_PIPELINE,
  PHASE_1_AGENTS,
} from "./agents";

export {
  JARVISDeveloper,
  type DeveloperTask,
  type DeveloperResult,
} from "./developer";

/**
 * Phase 1 System Summary
 *
 * JARVIS Developer enables autonomous software development:
 *
 * 1. Repository Understanding
 *    - Explores codebase structure
 *    - Reads and analyzes code
 *    - Understands dependencies
 *    - Maps file relationships
 *
 * 2. Autonomous Development Pipeline
 *    - Architect: Designs solutions
 *    - Coder: Writes code
 *    - Tester: Runs tests
 *    - Debugger: Fixes failures
 *    - Reviewer: Reviews quality
 *    - Verifier: Final approval
 *
 * 3. Git Integration
 *    - Branch management
 *    - Commits with messages
 *    - Pull request creation
 *    - Merge handling
 *
 * 4. Autonomous Execution
 *    - Takes requirements
 *    - Follows complete pipeline
 *    - Verifies quality
 *    - Creates PRs
 *    - Reports results
 *
 * This creates the compounding loop:
 * Better JARVIS Core → Better Developer Agent → Faster Development → Better JARVIS
 */
