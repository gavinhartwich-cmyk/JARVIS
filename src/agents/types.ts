import { ModelConfig } from "../models/types";
import { ToolCall } from "../tools/types";

/**
 * Agent abstraction
 * Each agent has a specific role and isolated context
 */

export interface AgentInput {
  taskId: string;
  task: string;
  context: Record<string, unknown>;
  constraints?: string[];
  previousResults?: Record<string, unknown>;
}

export interface AgentOutput {
  taskId: string;
  agentName: string;
  content: string;
  reasoning: string;
  confidence: number; // 0-1
  tokensUsed: number;
  toolCalls?: ToolCall[]; // Agents can request tools
  metadata?: Record<string, unknown>;
}

export interface Agent {
  name: string;
  role: string;
  instructions: string;
  modelConfig: ModelConfig;

  execute(input: AgentInput): Promise<AgentOutput>;
}

/**
 * Predefined agent roles for the verification pipeline
 */

export const AGENT_ROLES = {
  RESEARCHER: {
    name: "researcher",
    role: "Researcher",
    instructions: `You are a research agent. Your job is to:
1. Find relevant information and evidence
2. Identify sources
3. Check for conflicts or gaps
4. Report what you find accurately

Focus on gathering information, not on solving the problem.
Be precise about what you know vs what you're inferring.`,
  },
  REASONER: {
    name: "reasoner",
    role: "Reasoner",
    instructions: `You are a reasoning agent. Your job is to:
1. Take the research findings
2. Apply logical reasoning
3. Propose solutions or conclusions
4. Show your work step-by-step

Be clear about your assumptions. Explain how you reached your conclusion.`,
  },
  CRITIC: {
    name: "critic",
    role: "Critic",
    instructions: `You are a critic agent. Your job is to:
1. Take the proposed solution
2. Try to prove it wrong
3. Find weaknesses, edge cases, or flaws
4. Identify assumptions that might be invalid

Be rigorous. Your goal is to find problems, not confirm the solution.`,
  },
  FACT_CHECKER: {
    name: "fact-checker",
    role: "Fact Checker",
    instructions: `You are a fact-checking agent. Your job is to:
1. Take important claims from the analysis
2. Verify them against available information
3. Rate confidence in each claim
4. Flag anything uncertain or contradicted

Be specific about confidence levels. Note what you cannot verify.`,
  },
  VERIFIER: {
    name: "verifier",
    role: "Verifier",
    instructions: `You are a verification agent. Your job is to:
1. Synthesize all previous agent outputs
2. Identify agreements and disagreements
3. Determine overall confidence in the result
4. Flag unresolved conflicts

Rate the final result as: UNVERIFIED, PARTIALLY_VERIFIED, VERIFIED, or CONFLICTED.`,
  },
  SYNTHESIZER: {
    name: "synthesizer",
    role: "Synthesizer",
    instructions: `You are a synthesis agent. Your job is to:
1. Take all verified information
2. Combine it into a coherent, final answer
3. Be clear about certainty levels
4. Provide structured output

Produce a clear, actionable result based on what we know with confidence.`,
  },
};
