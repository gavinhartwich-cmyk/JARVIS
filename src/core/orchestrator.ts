import { Agent, AgentInput, AgentOutput } from "../agents/types";
import { getDatabase } from "../db/client";
import { tasks, agentRuns } from "../db/schema";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { logAuditEvent } from "./audit";
import { storeMemory } from "./memory";
import { TaskDecomposer } from "./task-decomposer";
import { toolManager } from "../tools/manager";
import { ConversationEngine } from "../phase2/conversation-engine";
import { ConversationalIntelligence } from "./conversation-intelligence";
import { IntelligentModelRouter } from "./model-router";

/**
 * Orchestrator with Conversational Intelligence
 *
 * Central coordinator that integrates:
 * - Multi-agent reasoning
 * - Conversational state management
 * - Intelligent model routing
 * - Memory systems (short + long-term)
 * - Proactive monitoring
 * - Natural interaction
 */

export interface TaskDecomposition {
  mainGoal: string;
  subgoals: string[];
  agentSequence: string[];
  metadata?: Record<string, unknown>;
}

export interface OrchestrationResult {
  taskId: string;
  finalResult: string;
  confidence: number;
  verificationStatus: string;
  agentOutputs: Record<string, AgentOutput>;
  conflicts?: string[];
  evidence: string[];
}

export class Orchestrator {
  private agents: Map<string, Agent> = new Map();
  private decomposer = new TaskDecomposer();

  // Conversational intelligence integration
  private conversationEngine: ConversationEngine;
  private conversationalIntelligence: ConversationalIntelligence;
  private modelRouter: IntelligentModelRouter;

  constructor() {
    // Initialize conversational layer
    this.conversationEngine = new ConversationEngine();
    this.modelRouter = new IntelligentModelRouter();
    this.conversationalIntelligence = new ConversationalIntelligence(
      this.conversationEngine,
      this.modelRouter
    );

    // Set up proactive monitors
    this.setupProactiveMonitors();
  }

  /**
   * Setup proactive monitoring capabilities
   */
  private setupProactiveMonitors(): void {
    // Monitor for unfinished tasks
    this.conversationalIntelligence.registerProactiveMonitor(
      "pending-tasks",
      async () => {
        const context = this.conversationEngine.getConversationContext();
        if (
          context.workingMemory.currentTask &&
          this.conversationEngine.getStatus().pendingActionsCount > 0
        ) {
          return `You have ${this.conversationEngine.getStatus().pendingActionsCount} pending actions.`;
        }
        return null;
      }
    );

    // Monitor for conversation length
    this.conversationalIntelligence.registerProactiveMonitor(
      "long-conversation",
      async () => {
        const status = this.conversationEngine.getStatus();
        if (status.turnCount > 20) {
          return "We've been talking for a while. Would you like a summary?";
        }
        return null;
      }
    );
  }

  registerAgent(agent: Agent) {
    this.agents.set(agent.name, agent);
  }

