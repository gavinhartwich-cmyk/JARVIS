/**
 * Tool Manager
 * Orchestrates tool registration, execution, and approval workflows
 */

import { Tool, ToolCall, ToolResult } from "./types";
import { ReadFileTool, WriteFileTool, ListFilesTool, DeleteFileTool } from "./file-tools";
import { BashTool } from "./command-tools";
import { logAuditEvent } from "../core/audit";
import { authorizationEngine, type RiskTier } from "../core/authorization";
import type { IdentityResult } from "../core/identity";
import { recordAction, inverseOfFileAction } from "../core/action-journal";
import * as fs from "fs/promises";

export class ToolManager {
  private tools: Map<string, Tool> = new Map();
  private executionLog: Array<{
    toolName: string;
    status: "requested" | "approved" | "rejected" | "executed";
    timestamp: Date;
    parameters: Record<string, unknown>;
    result?: ToolResult;
  }> = [];

  constructor() {
    // Register file system tools
    this.registerTool(new ReadFileTool());
    this.registerTool(new WriteFileTool());
    this.registerTool(new ListFilesTool());
    this.registerTool(new DeleteFileTool());
    
    // Register command execution tools
    this.registerTool(new BashTool());
  }

  registerTool(tool: Tool) {
    this.tools.set(tool.name, tool);
    console.log(`   📌 Registered tool: ${tool.name}`);
  }

  /**
   * Get all available tools
   */
  getAvailableTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool by name
   */
  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Tools flagged requiresApproval are admin-tier (need Level 3/verified);
   * everything else is normal-tier (needs Level 2/gavin) — UNLESS
   * authorizationEngine's own name-based classifier (ADMIN_ACTIONS /
   * LOW_RISK_ACTIONS in authorization.ts, meant to cover master plan Part
   * 3.3's explicit high-risk-action list) says otherwise, in which case
   * the more restrictive of the two wins.
   *
   * BUG FIX (2026-08-28, full-codebase review): every real call site in
   * the codebase passes an explicit `riskTierOverride` into
   * authorizationEngine.authorize() — this method was the one doing that
   * for every tool call — which means `inferRiskTier()`'s name-based
   * classifier was DEAD CODE: it never actually ran, for any tool, ever.
   * The safety net that looks like it protects actions named
   * "access_credentials", "modify_security_settings", etc. by name
   * provided zero real enforcement; protection depended entirely on every
   * tool author remembering to set `requiresApproval` correctly (which
   * happens to be right for the tools that exist today, but a future tool
   * whose author forgets it — reasonably assuming the name-based list
   * already covers it — would have silently run at normal/Level 2 with no
   * PIN). Now both signals are consulted and the stricter one wins,
   * changing nothing for any tool that was already classified correctly
   * (bash/write_file/delete_file still resolve to "admin", read_file/
   * list_files still resolve to "normal") while actually closing the gap
   * for one that isn't.
   */
  private riskTierFor(tool: Tool): RiskTier {
    const RANK: Record<RiskTier, number> = { low: 0, normal: 1, admin: 2 };
    const declared: RiskTier = tool.requiresApproval ? "admin" : "normal";
    const inferred = authorizationEngine.inferRiskTier(tool.name);
    return RANK[inferred] > RANK[declared] ? inferred : declared;
  }

  /**
   * Execute a tool call. `identity` is REQUIRED and is resolved through the
   * AuthorizationEngine before anything runs — this replaced a prior
   * "auto-approve, log a line" placeholder that never actually blocked
   * anything (invariant #2: LLM output is not automatic permission).
   */
  async executeTool(
    toolCall: ToolCall,
    taskId: string,
    identity: IdentityResult
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolCall.toolName);

    if (!tool) {
      return {
        success: false,
        error: `Tool not found: ${toolCall.toolName}`,
        executionTime: 0,
      };
    }

    // Log the request
    this.executionLog.push({
      toolName: toolCall.toolName,
      status: "requested",
      timestamp: new Date(),
      parameters: toolCall.parameters,
    });

    const authResult = await authorizationEngine.authorize(
      identity,
      tool.name,
      this.riskTierFor(tool)
    );

