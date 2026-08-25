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
  PLANNER_ROLE,
  CODER_ROLE,
  BUILDER_ROLE,
  TESTER_ROLE,
  DEBUGGER_ROLE,
  CODE_REVIEWER_ROLE,
  SECURITY_REVIEWER_ROLE,
  VERIFIER_ROLE,
  DEPLOYER_ROLE,
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
 * 2. Complete 10-Agent Pipeline
 *    - Architect: High-level design and component identification
 *    - Planner: Break design into executable tasks
 *    - Coder: Write production-ready code
 *    - Builder: Verify compilation and build success
 *    - Tester: Run unit/integration/regression tests
 *    - Debugger: Fix failures and debug issues
 *    - Code Reviewer: Verify quality and maintainability
 *    - Security Reviewer: Check security implications
 *    - Verifier: Final verification + recommendation
 *    - Deployer: Production deployment
 *
 * 3. Human Approval Gate
 *    - Verifier recommends for approval
 *    - System requires explicit human authorization
 *    - Deployment only proceeds with approval
 *
 * 4. Git Integration
 *    - Branch management
 *    - Commits with messages
 *    - Pull request creation
 *    - Release tagging
 *    - Deployment automation
 *
 * 5. Autonomous Execution
 *    - Takes requirements
 *    - Follows complete pipeline
 *    - Comprehensive verification
 *    - Security-first approach
 *    - Requires human approval
 *
 * 6. Self-Test Capability
 *    - JARVIS Developer can work on JARVIS codebase
 *    - Demonstrates compounding loop
 *    - Verifies autonomous capability
 *
 * This creates the compounding loop:
 * Better JARVIS Core → Better Developer Agent → Faster Development → Better JARVIS
 */
