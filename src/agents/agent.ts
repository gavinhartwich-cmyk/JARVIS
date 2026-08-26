import { Agent, AgentInput, AgentOutput } from "./types";
import { ModelConfig, ModelProvider, ModelMessage } from "../models/types";
import { logAuditEvent } from "../core/audit";

/**
 * Base Agent implementation
 * Agents are isolated reasoning units with specific roles
 */

export class BaseAgent implements Agent {
  name: string;
  role: string;
  instructions: string;
  modelConfig: ModelConfig;
  private modelProvider: ModelProvider;

  constructor(
    name: string,
    role: string,
    instructions: string,
    modelConfig: ModelConfig,
    modelProvider: ModelProvider
  ) {
    this.name = name;
    this.role = role;
    this.instructions = instructions;
    this.modelConfig = modelConfig;
    this.modelProvider = modelProvider;
  }

  async execute(input: AgentInput): Promise<AgentOutput> {
    const startTime = Date.now();

    try {
      // Build the agent's context
      const systemPrompt = `${this.instructions}

Your role: ${this.role}
Task ID: ${input.taskId}

Context you have:
${JSON.stringify(input.context, null, 2)}

${
  input.previousResults
    ? `Previous agent results:\n${JSON.stringify(input.previousResults, null, 2)}`
    : ""
}

${input.constraints ? `Constraints:\n${input.constraints.join("\n")}` : ""}

Be precise, show your reasoning, and rate your confidence in your answer (0-1).`;

      // Create messages for the model
      const messages: ModelMessage[] = [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: input.task,
        },
      ];

      // Call the model provider
      const response = await this.modelProvider.complete(messages, {
        temperature: this.modelConfig.temperature || 0.7,
        maxTokens: this.modelConfig.maxTokens || 2000,
      });

      const duration = Date.now() - startTime;

      // Confidence should come from the provider's structured output
      // (real, model-reported). Regex-parsing prose is a fallback for a
      // provider that doesn't support structured output, not the primary
      // path — that's what silently produced identical fake-looking 70%
      // scores across every agent before this was fixed.
      let confidence: number;
      let confidenceSource: string;
      if (typeof response.confidence === "number") {
        confidence = response.confidence;
        confidenceSource = "provider (structured output)";
      } else {
        const confidenceMatch = response.content.match(/confidence[:\s]+([0-9.]+)/i);
        if (confidenceMatch) {
          let val = parseFloat(confidenceMatch[1]);
          if (val > 1) val = val / 100; // Handle percentages
          confidence = Math.min(Math.max(val, 0), 1);
          confidenceSource = "regex fallback (parsed from prose)";
        } else {
          confidence = 0.7;
          confidenceSource = "hardcoded fallback — provider gave no structured confidence and prose parsing failed";
          console.warn(`   ⚠️  ${this.name}: ${confidenceSource}. This is not a real score.`);
        }
      }

      const output: AgentOutput = {
        taskId: input.taskId,
        agentName: this.name,
        content: response.content,
        reasoning: response.content, // Full response contains reasoning
        confidence,
        tokensUsed: response.tokensUsed,
      };

      // Log the agent run
      await logAuditEvent({
        actor: this.name,
        action: "completed",
        resource: "agent_run",
        resourceId: input.taskId,
        result: {
          agentName: this.name,
          confidence,
          confidenceSource,
          tokensUsed: response.tokensUsed,
          duration,
        },
        statusCode: 200,
      });

      return output;
    } catch (error) {
      const duration = Date.now() - startTime;

      await logAuditEvent({
        actor: this.name,
        action: "failed",
        resource: "agent_run",
        resourceId: input.taskId,
        statusCode: 500,
        message: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }
}
