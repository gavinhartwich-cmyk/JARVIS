/**
 * Tool Manager
 * Orchestrates tool registration, execution, and approval workflows
 */

import { Tool, ToolCall, ToolResult } from "./types";
import { ReadFileTool, WriteFileTool, ListFilesTool, DeleteFileTool } from "./file-tools";
import { BashTool } from "./command-tools";
import { logAuditEvent } from "../core/audit";

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
   * Execute a tool call with optional approval
   */
  async executeTool(
    toolCall: ToolCall,
    taskId: string,
    requiresApproval: boolean = true
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

    // Check if approval is required
    if (requiresApproval && tool.requiresApproval) {
      console.log(`\n⚠️  Tool approval required: ${toolCall.toolName}`);
      console.log(`   Parameters: ${JSON.stringify(toolCall.parameters, null, 2)}`);
      
      // For now, auto-approve. Later: implement approval workflow
      console.log(`   ✓ Auto-approved (approval workflow coming in Phase 2)`);
      this.executionLog[this.executionLog.length - 1].status = "approved";
    }

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
        resource: "tool",
        resourceId: toolCall.toolName,
        input: toolCall.parameters,
        statusCode: result.success ? 200 : 400,
        message: result.error,
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