    if (!authResult.allowed) {
      this.executionLog[this.executionLog.length - 1].status = "rejected";
      console.log(`\n🔒 Authorization denied for "${toolCall.toolName}": ${authResult.reason}`);
      await logAuditEvent({
        actor: "tool_manager",
        action: "blocked",
        // [FIXED 2026-09-04] Real bug found live (same class as screen-
        // control.ts's control-sequence id, found in the same session):
        // resourceId was toolCall.toolName ("read_file", "open_app", ...)
        // - a plain tool name, not a UUID - but audit_events.resource_id
        // (db/schema.ts) is a real `uuid` column. Every single tool
        // execution's audit write failed outright with a Postgres 22P02
        // "invalid input syntax for type uuid" error, silently (logAuditEvent
        // swallows its own errors so the real tool result was never
        // affected) - real audit coverage for every read_file/write_file/
        // bash/etc. call was quietly zero. Fixed by folding the tool name
        // into `resource` itself (there's no real persistent resource row
        // a stateless tool call corresponds to, so resourceId is correctly
        // left unset rather than fabricating a meaningless UUID).
        resource: `tool:${toolCall.toolName}`,
        input: toolCall.parameters,
        statusCode: 403,
        message: authResult.reason,
      });
      return {
        success: false,
        error:
          authResult.decision === "needs_verification"
            ? `Blocked: ${authResult.reason} Provide PIN verification and retry.`
            : `Blocked: ${authResult.reason}`,
        executionTime: 0,
      };
    }

    this.executionLog[this.executionLog.length - 1].status = "approved";

    // Snapshot prior content BEFORE running a destructive file action —
    // this is the only way write_file/delete_file can have a real inverse
    // (architecture update section 11: "MOVE A → B stores MOVE B → A").
    // Best-effort: a missing file just means "didn't exist before", not a
    // failure worth blocking the actual action over.
    const priorContent = await this.snapshotPriorFileContent(toolCall);

    try {
      // Execute the tool
      const result = await tool.execute(toolCall.parameters);

      // Log the result
      this.executionLog[this.executionLog.length - 1].status = "executed";
      this.executionLog[this.executionLog.length - 1].result = result;

      // Audit the execution
      await logAuditEvent({
        actor: "tool_manager",
        action: "executed",
        // [FIXED 2026-09-04] Real bug found live (same class as screen-
        // control.ts's control-sequence id, found in the same session):
        // resourceId was toolCall.toolName ("read_file", "open_app", ...)
        // - a plain tool name, not a UUID - but audit_events.resource_id
        // (db/schema.ts) is a real `uuid` column. Every single tool
        // execution's audit write failed outright with a Postgres 22P02
        // "invalid input syntax for type uuid" error, silently (logAuditEvent
        // swallows its own errors so the real tool result was never
        // affected) - real audit coverage for every read_file/write_file/
        // bash/etc. call was quietly zero. Fixed by folding the tool name
        // into `resource` itself (there's no real persistent resource row
        // a stateless tool call corresponds to, so resourceId is correctly
        // left unset rather than fabricating a meaningless UUID).
        resource: `tool:${toolCall.toolName}`,
        input: toolCall.parameters,
        statusCode: result.success ? 200 : 400,
        message: result.error,
      });

      // Action journal (architecture update section 10): record every
      // executed action, not just denials/audit — this is what undo reads
      // from. Never blocks the tool's own result on a journal failure
      // (recordAction swallows its own errors).
      await recordAction({
        taskId,
        system: "tool_manager",
        tool: toolCall.toolName,
        parameters: toolCall.parameters,
        success: result.success,
        result: result.success ? undefined : { error: result.error },
        riskTier: this.riskTierFor(tool),
        inverseAction: result.success ? inverseOfFileAction(toolCall.toolName, toolCall.parameters, priorContent) : null,
      });

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.executionLog[this.executionLog.length - 1].status = "executed";

      return {
        success: false,
        error: errorMsg,
        executionTime: 0,
      };
    }
  }

  /** Reads a file's content before a write_file/delete_file call so its inverse can be computed after. Returns undefined for any other tool, or if the file didn't exist / couldn't be read (both are "nothing to restore", not errors). */
  private async snapshotPriorFileContent(toolCall: ToolCall): Promise<string | undefined> {
    if (toolCall.toolName !== "write_file" && toolCall.toolName !== "delete_file") return undefined;
    const path = toolCall.parameters.path;
    if (typeof path !== "string") return undefined;
    try {
      return await fs.readFile(path, "utf-8");
    } catch {
      return undefined;
    }
  }

  /**
   * Get execution history
   */
  getExecutionHistory() {
    return this.executionLog;
  }

  /**
   * Clear execution history
   */
  clearHistory() {
    this.executionLog = [];
  }
}

export const toolManager = new ToolManager();
