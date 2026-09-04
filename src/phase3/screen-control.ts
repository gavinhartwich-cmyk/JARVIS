/**
 * Phase 3: Screen Control System
 *
 * JARVIS can operate the computer when tasks require it
 * Provides automated control of applications, windows, and interactions
 */

import { windowsController } from "./windows-control";
import { findElement } from "./ui-automation";
import { authorizationEngine } from "../core/authorization";
import type { IdentityResult } from "../core/identity";

export interface ControlAction {
  action: "click" | "type" | "scroll" | "key" | "open" | "close" | "focus" | "wait";
  target?: string; // window/app name or coordinates
  parameters?: {
    x?: number;
    y?: number;
    text?: string;
    key?: string;
    amount?: number;
    duration?: number;
  };
}

export interface ControlSequence {
  id: string;
  description: string;
  actions: ControlAction[];
  expectedOutcome: string;
  confirmBefore: boolean; // Requires user approval
  timestamp: Date;
}

export interface ControlResult {
  success: boolean;
  sequenceId: string;
  actionsTaken: number;
  output?: string;
  error?: string;
  screenBefore?: Buffer;
  screenAfter?: Buffer;
  executionTimeMs: number;
}

/**
 * Screen Control System
 *
 * Automates computer tasks through keyboard/mouse/window control
 */
export class ScreenControl {
  private sequences: Map<string, ControlSequence> = new Map();
  private executionHistory: ControlResult[] = [];
  private isOperating: boolean = false;

  constructor() {
    console.log("🖱️  Screen Control System initialized");
    console.log("   Ready for computer automation");
  }

  /**
   * Build a control sequence
   *
   * Example: "Click the save button and type filename"
   */
  buildSequence(description: string): ControlSequence {
    const sequence: ControlSequence = {
      id: `seq-${Date.now()}`,
      description,
      actions: [],
      expectedOutcome: "",
      confirmBefore: true,
      timestamp: new Date(),
    };

    console.log(`🛠️  Building control sequence: "${description}"`);
    console.log(`   ID: ${sequence.id}`);

    return sequence;
  }

  /**
   * Add action to sequence
   */
  addAction(sequence: ControlSequence, action: ControlAction): ControlSequence {
    sequence.actions.push(action);
    console.log(`   ➜ ${action.action}`);
    if (action.target) console.log(`      Target: ${action.target}`);
    if (action.parameters?.text) console.log(`      Text: "${action.parameters.text}"`);
    return sequence;
  }

  /**
   * Click at coordinates or on target
   */
  click(
    sequence: ControlSequence,
    targetOrX: string | number,
    y?: number
  ): ControlSequence {
    if (typeof targetOrX === "string") {
      // Click on target (button, window, etc)
      return this.addAction(sequence, {
        action: "click",
        target: targetOrX,
      });
    } else {
      // Click at coordinates
      return this.addAction(sequence, {
        action: "click",
        parameters: { x: targetOrX, y: y || 0 },
      });
    }
  }

  /**
   * Type text
   */
  type(sequence: ControlSequence, text: string): ControlSequence {
    return this.addAction(sequence, {
      action: "type",
      parameters: { text },
    });
  }

  /**
   * Press keyboard key or combination
   */
  key(sequence: ControlSequence, key: string): ControlSequence {
    return this.addAction(sequence, {
      action: "key",
      parameters: { key }, // e.g., "ctrl+s", "enter", "escape"
    });
  }

  /**
   * Open application
   */
  open(sequence: ControlSequence, application: string): ControlSequence {
    return this.addAction(sequence, {
      action: "open",
      target: application,
    });
  }

  /**
   * Close window or application
   */
  close(sequence: ControlSequence, target: string): ControlSequence {
    return this.addAction(sequence, {
      action: "close",
      target,
    });
  }