  async orchestrate(userTask: string): Promise<OrchestrationResult> {
    const taskId = uuid();
    const db = getDatabase();

    // Step 1: Create task record
    console.log(`\n📋 Task ${taskId}: ${userTask}`);

    await db.insert(tasks).values({
      id: taskId,
      title: userTask.substring(0, 100),
      description: userTask,
      userInput: userTask,
      status: "created",
    });

    await logAuditEvent({
      actor: "orchestrator",
      action: "created",
      resource: "task",
      resourceId: taskId,
      input: { userInput: userTask },
      statusCode: 200,
    });

    try {
      // Step 2: Decompose task
      console.log(`\n🔍 Decomposing task...`);
      const decomposition = await this.decomposeTask(userTask, taskId);

      await db
        .update(tasks)
        .set({ decomposition: decomposition as any, status: "decomposed" })
        .where(eq(tasks.id, taskId));

      // Step 3: Execute agent pipeline
      console.log(`\n⚙️  Executing agent pipeline: ${decomposition.agentSequence.join(" → ")}`);
      const agentOutputs: Record<string, AgentOutput> = {};
      const context: Record<string, unknown> = {
        originalTask: userTask,
        decomposition,
        toolResults: {} as Record<string, unknown>,
      };

      for (const agentName of decomposition.agentSequence) {
        const agent = this.agents.get(agentName);
        if (!agent) {
          throw new Error(`Agent not found: ${agentName}`);
        }

        console.log(`\n  → Running ${agentName}...`);
        const agentInput: AgentInput = {
          taskId,
          task: userTask,
          context,
          previousResults: agentOutputs,
        };

        const output = await agent.execute(agentInput);
        agentOutputs[agentName] = output;

        // NEW: Execute any tool calls the agent requested
        if (output.toolCalls && output.toolCalls.length > 0) {
          console.log(`\n  🔧 Executing ${output.toolCalls.length} tool call(s)...`);
          const toolResults: Record<string, unknown> = {};

          for (const toolCall of output.toolCalls) {
            console.log(`     → ${toolCall.toolName}`);
            const result = await toolManager.executeTool(toolCall, taskId);
            toolResults[toolCall.toolName] = result;
            
            if (result.success) {
              console.log(`       ✓ Success (${result.executionTime}ms)`);
            } else {
              console.log(`       ✗ Failed: ${result.error}`);
            }
          }

          // Store tool results in context for next agent
          const toolResultsMap = context.toolResults as Record<string, unknown>;
          context.toolResults = { ...toolResultsMap, ...toolResults };
        }

        // Store in database
        await db.insert(agentRuns).values({
          taskId,
          agentName,
          role: agent.role,
          status: "completed",
          input: agentInput as any,
          output: output as any,
          modelProvider: agent.modelConfig.provider,
          modelName: agent.modelConfig.model,
          confidence: String(output.confidence),
          verificationStatus: "unverified",
          tokensUsed: output.tokensUsed,
          completedAt: new Date(),
        });

        // Update context for next agent
        context[agentName] = output;

        console.log(`     Confidence: ${(output.confidence * 100).toFixed(0)}%`);
      }

      // Step 4: Synthesize results
      console.log(`\n✨ Synthesizing results...`);
      const finalResult = await this.synthesizeResults(
        agentOutputs,
        userTask,
        taskId
      );

      // Step 5: Store results and memory
      await db
        .update(tasks)
        .set({
          status: "completed",
          result: finalResult as any,
          confidence: String(finalResult.confidence),
          verificationStatus: finalResult.verificationStatus,
          completedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));

      // Store key findings in memory
      await storeMemory({
        type: "episode",
        content: `Task: ${userTask}\n\nResult: ${finalResult.result}`,
        importance: Math.round(finalResult.confidence * 10),
        confidence: String(finalResult.confidence),
        source: `task_${taskId}`,
      });

      console.log(`\n✅ Task complete!`);
      console.log(`   Status: ${finalResult.verificationStatus}`);
      console.log(`   Confidence: ${(finalResult.confidence * 100).toFixed(0)}%`);

      return {
        taskId,
        finalResult: finalResult.result,
        confidence: finalResult.confidence,
        verificationStatus: finalResult.verificationStatus,
        agentOutputs,
        conflicts: finalResult.conflicts,
        evidence: finalResult.evidence,
      };
    } catch (error) {
      await db
        .update(tasks)
        .set({ status: "failed" })
        .where(eq(tasks.id, taskId));

      await logAuditEvent({
        actor: "orchestrator",
        action: "failed",
        resource: "task",
        resourceId: taskId,
        statusCode: 500,
        message: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  private async decomposeTask(
    userTask: string,
    taskId: string
  ): Promise<TaskDecomposition> {
    // Use dynamic task decomposer instead of fixed pipeline
    return this.decomposer.decompose(userTask);
  }

  private async synthesizeResults(
    outputs: Record<string, AgentOutput>,
    task: string,
    taskId: string
  ): Promise<{
    result: string;
    confidence: number;
    verificationStatus: "unverified" | "partially_verified" | "verified" | "conflicted" | "failed";
    conflicts: string[];
    evidence: string[];
  }> {
    const synthesizer = this.agents.get("synthesizer");
    if (!synthesizer) {
      throw new Error("Synthesizer agent not registered");
    }

    const synthInput: AgentInput = {
      taskId,
      task: `Original task: ${task}\n\nAll agent outputs:\n${Object.entries(outputs)
        .map(([name, output]) => `${name}: ${output.content}`)
        .join("\n\n")}`,
      context: { agentOutputs: outputs },
      previousResults: outputs,
    };

    const synthOutput = await synthesizer.execute(synthInput);

    // Determine overall verification status
    const avgConfidence =
      Object.values(outputs).reduce((sum, o) => sum + o.confidence, 0) /
      Object.keys(outputs).length;

    type VerificationStatus = "unverified" | "partially_verified" | "verified" | "conflicted" | "failed";
    let verificationStatus: VerificationStatus = "unverified";
    if (avgConfidence >= 0.9) {
      verificationStatus = "verified";
    } else if (avgConfidence >= 0.7) {
      verificationStatus = "partially_verified";
    }

    return {
      result: synthOutput.content,
      confidence: synthOutput.confidence,
      verificationStatus,
      conflicts: [],
      evidence: Object.values(outputs).map((o) => o.content),
    };
  }

  /**
   * Process user input with conversational intelligence
   *
   * Replaces simple task strings with context-aware conversation
   */
  async processConversation(userUtterance: string): Promise<{
    response: string;
    taskId?: string;
    context: ReturnType<ConversationEngine["getConversationContext"]>;
  }> {
    // Use conversational intelligence to process utterance
    const stream = await this.conversationalIntelligence.processWithStreaming(
      userUtterance
    );

    // In production: stream tokens to TTS
    // For now: collect full response
    const response = stream.text;

    // Extract task if implied
    let taskId: string | undefined;
    const conversationContext = this.conversationEngine.getConversationContext();

    if (this.isTaskRequest(userUtterance)) {
      // Would decompose and execute as task
      console.log(`\n📋 Implied task detected in conversation`);
    }

    // Record in memory
    this.conversationalIntelligence.completeTurn(userUtterance, response);

    return {
      response,
      taskId,
      context: conversationContext,
    };
  }

  /**
   * Check if utterance implies a task to be executed
   */
  private isTaskRequest(utterance: string): boolean {
    const taskKeywords = [
      "do",
      "make",
      "create",
      "build",
      "write",
      "generate",
      "find",
      "fetch",
      "research",
      "analyze",
    ];

    const lower = utterance.toLowerCase();
    return taskKeywords.some((keyword) => lower.includes(keyword));
  }

  /**
   * Get conversational context for integration with voice/text interfaces
   */
  getConversationContext() {
    return this.conversationEngine.getConversationContext();
  }

  /**
   * Get memory status
   */
  getMemoryStatus() {
    return this.conversationalIntelligence.getMemoryStatus();
  }

  /**
   * Get model router status
   */
  getModelRouterStatus() {
    return this.modelRouter.getStatus();
  }

  /**
   * Get full orchestrator status
   */
  getOrchestratorStatus() {
    return {
      agents: this.agents.size,
      conversation: this.conversationEngine.getStatus(),
      memory: this.conversationalIntelligence.getMemoryStatus(),
      modelRouter: this.modelRouter.getStatus(),
    };
  }

  /**
   * Register semantic fact in memory
   */
  recordSemanticFact(key: string, fact: string, confidence?: number): void {
    this.conversationalIntelligence.recordSemanticFact(key, fact, confidence);
  }

  /**
   * Register procedure in memory
   */
  recordProcedure(
    name: string,
    steps: string[],
    variations?: Record<string, string[]>
  ): void {
    this.conversationalIntelligence.recordProcedure(name, steps, variations);
  }
}
