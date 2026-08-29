/**
 * Phase 1: JARVIS Developer System
 *
 * Autonomous software engineering system that takes requirements
 * through the complete development pipeline:
 *
 * Requirement → Architect → Planner → Coder → Builder → Tester → Debugger →
 * Code Reviewer → Security Reviewer → Verifier → [Human Approval] → Deployer
 *
 * Every step below actually does the thing it claims. Build/test status is
 * mechanically checked (not LLM-guessed). Human approval is a real gate:
 * deployment never proceeds without an explicit `approved: true` passed in
 * by the caller after a human has reviewed the branch/diff — there is no
 * auto-approve path, by design (see master plan: "no unrestricted
 * autonomous authority over dangerous systems").
 */

import { execFileSync } from "child_process";
import { builtinModules } from "module";
import path from "path";
import { RepositoryExplorer, CodeReader, DependencyAnalyzer } from "./repository";
import { v4 as uuidv4 } from "uuid";
import { GitManager } from "./git";
import {
  ARCHITECT_ROLE,
  PLANNER_ROLE,
  CODER_ROLE,
  DEBUGGER_ROLE,
  CODE_REVIEWER_ROLE,
  SECURITY_REVIEWER_ROLE,
  VERIFIER_ROLE,
  PHASE_1_AGENT_PIPELINE,
} from "./agents";
import { BaseAgent } from "../agents/agent";
import type { Agent } from "../agents/types";
import { createDefaultGateway, GatewayModelProvider } from "../models/llm-gateway";
import type { ModelProvider } from "../models/types";
import {
  parseFileBlocks,
  applyFileBlocks,
  isNoChangesResponse,
  findDisallowedImports,
  FILE_BLOCK_PROTOCOL_INSTRUCTIONS,
  type FileBlock,
} from "./patch";
import { runTypecheck, runTests, type BuildResult, type TestResult } from "./build-test";

const MAX_DEBUG_ATTEMPTS = 2;

export interface DeveloperTask {
  id: string;
  requirement: string;
  status:
    | "pending"
    | "analyzing"
    | "designing"
    | "planning"
    | "coding"
    | "building"
    | "testing"
    | "debugging"
    | "reviewing"
    | "security_reviewing"
    | "verifying"
    | "awaiting_approval"
    | "deploying"
    | "complete"
    | "failed";
  repositoryPath: string;
  targetBranch: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface DeveloperResult {
  taskId: string;
  success: boolean;
  status: "completed" | "failed" | "needs_revision" | "awaiting_human_approval";
  branchName: string;
  baseBranch: string;
  architecture: string;
  taskPlan: string;
  implementation: Map<string, string>;
  buildStatus: {
    success: boolean;
    errors: string[];
  };
  testResults: {
    configured: boolean;
    passed: number;
    failed: number;
  };
  codeReviewResults: {
    quality: number;
    issues: string[];
    approved: boolean;
  };
  securityReviewResults: {
    riskLevel: "critical" | "high" | "medium" | "low";
    issues: string[];
    approved: boolean;
  };
  verificationResults: {
    recommendation: "approved_for_deployment" | "needs_fixes";
    issues: string[];
  };
  deploymentStatus?: {
    success: boolean;
    prUrl?: string;
    branchPushed?: boolean;
  };
  gitCommit?: string;
}

export interface DevelopFeatureOptions {
  /**
   * Explicit human authorization to deploy. Defaults to false — the
   * pipeline always stops at "awaiting_human_approval" until a human sets
   * this to true after reviewing the branch/diff. There is no code path
   * that fabricates approval.
   */
  approved?: boolean;
  /** Branch to base the feature branch on. Defaults to the current branch. */
  baseBranch?: string;
  /** Optional identity of the human granting approval, for the audit trail. */
  approvedBy?: string;
}

/**
 * JARVIS Developer - Autonomous software engineer
 */
export class JARVISDeveloper {
  private repositoryPath: string;
  private gitManager: GitManager;
  private repositoryExplorer: RepositoryExplorer;
  private modelProvider: ModelProvider;
  private agents: Record<string, Agent>;
  // A real UUID per developFeature() run — the audit_events.resource_id
  // column is typed uuid, so the human-readable "task-<timestamp>" id
  // used for branch naming/logging can't double as the agent taskId
  // (found by actually running this against Postgres: it silently failed
  // every audit insert with "invalid input syntax for type uuid").
  // Set fresh at the start of each developFeature() call, not here, so
  // concurrent/repeated runs on the same instance don't share one id.
  private runId: string = "";
  // Declared package.json deps + Node/Bun builtins — the fence used to
  // catch the Coder/Debugger importing packages this repo doesn't actually
  // have (see findDisallowedImports). Recomputed per run in case an earlier
  // debug attempt changed package.json.
  private allowedPackages: Set<string> = new Set(builtinModules);
  private declaredDependencies: Set<string> = new Set();

