/**
 * Universal Action Journal + Undo (architecture update sections 10-11)
 *
 * Every executable action — whether run through ToolManager or a direct
 * executor like ScreenControl — gets one row here: what ran, its
 * parameters/result, its risk tier, and (where one exists) its inverse.
 * This is the foundation for "undo that" / "undo the last action" /
 * "undo the last three actions" — implemented here, at the execution
 * layer, not inside the conversational layer, per section 11.
 *
 * Not every action is reversible. "Where possible" (section 11) is taken
 * literally: reversible=false + inverseAction=null is the normal, honest
 * outcome for read-only actions (read_file, list_files) and genuinely
 * one-way ones (bash — arbitrary commands have no general inverse). Two
 * cases get a real inverse today:
 *   - open_app / close_app (ScreenControl): swapping the verb is a clean,
 *     well-defined inverse.
 *   - write_file / delete_file (ToolManager): the inverse is "restore
 *     whatever was there before" — which only exists if the prior content
 *     was captured before the action ran. ToolManager.executeTool does
 *     that snapshot itself for these two tools specifically (see there).
 */

import { getDatabase } from "../db/client";
import { actionJournal } from "../db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { RiskTier } from "./authorization";
import type { IdentityResult } from "./identity";
import { toolManager } from "../tools/manager";
import { ScreenControl } from "../phase3/screen-control";

export type ExecutionSystem = "tool_manager" | "screen_control";

export interface InverseAction {
  tool: string;
  parameters: Record<string, unknown>;
}

export interface RecordActionInput {
  taskId?: string;
  system: ExecutionSystem;
  tool: string;
  parameters: Record<string, unknown>;
  success: boolean;
  result?: Record<string, unknown>;
  riskTier: RiskTier;
  inverseAction?: InverseAction | null;
  /** Set when this recorded action IS an undo — points at the action it reversed. */
  undoOfActionId?: string;
}

/** Records one action. Never throws — a journal write failing shouldn't take down the action it's recording, same convention as core/audit.ts and core/memory.ts. The tradeoff: an unrecorded action can't later be undone, which is the honest cost of that choice, not a hidden one. */
export async function recordAction(input: RecordActionInput): Promise<string | null> {
  try {
    const db = getDatabase();
    const id = uuid();
    await db.insert(actionJournal).values({
      id,
      taskId: input.taskId,
      system: input.system,
      tool: input.tool,
      parameters: input.parameters,
      success: input.success,
      result: input.result,
      riskTier: input.riskTier,
      reversible: !!input.inverseAction,
      inverseAction: input.inverseAction ?? undefined,
      undoOfActionId: input.undoOfActionId,
      createdAt: new Date(),
    });
    return id;
  } catch (error) {
    console.error("Failed to record action journal entry:", error);
    return null;
  }
}

/** Computes the inverse of an open_app/close_app ScreenControl action — swapping the verb is a clean, always-defined inverse for these two. */
export function inverseOfScreenControlAction(action: "open_app" | "close_app", target: string): InverseAction {
  return { tool: action === "open_app" ? "close_app" : "open_app", parameters: { target } };
}

/**
 * Computes the inverse of a write_file/delete_file ToolManager action,
 * given the file's content immediately before the action ran (or undefined
 * if it didn't exist). Returns null for anything else — no general inverse
 * exists for read_file, list_files, or bash.
 */
export function inverseOfFileAction(
  tool: string,
  parameters: Record<string, unknown>,
  priorContent: string | undefined
): InverseAction | null {
  const path = typeof parameters.path === "string" ? parameters.path : undefined;
  if (!path) return null;

  if (tool === "write_file" || tool === "delete_file") {
    return priorContent === undefined
      ? { tool: "delete_file", parameters: { path } } // didn't exist before → undo by removing it again
      : { tool: "write_file", parameters: { path, content: priorContent } };
  }
  return null;
}

async function listUndoableActions(limit: number, taskId?: string) {
  const db = getDatabase();
  const conditions = [eq(actionJournal.reversible, true), isNull(actionJournal.undoneAt)];
  if (taskId) conditions.push(eq(actionJournal.taskId, taskId));
  return db
    .select()
    .from(actionJournal)
    .where(and(...conditions))
    .orderBy(desc(actionJournal.createdAt))
    .limit(limit);
}

export interface UndoResult {
  actionId: string;
  tool: string;
  success: boolean;
  error?: string;
}

/**
 * Undoes the most recent `count` reversible, not-yet-undone actions (most
 * recent first), optionally scoped to one task. Re-executes each action's
 * stored inverse through whichever system originally ran it, marks the
 * original undone, and journals the undo itself as its own action (with
 * undoOfActionId set) — so undoing is itself part of the action history,
 * not a special case outside it.
 */
export async function undoLastActions(
  count: number,
  identity: IdentityResult,
  taskId?: string
): Promise<UndoResult[]> {
  const db = getDatabase();
  const toUndo = await listUndoableActions(count, taskId);
  const results: UndoResult[] = [];

  for (const entry of toUndo) {
    const inverse = entry.inverseAction as InverseAction | null;
    if (!inverse) {
      results.push({ actionId: entry.id, tool: entry.tool, success: false, error: "no inverse action recorded" });
      continue;
    }

    let success = false;
    let error: string | undefined;
    try {
      if (entry.system === "tool_manager") {
        const result = await toolManager.executeTool(
          { toolName: inverse.tool, parameters: inverse.parameters },
          entry.taskId ?? "undo",
          identity
        );
        success = result.success;
        error = result.error;
      } else {
        const screenControl = new ScreenControl();
        const target = String(inverse.parameters.target ?? "");
        const result =
          inverse.tool === "open_app"
            ? await screenControl.openApp(target, identity)
            : await screenControl.closeApp(target, identity);
        success = result.success;
        error = result.error;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    if (success) {
      try {
        await db.update(actionJournal).set({ undoneAt: new Date() }).where(eq(actionJournal.id, entry.id));
      } catch (e) {
        console.error("Failed to mark action as undone:", e);
      }
    }

    await recordAction({
      taskId: entry.taskId ?? undefined,
      system: entry.system as ExecutionSystem,
      tool: inverse.tool,
      parameters: inverse.parameters,
      success,
      result: error ? { error } : undefined,
      riskTier: entry.riskTier as RiskTier,
      undoOfActionId: entry.id,
    });

    results.push({ actionId: entry.id, tool: entry.tool, success, error });
  }

  return results;
}