  /**
   * Focus window
   */
  focus(sequence: ControlSequence, windowTitle: string): ControlSequence {
    return this.addAction(sequence, {
      action: "focus",
      target: windowTitle,
    });
  }

  /**
   * Scroll
   */
  scroll(sequence: ControlSequence, amount: number): ControlSequence {
    return this.addAction(sequence, {
      action: "scroll",
      parameters: { amount },
    });
  }

  /**
   * Wait
   */
  wait(sequence: ControlSequence, durationMs: number): ControlSequence {
    return this.addAction(sequence, {
      action: "wait",
      parameters: { duration: durationMs },
    });
  }

  /**
   * Set expected outcome
   */
  expectOutcome(sequence: ControlSequence, outcome: string): ControlSequence {
    sequence.expectedOutcome = outcome;
    console.log(`   Expected: ${outcome}`);
    return sequence;
  }

  /**
   * Set whether sequence requires confirmation before execution
   */
  setRequiresConfirmation(
    sequence: ControlSequence,
    confirm: boolean
  ): ControlSequence {
    sequence.confirmBefore = confirm;
    return sequence;
  }

  /**
   * Execute a control sequence for real, on Windows, via `windowsController`.
   * Every sequence is authorized before anything runs (invariant #2/#6 —
   * an agent requesting control is not the same as being allowed to do it).
   */
  async executeSequence(
    sequence: ControlSequence,
    identity: IdentityResult
  ): Promise<ControlResult> {
    console.log(`\n⚙️  Executing control sequence: "${sequence.description}"`);

    if (this.isOperating) {
      return {
        success: false,
        sequenceId: sequence.id,
        actionsTaken: 0,
        error: "Control system is already operating. Please wait.",
        executionTimeMs: 0,
      };
    }

    // BUG FIX (2026-08-28, full-codebase review): `isOperating` used to be
    // set to `true` only after the `await authorizationEngine.authorize()`
    // call below — but the busy-check above and that flag-set were
    // separated by a real async gap (the awaited authorize() call). Two
    // executeSequence() calls arriving close together (e.g. two
    // overlapping voice commands) could both read `isOperating === false`,
    // both proceed through authorize(), and both then set it true and run
    // their keyboard/mouse action loops concurrently against the same real
    // desktop — defeating the whole point of the mutex (serializing
    // automation so one sequence's clicks/keystrokes can't land in the
    // wrong window mid-sequence). Claiming the lock here, synchronously,
    // right after the busy-check and before any `await`, closes that gap;
    // the `finally` below still guarantees it's released on every exit
    // path, including a denied/failed authorization.
    this.isOperating = true;
    try {
      const auth = await authorizationEngine.authorize(identity, "computer_control", "normal");
      if (!auth.allowed) {
        console.log(`\n🔒 Authorization denied: ${auth.reason}`);
        return {
          success: false,
          sequenceId: sequence.id,
          actionsTaken: 0,
          error: `Blocked: ${auth.reason}`,
          executionTimeMs: 0,
        };
      }

      if (sequence.confirmBefore) {
        console.log(`\n⚠️  This sequence is marked as requiring confirmation:`);
        console.log(`   Sequence: ${sequence.description}`);
        console.log(`   Actions: ${sequence.actions.length}`);
        console.log(`   Expected: ${sequence.expectedOutcome}`);
        console.log(`   (No interactive confirmation UI yet — proceeding since authorization already passed.)`);
      }

      return await this.runSequenceActions(sequence);
    } finally {
      this.isOperating = false;
    }
  }