  constructor(repositoryPath: string, modelProvider?: ModelProvider) {
    this.repositoryPath = repositoryPath;
    this.gitManager = new GitManager(repositoryPath);
    this.repositoryExplorer = new RepositoryExplorer(repositoryPath);
    // Same OmniRoute-first, Ollama-fallback gateway as Phase 0 (see
    // src/models/llm-gateway.ts) — the Coder/Debugger loop is exactly
    // where a single upstream's quota exhaustion mid-pipeline used to be
    // most costly to hit; OmniRoute's own 300+-provider auto-fallback now
    // absorbs that before it ever reaches JARVIS as an error.
    this.modelProvider = modelProvider ?? new GatewayModelProvider(createDefaultGateway());

    const modelConfig = {
      provider: this.modelProvider.name,
      model: process.env.OMNIROUTE_MODEL || "auto",
      temperature: 0.3, // lower than Phase 0's conversational default — code needs precision, not creativity
      maxTokens: 8000,
      // 120s - a live run hit the provider's 60s-default per-call timeout
      // on a plain Architect-agent call (no code generation even involved
      // yet), surfaced as an opaque "The operation timed out." several
      // layers up. Phase 1's calls (architecture/planning reasoning, and
      // especially Coder/Debugger reproducing real files) run longer than
      // Phase 0's conversational calls, so they get more room than cli.ts's
      // 90s.
      timeoutMs: 120_000,
    };

    // Coder/Debugger specifically have to reproduce an ENTIRE existing
    // file verbatim plus their edit (see existingFileContext() /
    // FILE_BLOCK_PROTOCOL_INSTRUCTIONS) - 8000 tokens sounded generous
    // until a live run against a real 770-line/26KB file
    // (conversation-intelligence.ts) got cut off mid-file with no
    // ===END FILE=== marker, which parseFileBlocks then (misleadingly)
    // reported as "didn't use the required format." A real file that size
    // needs on the order of 7000-9000 output tokens for its content alone,
    // leaving no room for anything else at an 8000 cap. Doubled here; see
    // also the finishReason check below step4_ImplementCode for what
    // happens if even this isn't enough.
    const codeModelConfig = { ...modelConfig, maxTokens: 16000 };

    this.agents = {
      architect: new BaseAgent(
        ARCHITECT_ROLE.name,
        ARCHITECT_ROLE.role,
        ARCHITECT_ROLE.instructions,
        modelConfig,
        this.modelProvider
      ),
      planner: new BaseAgent(
        PLANNER_ROLE.name,
        PLANNER_ROLE.role,
        PLANNER_ROLE.instructions,
        modelConfig,
        this.modelProvider
      ),
      coder: new BaseAgent(
        CODER_ROLE.name,
        CODER_ROLE.role,
        CODER_ROLE.instructions + "\n\n" + FILE_BLOCK_PROTOCOL_INSTRUCTIONS,
        codeModelConfig,
        this.modelProvider
      ),
      debugger: new BaseAgent(
        DEBUGGER_ROLE.name,
        DEBUGGER_ROLE.role,
        DEBUGGER_ROLE.instructions + "\n\n" + FILE_BLOCK_PROTOCOL_INSTRUCTIONS,
        codeModelConfig,
        this.modelProvider
      ),
      codeReviewer: new BaseAgent(
        CODE_REVIEWER_ROLE.name,
        CODE_REVIEWER_ROLE.role,
        CODE_REVIEWER_ROLE.instructions,
        modelConfig,
        this.modelProvider
      ),
      securityReviewer: new BaseAgent(
        SECURITY_REVIEWER_ROLE.name,
        SECURITY_REVIEWER_ROLE.role,
        SECURITY_REVIEWER_ROLE.instructions,
        modelConfig,
        this.modelProvider
      ),
      verifier: new BaseAgent(
        VERIFIER_ROLE.name,
        VERIFIER_ROLE.role,
        VERIFIER_ROLE.instructions,
        modelConfig,
        this.modelProvider
      ),
    };
  }

  /**
   * Understand repository context
   */
  async analyzeRepository(): Promise<{
    structure: string;
    primaryLanguage: string;
    dependencies: Set<string>;
    metadata: Record<string, any>;
  }> {
    const structure = await this.repositoryExplorer.getStructure();
    const primaryLanguage =
      await this.repositoryExplorer.getPrimaryLanguage();
    const dependencies =
      await DependencyAnalyzer.getAllDependencies(this.repositoryPath);
    const metadata = await this.repositoryExplorer.getMetadata();

    return {
      structure: JSON.stringify(structure, null, 2),
      primaryLanguage,
      dependencies,
      metadata,
    };
  }

