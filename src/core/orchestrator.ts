import { Agent, AgentInput, AgentOutput } from "../agents/types";
import { getDatabase } from "../db/client";
import { tasks, agentRuns } from "../db/schema";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { logAuditEvent } from "./audit";
import { storeMemory } from "./memory";
import { TaskDecomposer } from "./task-decomposer";

/**
 * Orchestrator
 * Central coordinator for multi-agent reasoning
 * Manages task decomposition and agent execution
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
}
