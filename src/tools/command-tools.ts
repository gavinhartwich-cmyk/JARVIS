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

      // HARDENING (2026-08-28, full-codebase review): this was an
      // exact-substring match against three fixed literal strings — case
      // ("RM -RF /"), extra whitespace ("rm  -rf /"), swapped flags
      // ("rm -fr /"), or a different target ("dd if=/dev/urandom
      // of=/dev/sda" instead of the hardcoded of=/dev/zero) all passed
      // through untouched. This is NOT the real security boundary (that's
      // the admin-tier authorization gate in ToolManager, which this tool
      // is already behind via requiresApproval=true below) — a
      // sufficiently determined caller who has already cleared that gate
      // can still run anything a blocklist can't enumerate. This is
      // widened and normalized (case-insensitive, whitespace-collapsed,
      // regex-based) purely to stop it from being a false sense of a
      // second layer of protection that a trivial reformatting defeats.
      const normalized = command.toLowerCase().replace(/\s+/g, " ").trim();
      const dangerousPatterns: RegExp[] = [
        /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(\s|$)/, // rm -rf / (any flag order/case)
        /\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+\/(\s|$)/, // rm -fr /
        /\bdd\s+if=\S+\s+of=\/dev\/(sd|nvme|hd|disk)/, // dd onto a real block device
        /:\(\)\s*\{\s*:\s*\|\s*:&?\s*\}\s*;\s*:/, // fork bomb
        /\bmkfs(\.\w+)?\s+\/dev\//, // formatting a real device
        />\s*\/dev\/(sd|nvme|hd|disk)/, // redirect straight onto a real device
      ];

      if (dangerousPatterns.some((p) => p.test(normalized))) {
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