  /**
   * Main development pipeline
   */
  async developFeature(
    requirement: string,
    options: DevelopFeatureOptions = {}
  ): Promise<DeveloperResult> {
    const taskId = `task-${Date.now()}`;
    const branchName = `feature/${taskId}`;
    this.runId = uuidv4();

    console.log("\n" + "=".repeat(70));
    console.log("🚀 JARVIS DEVELOPER - PHASE 1 - COMPLETE PIPELINE");
    console.log("=".repeat(70));
    console.log(`\nRequirement: ${requirement}`);
    console.log(`Task ID: ${taskId}`);
    console.log(`Branch: ${branchName}`);

    // BUG FIX (2026-08-28, full-codebase review): getStatus() used to run
    // here, before the try block below starts — so a real failure (target
    // path isn't a git repo, git binary missing, corrupted .git) threw
    // straight out of developFeature() uncaught, skipping the whole
    // try/catch's "return a failed DeveloperResult" contract entirely and
    // relying on cli.ts's top-level handler alone. Wrapped in its own
    // try/catch now so this failure mode returns the same well-formed
    // `{ status: "failed", ... }` shape every other failure in this
    // pipeline does, consistent with what cli.ts's "developer" command
    // handler expects to read `result.status` from.
    let startStatus: Awaited<ReturnType<typeof this.gitManager.getStatus>>;
    try {
      startStatus = await this.gitManager.getStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n❌ Could not read git status for '${this.repositoryPath}': ${message}`);
      return {
        taskId,
        success: false,
        status: "failed",
        branchName,
        baseBranch: options.baseBranch || "",
        architecture: "",
        taskPlan: "",
        implementation: new Map(),
        buildStatus: { success: false, errors: [] },
        testResults: { configured: false, passed: 0, failed: 0 },
        codeReviewResults: { quality: 0, issues: [], approved: false },
        securityReviewResults: { riskLevel: "low", issues: [], approved: false },
        verificationResults: { recommendation: "needs_fixes", issues: [`Not a usable git repository: ${message}`] },
      };
    }
    const baseBranch = options.baseBranch || startStatus.branch;

    const result: DeveloperResult = {
      taskId,
      success: false,
      status: "failed",
      branchName,
      baseBranch,
      architecture: "",
      taskPlan: "",
      implementation: new Map(),
      buildStatus: { success: false, errors: [] },
      testResults: { configured: false, passed: 0, failed: 0 },
      codeReviewResults: { quality: 0, issues: [], approved: false },
      securityReviewResults: { riskLevel: "low", issues: [], approved: false },
      verificationResults: { recommendation: "needs_fixes", issues: [] },
    };

    try {
      // Guard: don't start autonomous work on top of a dirty working tree —
      // that would mix the human's in-progress changes with the agent's,
      // making the eventual diff unreviewable.
      const dirty =
        startStatus.modified.length > 0 ||
        startStatus.added.length > 0 ||
        startStatus.deleted.length > 0 ||
        startStatus.untracked.length > 0;
      if (dirty) {
        throw new Error(
          `Repository has uncommitted changes on '${startStatus.branch}' — commit or stash them before starting a new JARVIS Developer task.`
        );
      }

      // Step 1: Analyze requirement + repository
      const analysis = await this.step1_AnalyzeRequirement(requirement);

      // Recompute the dependency fence fresh per run (package.json won't
      // usually change mid-run, but this is cheap and avoids a stale set).
      this.declaredDependencies = DependencyAnalyzer.getDeclaredPackageNames(this.repositoryPath);
      this.allowedPackages = new Set([...builtinModules, ...this.declaredDependencies]);

      // Real branch creation (previously computed but never checked out)
      console.log(`\n🌿 Creating branch '${branchName}' from '${baseBranch}'...`);
      await this.gitManager.createBranch(branchName, baseBranch);

      // Step 2: Design architecture
      const design = await this.step2_DesignArchitecture(requirement, analysis.context);
      result.architecture = design.design;

      // Step 3: Plan tasks
      const plan = await this.step3_PlanTasks(requirement, design.design);
      result.taskPlan = plan.roadmap;

      // Step 4: Implement code
      const implementation = await this.step4_ImplementCode(requirement, design.design, plan.roadmap);
      if (!implementation.success) {
        throw new Error(implementation.reason);
      }
      result.implementation = implementation.files;

      // Step 5: Build
      let buildResult = await this.step5_BuildCode(result.implementation);
      result.buildStatus = { success: buildResult.success, errors: buildResult.errors };

      // Step 6: Run tests
      let testResult = await this.step6_RunTests();
      result.testResults = {
        configured: testResult.configured,
        passed: testResult.passed,
        failed: testResult.failed,
      };

      // Step 7: Debug if the build failed or tests failed — bounded retry
      // loop, not unlimited, so a persistently broken change fails loudly
      // instead of burning API calls forever.
      let debugAttempts = 0;
      while (
        (!buildResult.success || testResult.failed > 0) &&
        debugAttempts < MAX_DEBUG_ATTEMPTS
      ) {
        debugAttempts++;
        console.log(`\n🐛 Build/test failures detected — debug attempt ${debugAttempts}/${MAX_DEBUG_ATTEMPTS}`);
        const debugResult = await this.step7_DebugFailures(buildResult, testResult, result.implementation);
        if (debugResult.filesChanged === 0) {
          // Don't give up the remaining attempt budget on one unproductive
          // response — a live run showed this triggering after just the
          // *first* attempt, silently forfeiting attempt 2/2. Log why (so a
          // future failure like this is diagnosable) and let the bounded
          // while-loop condition decide whether to try again.
          console.log(`   ⚠️  Debugger produced no usable file changes on attempt ${debugAttempts}/${MAX_DEBUG_ATTEMPTS}.`);
          console.log(`   Raw response preview: ${truncate(debugResult.rawResponse, 300)}`);
        } else {
          for (const [path, content] of debugResult.files) {
            result.implementation.set(path, content);
          }
        }

        buildResult = await this.step5_BuildCode(result.implementation);
        result.buildStatus = { success: buildResult.success, errors: buildResult.errors };
        testResult = await this.step6_RunTests();
        result.testResults = {
          configured: testResult.configured,
          passed: testResult.passed,
          failed: testResult.failed,
        };
      }

      if (!buildResult.success) {
        throw new Error(
          `Build still failing after ${debugAttempts} debug attempt(s):\n${buildResult.errors.slice(0, 10).join("\n")}`
        );
      }
      if (testResult.failed > 0) {
        throw new Error(
          `${testResult.failed} test(s) still failing after ${debugAttempts} debug attempt(s).`
        );
      }

      // Step 8: Code review (against the real diff)
      const diff = await this.gitManager.getDiff(baseBranch);
      const codeReview = await this.step8_ReviewCode(diff);
      result.codeReviewResults = codeReview;

      // Step 9: Security review (against the real diff)
      const securityReview = await this.step9_SecurityReview(diff);
      result.securityReviewResults = securityReview;

      // Step 10: Verify
      const verification = await this.step10_Verify(
        codeReview.approved,
        securityReview.approved,
        buildResult.success,
        testResult.failed === 0
      );
      result.verificationResults = {
        recommendation: verification.recommendation,
        issues: verification.issues,
      };

      // Step 11: Human approval gate — real, not simulated
      result.status = "awaiting_human_approval";
      const approval = await this.step11_RequestHumanApproval(
        verification.recommendation,
        options
      );

      if (approval.approved && verification.recommendation === "approved_for_deployment") {
        // Step 12: Deploy (open a PR for human review — never auto-merges)
        const deployment = await this.step12_Deploy(branchName, baseBranch, taskId, requirement);
        result.deploymentStatus = deployment;
        result.gitCommit = deployment.commitHash;

        if (deployment.success) {
          result.success = true;
          result.status = "completed";
        } else {
          result.status = "needs_revision";
        }
      } else if (verification.recommendation !== "approved_for_deployment") {
        result.status = "needs_revision";
      }
      // else: stays "awaiting_human_approval" — this is the expected,
      // common end state, not a failure.

      console.log("\n" + "=".repeat(70));
      console.log("📊 DEVELOPMENT PIPELINE COMPLETE");
      console.log("=".repeat(70));
      console.log(`Status: ${result.status}`);
      console.log(`Branch: ${branchName} (base: ${baseBranch})`);
      console.log(`Success: ${result.success}`);

      return result;
    } catch (error) {
      console.error("\n❌ DEVELOPMENT PIPELINE FAILED");
      console.error(error instanceof Error ? error.message : String(error));
      result.status = "failed";
      result.verificationResults.issues.push(
        error instanceof Error ? error.message : String(error)
      );
      console.log(
        `\n   Repository is left on branch '${branchName}' for inspection (not switched back automatically).`
      );
      return result;
    }
  }

  /**
   * Step 1: Analyze requirement
   */
  private async step1_AnalyzeRequirement(requirement: string): Promise<{
    understood: boolean;
    summary: string;
    context: string;
  }> {
    console.log("\n📋 STEP 1: Analyzing Requirement");
    console.log(`   Requirement: ${requirement.substring(0, 100)}...`);
    const repositoryContext = await this.analyzeRepository();
    return {
      understood: true,
      summary: requirement,
      context: JSON.stringify({
        ...repositoryContext,
        dependencies: Array.from(repositoryContext.dependencies),
      }),
    };
  }

  /**
   * Step 2: Design architecture (real Architect agent call)
   */
  private async step2_DesignArchitecture(
    requirement: string,
    context: string
  ): Promise<{ design: string; confidence: number }> {
    console.log("\n🏗️  STEP 2: Designing Architecture (Architect Agent)");
    const output = await this.agents.architect.execute({
      taskId: this.runId,
      task: `Requirement:\n${requirement}\n\nRepository context (structure, primary language, dependencies, metadata):\n${truncate(context, 6000)}`,
      context: {},
    });
    console.log(`   Confidence: ${(output.confidence * 100).toFixed(0)}%`);
    return { design: output.content, confidence: output.confidence };
  }

  /**
   * Step 3: Create task plan (real Planner agent call)
   */
  private async step3_PlanTasks(
    requirement: string,
    design: string
  ): Promise<{ roadmap: string; confidence: number }> {
    console.log("\n📝 STEP 3: Planning Tasks (Planner Agent)");
    const output = await this.agents.planner.execute({
      taskId: this.runId,
      task: `Requirement:\n${requirement}\n\nArchitecture design from the Architect agent:\n${design}`,
      context: {},
    });
    console.log(`   Confidence: ${(output.confidence * 100).toFixed(0)}%`);
    return { roadmap: output.content, confidence: output.confidence };
  }

  /**
   * Step 4: Implement code (real Coder agent call, real disk writes)
   */
  private async step4_ImplementCode(
    requirement: string,
    design: string,
    plan: string
  ): Promise<{ files: Map<string, string>; success: boolean; reason?: string }> {
    console.log("\n💻 STEP 4: Implementing Code (Coder Agent)");
    const existingContent = this.existingFileContext(requirement, design, plan);
    // This final reminder is deliberately placed after everything else,
    // including the (potentially large) injected file content - found
    // necessary via a live run where the Coder agent, given a real
    // requirement plus a 770-line EXISTING CONTENT block, replied with a
    // bare ```typescript comment and no ===FILE:=== markers at all. The
    // real protocol instructions live in the system prompt, ahead of all
    // of this; repeating the concrete requirement right before the model
    // generates its answer keeps it from getting lost behind a large
    // block of injected file content.
    const finalReminder = `\n\nReminder: your response for this requirement must use the ===FILE:===...===END FILE=== format above for every file you touch, with that file's complete content (existing content plus your edit, if it already exists) - not a code fence, not a diff, not just the changed lines.`;
    const output = await this.agents.coder.execute({
      taskId: this.runId,
      task: `Requirement:\n${requirement}\n\nArchitecture:\n${design}\n\nTask plan:\n${plan}\n\nRepository root: ${this.repositoryPath}\nAll file paths must be relative to the repository root.\n\n${this.dependencyConstraintText()}${existingContent}${finalReminder}`,
      context: {},
    });

    if (isNoChangesResponse(output.content)) {
      return { files: new Map(), success: false, reason: "Coder agent determined no file changes were needed for this requirement." };
    }

    const blocks: FileBlock[] = parseFileBlocks(output.content);
    if (blocks.length === 0) {
      // A response that opens a ===FILE:=== block but never reaches
      // ===END FILE=== isn't malformed - it was cut off by maxTokens
      // before it could finish. Distinguish that (actionable: the file is
      // too large for the current cap) from genuinely malformed output
      // (the model ignored the format entirely) instead of reporting both
      // the same way. Found via a live run against a 26KB source file.
      const looksTruncatedMidBlock = /===FILE:\s*.+?\s*===/.test(output.content) && !/===END FILE===/.test(output.content);
      const wasLengthCapped = (output.finishReason ?? "").toLowerCase().includes("length");
      if (looksTruncatedMidBlock || wasLengthCapped) {
        return {
          files: new Map(),
          success: false,
          reason:
            `Coder agent's response was cut off before it finished (started a ===FILE:=== block but never reached ` +
            `===END FILE===${wasLengthCapped ? "; provider reported finishReason=" + output.finishReason : ""}). ` +
            `The file is likely too large for the current maxTokens cap (${output.tokensUsed} tokens used). ` +
            `Raw response (last 500 chars): ${truncate(output.content.slice(-500), 500)}`,
        };
      }
      return {
        files: new Map(),
        success: false,
        reason: `Coder agent response did not use the required ===FILE:===...===END FILE=== format. Raw response (truncated): ${truncate(output.content, 500)}`,
      };
    }

    console.log(`   Writing ${blocks.length} file(s): ${blocks.map((b) => b.path).join(", ")}`);
    const written = applyFileBlocks(this.repositoryPath, blocks);
    console.log(`   Confidence: ${(output.confidence * 100).toFixed(0)}%`);
    return { files: written, success: true };
  }

  /**
   * Explicit, per-run dependency fence told to the Coder/Debugger agents.
   * Found necessary via a live run: the small local Ollama model, given
   * only a requirement like "add a greet(name) function", produced an
   * Angular `@Injectable` service — a hallucinated framework it has never
   * seen in this repo. Naming the real installed packages gives it far
   * less room to pattern-match to unrelated training data.
   */
  private dependencyConstraintText(): string {
    const declared = Array.from(this.declaredDependencies).sort().join(", ") || "(none declared)";
    return (
      `This project's ONLY installed npm packages are: ${declared}. ` +
      `It is a plain Bun/TypeScript backend project — NOT Angular, React, Vue, NestJS, or Express. ` +
      `Do NOT import any package that isn't in that list (e.g. no "@angular/core", "react", "express", ` +
      `"@nestjs/*", "lodash", "axios", etc.) unless the requirement explicitly asks you to add a new ` +
      `dependency. If you need functionality beyond what's listed, implement it with plain TypeScript ` +
      `and Node/Bun built-ins instead.`
    );
  }

  /**
   * Find file paths mentioned in the requirement/design/plan that already
   * exist in the repo, and return their real current content formatted for
   * the Coder prompt.
   *
   * Found necessary via a live run: given the trivial requirement "add a
   * one-line code comment above the callModel method in
   * src/core/conversation-intelligence.ts", the Coder agent was never shown
   * that file's real 770-line content - only its path, inside a plain-text
   * requirement string. With nothing to anchor to, it wrote a fresh ~35-line
   * reimplementation from scratch (the CODER_ROLE "Content: Complete file
   * content" instruction, taken literally with no existing content to
   * complete-*from*), silently deleting the real module and breaking every
   * file that imports from it. That only reached the working tree on a
   * throwaway feature branch (no --approve), so nothing was lost, but the
   * pipeline would do real damage the moment a real approved run touched an
   * existing file. Fix: actually read and inject the current content of any
   * existing file the task references, so "Complete file content" means
   * "the real file, with your edit applied" instead of "your best guess at
   * what a file like this might contain."
   */
  private existingFileContext(requirement: string, design: string, plan: string): string {
    // Repo-relative-looking paths: at least one directory segment, a
    // recognized extension. Deliberately permissive - false positives just
    // fail the existsSync check below and cost nothing.
    const pathPattern = /(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|json|md|ps1|sh|py|sql|yml|yaml)\b/g;
    const haystack = `${requirement}\n${design}\n${plan}`;
    const candidates = new Set(haystack.match(pathPattern) ?? []);

    const MAX_FILES = 5;
    const MAX_CHARS_PER_FILE = 20000;
    const sections: string[] = [];

    for (const relPath of candidates) {
      if (sections.length >= MAX_FILES) break;
      const normalized = relPath.replace(/^\.?\//, "");
      const resolved = path.resolve(this.repositoryPath, normalized);
      // Guard against a match that escapes the repo root (e.g. "../../etc/passwd").
      if (!resolved.startsWith(path.resolve(this.repositoryPath))) continue;
      try {
        let content = CodeReader.readFile(resolved);
        let truncatedNote = "";
        if (content.length > MAX_CHARS_PER_FILE) {
          content = content.slice(0, MAX_CHARS_PER_FILE);
          truncatedNote = "\n... [truncated - file is longer than shown]";
        }
        sections.push(
          `\n--- EXISTING CONTENT of ${normalized} (this file already exists - your file block\n` +
            `for this path MUST be the complete file below with your change applied, preserving\n` +
            `every line that isn't part of the requested change; do NOT rewrite or reinvent it) ---\n` +
            content +
            truncatedNote +
            `\n--- END EXISTING CONTENT of ${normalized} ---\n`
        );
      } catch {
        // Doesn't exist on disk (or isn't readable) - it's a new file, no
        // existing content to show. Nothing to do here.
      }
    }

    if (sections.length === 0) return "";
    return `\n\n${sections.join("\n")}`;
  }

  /**
   * Step 5: Build/compile verification — real, not LLM-guessed
   */
  private async step5_BuildCode(currentFiles: Map<string, string>): Promise<BuildResult> {
    console.log("\n🔨 STEP 5: Building Code (typecheck)");

    // Mechanical check, cheaper and far more specific than waiting for tsc
    // to surface a generic TS2307 for the same problem — see
    // findDisallowedImports for the live bug that made this necessary.
    const importErrors = findDisallowedImports(currentFiles, this.allowedPackages);
    if (importErrors.length > 0) {
      console.log("   ❌ Build failed — disallowed import(s) detected");
      console.log(`   Errors:\n${importErrors.join("\n")}`);
      return { success: false, errors: importErrors, warnings: [], output: importErrors.join("\n"), durationMs: 0 };
    }

    const result = runTypecheck(this.repositoryPath);
    console.log(`   ${result.success ? "✅ Build succeeded" : "❌ Build failed"} (${result.durationMs}ms)`);
    if (!result.success) {
      console.log(`   Errors:\n${result.errors.slice(0, 10).join("\n")}`);
    }
    return result;
  }

  /**
   * Step 6: Run tests — real, not LLM-guessed
   */
  private async step6_RunTests(): Promise<TestResult> {
    console.log("\n🧪 STEP 6: Running Tests");
    const result = runTests(this.repositoryPath);
    if (!result.configured) {
      console.log("   ℹ️  No test files found in repository — not treated as a failure.");
    } else {
      console.log(`   ${result.passed} passed, ${result.failed} failed (${result.durationMs}ms)`);
    }
    return result;
  }

  /**
   * Step 7: Debug failures (real Debugger agent call, real disk writes)
   */
  private async step7_DebugFailures(
    buildResult: BuildResult,
    testResult: TestResult,
    currentFiles: Map<string, string>
  ): Promise<{ filesChanged: number; files: Map<string, string>; rawResponse: string }> {
    console.log("\n🐛 STEP 7: Debugging Failures (Debugger Agent)");

    const currentFilesText = Array.from(currentFiles.entries())
      .map(([path, content]) => `--- ${path} ---\n${content}`)
      .join("\n\n");

    const failureText = [
      !buildResult.success ? `Build errors:\n${buildResult.errors.join("\n")}` : "",
      testResult.failed > 0 ? `Test output:\n${truncate(testResult.output, 4000)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const output = await this.agents.debugger.execute({
      taskId: this.runId,
      task: `The following files were just changed and are failing:\n\n${truncate(currentFilesText, 8000)}\n\n${failureText}\n\nFix the failure(s). Repository root: ${this.repositoryPath}\nAll file paths must be relative to the repository root.\n\n${this.dependencyConstraintText()}\n\nYou MUST respond with at least one ===FILE:===...===END FILE=== block containing the complete corrected file — a prose-only explanation with no file block will be treated as a failed attempt.`,
      context: {},
    });

    if (isNoChangesResponse(output.content)) {
      return { filesChanged: 0, files: new Map(), rawResponse: output.content };
    }

    const blocks = parseFileBlocks(output.content);
    if (blocks.length === 0) {
      console.log("   ⚠️  Debugger response did not use the required file-block format.");
      return { filesChanged: 0, files: new Map(), rawResponse: output.content };
    }

    console.log(`   Rewriting ${blocks.length} file(s): ${blocks.map((b) => b.path).join(", ")}`);
    const written = applyFileBlocks(this.repositoryPath, blocks);
    return { filesChanged: written.size, files: written, rawResponse: output.content };
  }

  /**
   * Step 8: Code review (real Code Reviewer agent call against the diff)
   */
  private async step8_ReviewCode(diff: string): Promise<{
    quality: number;
    issues: string[];
    approved: boolean;
  }> {
    console.log("\n👀 STEP 8: Code Review (Code Reviewer Agent)");
    const output = await this.agents.codeReviewer.execute({
      taskId: this.runId,
      task: `Review this diff:\n\n${truncate(diff, 12000)}`,
      context: {},
    });

    const quality = extractScore(output.content, /Rating[:\s]+(\d+)/i, Math.round(output.confidence * 100));
    const issues = extractBulletSection(output.content, "Issues");
    // Approved on quality alone — critical-issue gating is the Security
    // Reviewer's job (step 9), which runs independently on the same diff.
    const approved = quality >= 60;

    console.log(`   Quality: ${quality}/100 — ${approved ? "approved" : "not approved"}`);
    return { quality, issues, approved };
  }

  /**
   * Step 9: Security review (real Security Reviewer agent call against the diff)
   */
  private async step9_SecurityReview(diff: string): Promise<{
    riskLevel: "critical" | "high" | "medium" | "low";
    issues: string[];
    approved: boolean;
  }> {
    console.log("\n🔒 STEP 9: Security Review (Security Reviewer Agent)");
    const output = await this.agents.securityReviewer.execute({
      taskId: this.runId,
      task: `Review this diff for security implications:\n\n${truncate(diff, 12000)}`,
      context: {},
    });

    const riskMatch = output.content.match(/Risk Level[:\s]+(critical|high|medium|low)/i);
    const riskLevel = (riskMatch?.[1].toLowerCase() as "critical" | "high" | "medium" | "low") ?? "high"; // unrecognized output defaults to the conservative side
    const issues = extractBulletSection(output.content, "Critical Issues");
    // Never auto-approve critical/high risk without an explicit "Approved: yes"
    // from the reviewer — low/medium can pass on risk level alone.
    const explicitApproval = /Approved[:\s]+yes/i.test(output.content);
    const approved = explicitApproval || riskLevel === "low" || riskLevel === "medium";

    console.log(`   Risk level: ${riskLevel} — ${approved ? "approved" : "not approved"}`);
    return { riskLevel, issues, approved };
  }

  /**
   * Step 10: Final verification (deterministic gate — combines the real
   * signals from steps 5/6/8/9, no LLM call needed for this decision)
   */
  private async step10_Verify(
    codeQualityApproved: boolean,
    securityApproved: boolean,
    buildSucceeded: boolean,
    testsPass: boolean
  ): Promise<{
    recommendation: "approved_for_deployment" | "needs_fixes";
    issues: string[];
    requiresHumanApproval: boolean;
  }> {
    console.log("\n✅ STEP 10: Final Verification");
    const issues: string[] = [];
    if (!buildSucceeded) issues.push("Build is not passing.");
    if (!testsPass) issues.push("Tests are not passing.");
    if (!codeQualityApproved) issues.push("Code review did not approve.");
    if (!securityApproved) issues.push("Security review did not approve.");

    const recommendation =
      buildSucceeded && testsPass && codeQualityApproved && securityApproved
        ? "approved_for_deployment"
        : "needs_fixes";

    console.log(`   Recommendation: ${recommendation}`);
    // Deployment always requires a human, even when every automated check
    // passes — this is a fixed policy, not a per-task judgment call.
    return { recommendation, issues, requiresHumanApproval: true };
  }

  /**
   * Step 11: Human approval gate — real. No code path here fabricates
   * approval; it only reflects what the caller explicitly passed in.
   */
  private async step11_RequestHumanApproval(
    recommendation: string,
    options: DevelopFeatureOptions
  ): Promise<{ approved: boolean; approver?: string; notes: string }> {
    console.log("\n🔑 STEP 11: Human Approval Gate");
    console.log(`   Recommendation: ${recommendation}`);

    if (options.approved === true) {
      console.log(`   ✅ Approved by: ${options.approvedBy ?? "unspecified"}`);
      return {
        approved: true,
        approver: options.approvedBy ?? "unspecified",
        notes: "Approved via explicit `approved: true` option.",
      };
    }

    console.log("   ⏸️  AWAITING HUMAN APPROVAL — deployment will not proceed.");
    console.log("   Review the branch/diff, then re-run with `{ approved: true }` to deploy.");
    return {
      approved: false,
      notes: "No explicit approval was given — this is the expected default, not an error.",
    };
  }

  /**
   * Step 12: Deploy — commits, pushes the feature branch, and opens a PR
   * for human review. Never merges to the base branch directly; "deploy"
   * here means "put the change somewhere a human can merge it."
   */
  private async step12_Deploy(
    branchName: string,
    baseBranch: string,
    taskId: string,
    requirement: string
  ): Promise<{ success: boolean; prUrl?: string; branchPushed?: boolean; commitHash?: string }> {
    console.log("\n🚀 STEP 12: Deploy (open PR for human merge)");

    try {
      await this.gitManager.stageAll();
      const hasChanges = await this.gitManager.hasUncommittedChanges();
      // BUG FIX (2026-08-28, full-codebase review): `commit` used to be
      // declared inside this `if` block, so it was out of scope by the
      // `return` below — the function computed a real commit hash, logged
      // it, and then discarded it, always returning `commitHash: undefined`
      // even on a fully successful run. Hoisted so the real hash actually
      // reaches the caller (developFeature() assigns it to
      // result.gitCommit) instead of silently losing it from the audit
      // trail.
      let commitHash: string | undefined;
      if (hasChanges) {
        const commit = await this.gitManager.commit(
          `JARVIS Developer: ${requirement.slice(0, 72)}\n\nTask: ${taskId}`
        );
        commitHash = commit.hash;
        console.log(`   Committed: ${commit.hash}`);
      } else {
        console.log("   Nothing new to commit (already committed).");
      }

      let branchPushed = false;
      try {
        await this.gitManager.push(branchName);
        branchPushed = true;
        console.log(`   Pushed branch '${branchName}' to origin.`);
      } catch (pushError) {
        console.log(`   ⚠️  Could not push branch (offline or no remote): ${pushError instanceof Error ? pushError.message : pushError}`);
      }

      let prUrl: string | undefined;
      if (branchPushed) {
        prUrl = this.tryCreatePR(branchName, baseBranch, requirement, taskId);
        if (!prUrl) {
          prUrl = (await this.gitManager.getCompareUrl(baseBranch, branchName)) ?? undefined;
        }
      }

      const status = await this.gitManager.getStatus();
      console.log(prUrl ? `   PR: ${prUrl}` : "   No remote available — branch is local-only; review it directly on this machine.");

      return { success: true, prUrl, branchPushed, commitHash };
    } catch (error) {
      console.error(`   ❌ Deploy step failed: ${error instanceof Error ? error.message : error}`);
      return { success: false };
    }
  }

  /**
   * Best-effort `gh pr create` — many machines this runs on (e.g. a fresh
   * Windows install) won't have the GitHub CLI set up, so failure here
   * falls back to a manual compare URL rather than blocking deployment.
   */
  private tryCreatePR(
    branchName: string,
    baseBranch: string,
    requirement: string,
    taskId: string
  ): string | undefined {
    try {
      // SECURITY FIX (2026-08-28, full-codebase review): this used to build
      // a shell command string with `.replace(/"/g, '\\"')` as its only
      // defense — that escapes a literal `"` but does nothing about
      // `$(...)`/backtick command substitution or `;`/`&&` chaining, which
      // bash still expands even inside double quotes. Since `requirement`
      // (part of `body`) and `baseBranch` both ultimately come from
      // cli.ts's argv, this was a second real injection point, independent
      // of the one in git.ts. Fixed the same way: execFileSync with an
      // argv array — no shell involved, so title/body/branch names reach
      // `gh` as literal arguments no matter what characters they contain.
      const title = `JARVIS Developer: ${requirement.slice(0, 72)}`;
      const body = `Automated change from JARVIS Developer (Phase 1).\n\nTask: ${taskId}\nRequirement: ${requirement}\n\nThis PR was opened automatically after all automated checks passed and a human explicitly approved deployment. Review before merging.`;
      const output = execFileSync(
        "gh",
        ["pr", "create", "--base", baseBranch, "--head", branchName, "--title", title, "--body", body],
        { cwd: this.repositoryPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      const urlMatch = output.match(/https:\/\/github\.com\/\S+/);
      return urlMatch?.[0];
    } catch {
      return undefined;
    }
  }

  /**
   * Self-test: JARVIS Developer works on JARVIS codebase
   * This implements the compounding loop verification.
   *
   * Runs the real pipeline (no approval passed in, so it will stop at
   * "awaiting_human_approval" and never push/open a PR on its own) against
   * this repository. Requires GEMINI_API_KEY to be set — this is a live
   * LLM call, not a mock.
   */
  static async selfTest(): Promise<{
    success: boolean;
    report: string;
  }> {
    console.log("\n" + "=".repeat(70));
    console.log("🔄 COMPOUNDING LOOP VERIFICATION - JARVIS BUILDING JARVIS");
    console.log("=".repeat(70));
    console.log("\nThis test verifies that JARVIS can work on its own codebase,");
    console.log("creating the compounding loop: Better Core → Better Developer → Better JARVIS");

    try {
      console.log("\n📍 Self-Test Scenario:");
      console.log("   Requirement: Add a small, self-contained utility to JARVIS Phase 1");
      console.log("   Repository: JARVIS codebase (/home/workspace/JARVIS)");

      const developer = new JARVISDeveloper("/home/workspace/JARVIS");

      const result = await developer.developFeature(
        "Add a `formatDuration(ms: number): string` utility function to src/phase1/ " +
        "(new file, e.g. src/phase1/format.ts) that formats a millisecond duration as " +
        "a human-readable string (e.g. '1.2s', '3m 4s'). Export it. Do not modify any other files."
      );

      console.log("\n" + "=".repeat(70));
      console.log("📋 SELF-TEST RESULTS");
      console.log("=".repeat(70));

      if (result.status === "awaiting_human_approval" || result.status === "completed") {
        console.log("\n✅ COMPOUNDING LOOP VERIFIED");
        console.log("   JARVIS ran the real pipeline against its own codebase end to end.");
        console.log(`   Branch: ${result.branchName} — review this before approving deployment.`);
        return {
          success: true,
          report: `Self-test PASSED. Task: ${result.taskId}. Status: ${result.status}. Branch: ${result.branchName}`,
        };
      } else {
        console.log("\n⚠️  SELF-TEST DID NOT COMPLETE");
        console.log(`   Status: ${result.status}`);
        console.log(`   Issues: ${result.verificationResults.issues.join(", ")}`);
        return {
          success: false,
          report: `Self-test incomplete. Task: ${result.taskId}. Status: ${result.status}. Issues: ${result.verificationResults.issues.join("; ")}`,
        };
      }
    } catch (error) {
      console.error("\n❌ SELF-TEST FAILED");
      console.error(error instanceof Error ? error.message : String(error));
      return {
        success: false,
        report: `Self-test FAILED: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Development workflow summary
   */
  static printWorkflow() {
    console.log("\n🚀 JARVIS DEVELOPER - PHASE 1 COMPLETE PIPELINE");
    console.log("=".repeat(70));
    console.log("\nFull Pipeline (agents + human approval gate):");

    PHASE_1_AGENT_PIPELINE.forEach((agent, index) => {
      console.log(`  ${index + 1}. ${agent.role} (${agent.name})`);
    });

    console.log("\nKey Features:");
    console.log("  ✓ Full autonomous development pipeline, wired to a real LLM (OmniRoute → Ollama → Gemini → OpenRouter)");
    console.log("  ✓ Real build verification (bun run typecheck)");
    console.log("  ✓ Real test execution (bun test) — honestly reports 'no tests' rather than faking a pass");
    console.log("  ✓ Bounded auto-debug loop (max " + MAX_DEBUG_ATTEMPTS + " attempts) on build/test failure");
    console.log("  ✓ Code review + security review against the real git diff");
    console.log("  ✓ Human approval gate — never auto-approved, no simulated deploy");
    console.log("  ✓ Real git integration: branch, commit, push, PR (or compare-URL fallback)");
    console.log("  ✓ Self-test capability (compounding loop verification)");

    console.log("\n" + "=".repeat(70));
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + `\n...[truncated, ${text.length - maxLength} more characters]`;
}

/**
 * Extract a numeric score from agent prose via a labeled-field regex, with
 * a documented fallback (the agent's own self-reported confidence) rather
 * than a silent hardcoded number — mirrors the confidence-parsing pattern
 * already established in BaseAgent.execute().
 */
function extractScore(text: string, pattern: RegExp, fallback: number): number {
  const match = text.match(pattern);
  if (match) {
    const val = parseInt(match[1], 10);
    if (!Number.isNaN(val)) return Math.min(Math.max(val, 0), 100);
  }
  return fallback;
}

/**
 * Best-effort extraction of a labeled bullet section (e.g. "Issues:\n- a\n- b")
 * from free-form agent prose. Returns an empty array, not a guess, when the
 * section isn't found.
 */
function extractBulletSection(text: string, label: string): string[] {
  const sectionMatch = text.match(new RegExp(`${label}[:\\s]*\\n((?:[-*].*\\n?)+)`, "i"));
  if (!sectionMatch) return [];
  return sectionMatch[1]
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}
