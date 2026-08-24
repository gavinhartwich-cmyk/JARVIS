/**
 * Dynamic Task Decomposer
 * Routes tasks to appropriate agent pipelines based on task type and intent
 */

import { TaskDecomposition } from "./orchestrator";

export type TaskType =
  | "research"
  | "reasoning"
  | "code_write"
  | "code_debug"
  | "code_review"
  | "explanation"
  | "planning"
  | "analysis"
  | "verification"
  | "synthesis";

export interface TaskAnalysis {
  type: TaskType;
  confidence: number; // 0-1
  keywords: string[];
  complexity: "simple" | "moderate" | "complex";
  requiresExternalTools: boolean;
  estimatedDuration: number; // seconds
}

export class TaskDecomposer {
  /**
   * Analyze a task and determine its type and requirements
   */
  analyzeTask(userInput: string): TaskAnalysis {
    const lower = userInput.toLowerCase();

    // Task type detection
    let type: TaskType = "reasoning";
    let complexity: "simple" | "moderate" | "complex" = "moderate";
    let requiresExternalTools = false;
    const keywords: string[] = [];

    // Code-related tasks
    if (
      /write|implement|create|build|code/.test(lower) &&
      /function|class|module|api|service/.test(lower)
    ) {
      type = "code_write";
      complexity = "complex";
      keywords.push("code", "implementation");
      requiresExternalTools = true;
    } else if (/debug|fix|error|bug|issue/.test(lower)) {
      type = "code_debug";
      complexity = "moderate";
      keywords.push("debug", "error");
      requiresExternalTools = true;
    } else if (/review|audit|check|quality/.test(lower)) {
      type = "code_review";
      complexity = "moderate";
      keywords.push("review", "quality");
    }
    // Explanation tasks
    else if (/explain|how does|what is|why|understand|learn/.test(lower)) {
      type = "explanation";
      complexity = "simple";
      keywords.push("explanation", "education");
    }
    // Planning tasks
    else if (/plan|strategy|roadmap|architecture|design/.test(lower)) {
      type = "planning";
      complexity = "complex";
      keywords.push("planning", "strategy");
    }
    // Analysis tasks
    else if (/analyze|compare|evaluate|assess/.test(lower)) {
      type = "analysis";
      complexity = "moderate";
      keywords.push("analysis");
    }
    // Research tasks
    else if (/research|find|discover|search|look up/.test(lower)) {
      type = "research";
      complexity = "simple";
      keywords.push("research");
      requiresExternalTools = true;
    }
    // Default: general reasoning
    else {
      type = "reasoning";
      keywords.push("reasoning");
    }

    const estimatedDuration = {
      simple: 30,
      moderate: 60,
      complex: 120,
    }[complexity];

    return {
      type,
      confidence: 0.75,
      keywords,
      complexity,
      requiresExternalTools,
      estimatedDuration,
    };
  }

  /**
   * Generate agent pipeline based on task type
   */
  getAgentPipeline(type: TaskType): string[] {
    const pipelines: Record<TaskType, string[]> = {
      // Simple research: Find info → synthesize
      research: ["researcher", "synthesizer"],

      // Complex reasoning: Research → Reason → Critique → Verify → Synthesize
      reasoning: [
        "researcher",
        "reasoner",
        "critic",
        "fact-checker",
        "synthesizer",
      ],

      // Code writing: Architect → Code → Test → Review → Verify
      code_write: [
        "architect",
        "coder",
        "tester",
        "code-reviewer",
        "security-reviewer",
        "synthesizer",
      ],

      // Debugging: Error Analyzer → Debugger → Test → Code Reviewer
      code_debug: [
        "error-analyzer",
        "debugger",
        "tester",
        "code-reviewer",
        "synthesizer",
      ],

      // Code review: Code Reviewer → Security Reviewer → Performance Analyzer
      code_review: [
        "code-reviewer",
        "security-reviewer",
        "performance-analyzer",
        "synthesizer",
      ],

      // Explanation: Researcher → Explainer → Simplifier
      explanation: ["researcher", "explainer", "simplifier", "synthesizer"],

      // Planning: Architect → Planner → Critic → Verifier
      planning: ["architect", "planner", "critic", "verifier", "synthesizer"],

      // Analysis: Researcher → Analyzer → Critic → Synthesizer
      analysis: ["researcher", "analyzer", "critic", "synthesizer"],

      // Verification: Fact Checker → Verifier
      verification: ["fact-checker", "verifier", "synthesizer"],

      // Synthesis: Just synthesize
      synthesis: ["synthesizer"],
    };

    return pipelines[type] || pipelines.reasoning;
  }

  /**
   * Build a complete task decomposition
   */
  decompose(userInput: string): TaskDecomposition {
    const analysis = this.analyzeTask(userInput);
    const agentSequence = this.getAgentPipeline(analysis.type);

    return {
      mainGoal: userInput,
      subgoals: [
        `Analyze task: ${analysis.type}`,
        `Gather information and context`,
        `Apply reasoning and problem-solving`,
        `Verify and validate results`,
        `Synthesize final answer`,
      ],
      agentSequence,
      metadata: {
        taskType: analysis.type,
        complexity: analysis.complexity,
        requiresExternalTools: analysis.requiresExternalTools,
        estimatedDuration: analysis.estimatedDuration,
        keywords: analysis.keywords,
      },
    };
  }
}
