/**
 * Tool Execution Framework
 * Allows agents to interact with external systems
 */

export interface ToolCall {
  toolName: string;
  parameters: Record<string, unknown>;
  requiresApproval?: boolean;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  executionTime: number;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, ParameterDefinition>;
  requiresApproval?: boolean;
  execute(parameters: Record<string, unknown>): Promise<ToolResult>;
}

export interface ParameterDefinition {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  required: boolean;
  default?: unknown;
}

/**
 * Tool categories (used for permission and capability mapping)
 */
export enum ToolCategory {
  FILESYSTEM = "filesystem",
  API = "api",
  COMMAND = "command",
  CODE = "code",
  RESEARCH = "research",
  COMMUNICATION = "communication",
  MEMORY = "memory",
}

/**
 * Tool permissions (what JARVIS is allowed to do)
 */
export interface ToolPermissions {
  read: string[];
  write: string[];
  execute: string[];
  dangerous: string[];
}
