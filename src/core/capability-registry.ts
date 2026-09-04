/**
 * Capability Registry (architecture update section 14)
 *
 *   JARVIS → Capability Registry → Tools / Plugins / MCP → Executors
 *
 * Before this, "what can JARVIS do" was split across two unrelated
 * dispatch points that every caller had to know about separately:
 * `ToolManager` (read_file/write_file/list_files/delete_file/bash) and a
 * hardcoded `if (action.name === "open_app") ... else ...` in
 * `VoiceInterface.executeKnownAction` that called `ScreenControl` directly
 * and duplicated the action-journal call ToolManager already does for its
 * own tools. Adding a new screen-control-backed capability meant editing
 * that voice-interface branch by hand — exactly what section 14 says a new
 * capability shouldn't require.
 *
 * This registry is the single lookup/execution point instead: `list()`
 * enumerates everything (ToolManager's tools plus screen-control actions),
 * and `execute()` runs any of them uniformly — authorization and
 * action-journal recording happen once, here or in the executor it
 * delegates to, not duplicated per call site.
 *
 * Deliberately NOT an MCP client/server itself. Section 14 is explicit:
 * "MCP may be used as a standardized capability interface where
 * appropriate... Do not make MCP the intelligence layer." A future MCP
 * bridge would register its tools into `list()`/`execute()` the same way
 * screen-control's are added below — as another executor behind this
 * registry, not as a replacement for it.
 */

import type { ToolResult } from "../tools/types";
import { toolManager } from "../tools/manager";
import { ScreenControl } from "../phase3/screen-control";
import type { RiskTier } from "./authorization";
import type { IdentityResult } from "./identity";
import { recordAction, inverseOfScreenControlAction } from "./action-journal";

export interface CapabilityDescriptor {
  name: string;
  description: string;
  riskTier: RiskTier;
  system: "tool_manager" | "screen_control";
}

const SCREEN_CONTROL_CAPABILITIES: Record<"open_app" | "close_app", { description: string; riskTier: RiskTier }> = {
  open_app: { description: "Open an application on the user's computer by name.", riskTier: "normal" },
  close_app: { description: "Close an application on the user's computer by name.", riskTier: "normal" },
};

class CapabilityRegistry {
  private screenControl = new ScreenControl();

  /** Everything JARVIS can currently do, regardless of which executor backs it. */
  list(): CapabilityDescriptor[] {
    const toolCapabilities: CapabilityDescriptor[] = toolManager.getAvailableTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      riskTier: tool.requiresApproval ? "admin" : "normal",
      system: "tool_manager",
    }));

    const screenCapabilities: CapabilityDescriptor[] = (
      Object.keys(SCREEN_CONTROL_CAPABILITIES) as Array<"open_app" | "close_app">
    ).map((name) => ({
      name,
      description: SCREEN_CONTROL_CAPABILITIES[name].description,
      riskTier: SCREEN_CONTROL_CAPABILITIES[name].riskTier,
      system: "screen_control",
    }));

    return [...toolCapabilities, ...screenCapabilities];
  }

  has(name: string): boolean {
    return this.list().some((c) => c.name === name);
  }

  /**
   * Run any registered capability by name. Callers (the intent router's
   * TOOL path, an agent's structured tool call, a future MCP bridge) don't
   * need to know which system actually executes it.
   */
  async execute(
    name: string,
    parameters: Record<string, unknown>,
    identity: IdentityResult,
    taskId?: string
  ): Promise<ToolResult> {
    if (name === "open_app" || name === "close_app") {
      return this.executeScreenControl(name, parameters, identity, taskId);
    }
    // ToolManager already handles authorization and action-journal
    // recording for its own tools (tools/manager.ts) — no need to repeat
    // either here.
    return toolManager.executeTool({ toolName: name, parameters }, taskId ?? "capability-registry", identity);
  }

  private async executeScreenControl(
    name: "open_app" | "close_app",
    parameters: Record<string, unknown>,
    identity: IdentityResult,
    taskId?: string
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const target = typeof parameters.target === "string" ? parameters.target : "";
    if (!target) {
      return { success: false, error: `${name} called without a 'target' parameter.`, executionTime: 0 };
    }

    const result =
      name === "open_app"
        ? await this.screenControl.openApp(target, identity)
        : await this.screenControl.closeApp(target, identity);

    void recordAction({
      taskId,
      system: "screen_control",
      tool: name,
      parameters: { target },
      success: result.success,
      result: result.success ? undefined : { error: result.error },
      riskTier: SCREEN_CONTROL_CAPABILITIES[name].riskTier,
      inverseAction: result.success ? inverseOfScreenControlAction(name, target) : null,
    });

    return {
      success: result.success,
      data: result.output,
      error: result.error,
      executionTime: Date.now() - startTime,
    };
  }
}

export const capabilityRegistry = new CapabilityRegistry();
