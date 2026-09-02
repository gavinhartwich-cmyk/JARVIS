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

Be precise and show your reasoning. After your COMPLETE answer, end your
response on its own final line with EXACTLY this format and nothing else
on that line:
<<<CONFIDENCE: X.XX>>>
where X.XX is your genuine self-assessed confidence in the answer above,
from 0.00 (no confidence) to 1.00 (certain). This line is stripped out
before your answer is used, so it will never appear inside a file, a
code block, or any content you're producing — always add it as the true
final line regardless of what format the rest of your answer takes.`;

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
        timeoutMs: this.modelConfig.timeoutMs,
      });

      const duration = Date.now() - startTime;

      // [2026-09-02] Real fix for a real, confirmed bug: this used to ask
      // for confidence in free prose ("rate your confidence... 0-1") and
      // hope a regex caught it - it usually didn't. Confirmed directly:
      // omniroute-provider.ts (the primary, most-used provider) never
      // populates response.confidence at all, so most agent runs
      // silently fell all the way through to the hardcoded 0.7 fallback
      // below - not a rare edge case, the common path.
      //
      // Real fix: the system prompt above now asks for a small,
      // distinctive trailing marker (<<<CONFIDENCE: X.XX>>>) instead of
      // free prose - reliably extractable with a simple end-anchored
      // regex. Deliberately NOT a full JSON-wrapped response (the
      // obvious-looking alternative): that would have broken the Coder/
      // Debugger agents' raw ===FILE===/===EDIT=== block output, which
      // developer.ts's parseFileBlocks()/parseEditBlocks() regex-parse
      // directly from response.content (see patch.ts) - wrapping that in
      // JSON would corrupt exactly the agents most prone to already
      // struggling with output-format compliance. The marker is always
      // stripped from content below before anything downstream sees it,
      // so no agent's real output changes shape - only how reliably its
      // confidence is captured.
      let confidence: number;
      let confidenceSource: string;
      let content = response.content;

      const markerMatch = content.match(/\n?<<<\s*CONFIDENCE\s*:\s*([0-9.]+)\s*>>>\s*$/i);
      if (typeof response.confidence === "number") {
        confidence = response.confidence;
        confidenceSource = "provider (structured output)";
        if (markerMatch) content = content.slice(0, markerMatch.index).trimEnd();
      } else if (markerMatch) {
        let val = parseFloat(markerMatch[1]);
        if (val > 1) val = val / 100; // tolerate an accidental percentage
        confidence = Math.min(Math.max(val, 0), 1);
        confidenceSource = "trailing marker (real, model-reported)";
        content = content.slice(0, markerMatch.index).trimEnd();
      } else {
        const confidenceMatch = content.match(/confidence[:\s]+([0-9.]+)/i);
        if (confidenceMatch) {
          let val = parseFloat(confidenceMatch[1]);
          if (val > 1) val = val / 100; // Handle percentages
          confidence = Math.min(Math.max(val, 0), 1);
          confidenceSource = "regex fallback (parsed from prose)";
        } else {
          confidence = 0.7;
          confidenceSource = "hardcoded fallback — provider gave no structured confidence, no marker, and prose parsing failed";
          console.warn(`   ⚠️  ${this.name}: ${confidenceSource}. This is not a real score.`);
        }
      }

      const output: AgentOutput = {
        taskId: input.taskId,
        agentName: this.name,
        content,
        reasoning: content, // Full response contains reasoning
        confidence,
        tokensUsed: response.tokensUsed,
        finishReason: response.finishReason,
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