  /**
   * Runs the actual action loop once the lock is held and authorization
   * has passed — split out of executeSequence() so the outer try/finally
   * there can guarantee `isOperating` is released on every exit path
   * (including a denied authorization) without this method needing to
   * know about the lock at all.
   */
  private async runSequenceActions(sequence: ControlSequence): Promise<ControlResult> {
    const startTime = Date.now();
    let actionsTaken = 0;

    try {
      console.log(`\n🎬 Executing ${sequence.actions.length} actions...`);

      // [ADDED 2026-09-03] Real per-action details (currently only
      // "open" produces one - see executeAction()'s own comment),
      // collected so the final output can honestly reflect what actually
      // happened instead of a generic "N actions completed" that can't
      // tell Gavin apart a real app opening from a fallback search.
      const details: string[] = [];
      for (let i = 0; i < sequence.actions.length; i++) {
        const action = sequence.actions[i];
        console.log(`   [${i + 1}/${sequence.actions.length}] ${action.action}`);

        const detail = await this.executeAction(action);
        if (detail) details.push(detail);
        actionsTaken++;
      }

      const executionTimeMs = Date.now() - startTime;

      const result: ControlResult = {
        success: true,
        sequenceId: sequence.id,
        actionsTaken,
        executionTimeMs,
        output: details.length > 0 ? details.join("; ") : `Successfully completed ${actionsTaken} actions in ${executionTimeMs}ms`,
      };

      console.log(`\n✅ Sequence completed successfully`);
      console.log(`   Actions: ${actionsTaken}/${sequence.actions.length}`);
      console.log(`   Time: ${executionTimeMs}ms`);

      this.executionHistory.push(result);
      this.sequences.set(sequence.id, sequence);

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const executionTimeMs = Date.now() - startTime;

      const result: ControlResult = {
        success: false,
        sequenceId: sequence.id,
        actionsTaken,
        error: errorMsg,
        executionTimeMs,
      };

      console.log(`\n❌ Sequence failed after ${actionsTaken} actions`);
      console.log(`   Error: ${errorMsg}`);

      this.executionHistory.push(result);
      return result;
    }
  }

  /**
   * Executes one action for real via windowsController. See that file's
   * header comment — written and typechecked here, never run here, needs
   * verification on the actual PC.
   *
   * [UPDATE 2026-09-03] Now returns an optional real detail string - per
   * Gavin's real ask about "open youtube" needing to fall back to a
   * browser search honestly, the "open" case's real outcome
   * (opened a real app / a known website / fell back to search) needs to
   * reach the final conversational reply, not just be logged to console
   * and discarded.
   */
  private async executeAction(action: ControlAction): Promise<string | undefined> {
    switch (action.action) {
      case "click":
        if (action.parameters?.x !== undefined) {
          console.log(`      → Clicking at (${action.parameters.x}, ${action.parameters.y ?? 0})`);
          await windowsController.click(action.parameters.x, action.parameters.y ?? 0);
        } else if (action.target) {
          // [2026-09-02] Real click-by-name, replacing the previous
          // unconditional throw here. Per Gavin: "screen control is
          // supposed to be able to do things like click buttons etc just
          // like you can instead of use api keys thats much clunkier."
          // Vision-based location was tried and found genuinely unreliable
          // (see ui-automation.ts's own header comment for the real test
          // that proved it) - real element lookup instead uses Windows'
          // own UI Automation accessibility API, which gives an exact
          // bounding rectangle straight from the OS, no guessing. Searches
          // the current real foreground window by default.
          console.log(`      → Locating "${action.target}" via UI Automation...`);
          const element = await findElement(action.target);
          if (!element) {
            throw new Error(
              `Couldn't find a clickable "${action.target}" in the current window via Windows' accessibility ` +
                `API - either the wording doesn't match its real on-screen label, or this app doesn't expose ` +
                `that control to accessibility tools (common for custom-rendered UI, canvas-based content, or ` +
                `some games). Use coordinates (x, y) instead if you know where it is.`
            );
          }
          console.log(`      → Found "${element.name}" (${element.controlType}) at (${element.x}, ${element.y}) - clicking`);
          await windowsController.click(element.x, element.y);
        }
        break;

      case "type":
        if (action.parameters?.text) {
          console.log(`      → Typing: "${action.parameters.text}"`);
          await windowsController.typeText(action.parameters.text);
        }
        break;

      case "key":
        if (action.parameters?.key) {
          console.log(`      → Pressing: ${action.parameters.key}`);
          await windowsController.pressKey(action.parameters.key);
        }
        break;

      case "open":
        if (action.target) {
          console.log(`      → Opening: ${action.target}`);
          const detail = await windowsController.openApplication(action.target);
          console.log(`      → ${detail}`);
          return detail;
        }
        break;

      case "close":
        if (action.target) {
          console.log(`      → Closing: ${action.target}`);
          await windowsController.closeApplication(action.target);
        }
        break;

      case "focus":
        if (action.target) {
          console.log(`      → Focusing: ${action.target}`);
          await windowsController.focusWindow(action.target);
        }
        break;

      case "scroll":
        if (action.parameters?.amount !== undefined) {
          console.log(`      → Scrolling: ${action.parameters.amount} units`);
          await windowsController.scroll(action.parameters.amount);
        }
        break;

      case "wait":
        if (action.parameters?.duration) {
          console.log(`      → Waiting: ${action.parameters.duration}ms`);
          await new Promise((resolve) => setTimeout(resolve, action.parameters!.duration));
        }
        break;
    }
  }

