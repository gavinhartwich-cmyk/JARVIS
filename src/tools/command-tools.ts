/**
 * Command Execution Tools
 * Allow JARVIS to execute shell commands and scripts
 */

import { Tool, ToolResult, ParameterDefinition } from "./types";
import { exec } from "child_process";
import { promisify } from "util";

const execPromise = promisify(exec);

export class BashTool implements Tool {
  name = "bash";
  description = "Execute a bash command";
  parameters: Record<string, ParameterDefinition> = {
    command: {
      type: "string",
      description: "The bash command to execute",
      required: true,
    },
    timeout: {
      type: "number",
      description: "Command timeout in milliseconds (default: 30000)",
      required: false,
      default: 30000,
    },
  };
  requiresApproval = true;

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const command = String(parameters.command);
      const timeout = Number(parameters.timeout || 30000);

      const dangerousPatterns = [
        "rm -rf /",
        "dd if=/dev/zero",
        ":(){ :|:& };:",
      ];

      if (dangerousPatterns.some((p) => command.includes(p))) {
        return {
          success: false,
          error: "Command blocked: Potentially dangerous operation",
          executionTime: Date.now() - startTime,
        };
      }

      const { stdout, stderr } = await execPromise(command, { timeout });

      return {
        success: true,
        data: { command, stdout, stderr, exitCode: 0 },
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMsg,
        executionTime: Date.now() - startTime,
      };
    }
  }
}
