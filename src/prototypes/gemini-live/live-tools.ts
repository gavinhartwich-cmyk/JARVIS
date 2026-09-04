/**
 * The "one JARVIS tool" the step 4 prototype is required to exercise.
 *
 * Reuses the exact same deterministic executor the FAST/TOOL router
 * (core/intent-router.ts, phase2/voice-interface.ts's executeKnownAction)
 * already uses for "open <app>" — this prototype proves the realtime
 * transport can reach a real JARVIS capability, not a fake demo tool, and
 * proves it without duplicating the open-app logic a second time.
 */

import type { FunctionDeclaration } from "./protocol";
import { ScreenControl } from "../../phase3/screen-control";
import { identityEngine } from "../../core/identity";

export const OPEN_APP_DECLARATION: FunctionDeclaration = {
  name: "open_app",
  description: "Open an application on the user's computer by name.",
  parameters: {
    type: "OBJECT",
    properties: {
      target: {
        type: "STRING",
        description: "Name of the application to open, e.g. 'Notepad' or 'Spotify'.",
      },
    },
    required: ["target"],
  },
};

export function createOpenAppToolHandler(screenControl: ScreenControl = new ScreenControl()) {
  return async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const target = typeof args.target === "string" ? args.target : undefined;
    if (!target) {
      return { success: false, error: "open_app called without a 'target' argument." };
    }
    try {
      const identity = await identityEngine.resolveFromDeviceSession();
      const result = await screenControl.openApp(target, identity);
      return { success: result.success, output: result.output, error: result.error };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}