  /**
   * Execute common control patterns
   */

  /**
   * Click and type (for form input)
   */
  async clickAndType(
    targetButton: string,
    textToType: string,
    identity: IdentityResult
  ): Promise<ControlResult> {
    const seq = this.buildSequence(`Click ${targetButton} and type`);
    this.click(seq, targetButton);
    this.type(seq, textToType);
    return this.executeSequence(seq, identity);
  }

  /**
   * Open application and wait for it to load
   */
  async openApp(appName: string, identity: IdentityResult, waitMs: number = 2000): Promise<ControlResult> {
    const seq = this.buildSequence(`Open ${appName}`);
    this.open(seq, appName);
    this.wait(seq, waitMs);
    return this.executeSequence(seq, identity);
  }

  /**
   * Close/quit application. Added 2026-08-27 alongside openApp() so
   * conversational "close Spotify"/"quit Notepad" requests (see
   * `Orchestrator.parseAppControlIntent`) have the same one-call shape as
   * opening one — same authorization gate, same real
   * `windowsController.closeApplication()` underneath (best-effort
   * `Stop-Process` by name; a no-match is not an error).
   */
  async closeApp(appName: string, identity: IdentityResult): Promise<ControlResult> {
    const seq = this.buildSequence(`Close ${appName}`);
    this.close(seq, appName);
    return this.executeSequence(seq, identity);
  }

  /**
   * Find and click (search for target, then click) - real as of 2026-09-02,
   * via UI Automation (see executeAction()'s "click" case / ui-automation.ts).
   */
  async findAndClick(description: string, targetName: string, identity: IdentityResult): Promise<ControlResult> {
    const seq = this.buildSequence(description);
    this.click(seq, targetName);
    return this.executeSequence(seq, identity);
  }

  /**
   * Get execution history
   */
  getHistory(limit: number = 20): ControlResult[] {
    return this.executionHistory.slice(-limit);
  }

  /**
   * Get system status
   */
  getStatus(): {
    isOperating: boolean;
    sequencesCreated: number;
    sequencesExecuted: number;
    successRate: number;
  } {
    const totalExecuted = this.executionHistory.length;
    const successful = this.executionHistory.filter((r) => r.success).length;
    const successRate =
      totalExecuted > 0 ? successful / totalExecuted : 0;

    return {
      isOperating: this.isOperating,
      sequencesCreated: this.sequences.size,
      sequencesExecuted: totalExecuted,
      successRate,
    };
  }

  /**
   * Clear history
   */
  clearHistory() {
    this.executionHistory = [];
  }

  /**
   * Get sequence by ID
   */
  getSequence(id: string): ControlSequence | undefined {
    return this.sequences.get(id);
  }
}
