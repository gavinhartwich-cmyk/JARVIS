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
import { spotifyPlayWithAutoOpen, spotifyPause, spotifyResume, spotifyNext, spotifyPrevious } from "./spotify";
import { clickByDescription } from "./vision-click";

/**
 * [EXTENDED 2026-09-04] Real, recursive parameter schema - per Gavin's
 * direct ask: "i dont want a easier way to add actions i want a simpler
 * way to make bigger dents in more actions... more actions in one
 * thing." A flat string/number/boolean-only shape can only describe one
 * atomic action's arguments - it can't describe "an array of steps,"
 * which is what a genuinely general multi-step capability (run_actions,
 * below) needs to accept a whole real plan as one structured parameter
 * instead of one bespoke tool call per step. `items`/`properties` mirror
 * protocol.ts's own FunctionParameterSchema (which this gets converted
 * into by live-voice-interface.ts's registerCapabilitiesAsTools()) -
 * kept as a separate type rather than importing that one directly so
 * core/ doesn't depend on prototypes/gemini-live/.
 */
export interface CapabilityParameter {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  required: boolean;
  /** Required when type is "array" - the schema of each element. */
  items?: CapabilityParameter;
  /** Required when type is "object". */
  properties?: Record<string, CapabilityParameter>;
}

export interface CapabilityDescriptor {
  name: string;
  description: string;
  riskTier: RiskTier;
  system: "tool_manager" | "screen_control" | "spotify";
  parameters: Record<string, CapabilityParameter>;
}

const SCREEN_CONTROL_CAPABILITIES: Record<"open_app" | "close_app", { description: string; riskTier: RiskTier }> = {
  open_app: { description: "Open an application on the user's computer by name.", riskTier: "normal" },
  close_app: { description: "Minimize a window (native app or browser tab) by matching its title.", riskTier: "normal" },
};

/**
 * [ADDED 2026-09-04] Real, general UI-composition primitives - per Gavin's
 * direct ask: "how can we make him more capable in larger chunks so that
 * im not asking for each action to be coded." Before this, a new voice
 * capability meant a new hand-written FunctionDeclaration + handler pair
 * (see live-voice-interface.ts's history this same session: open_app,
 * then close_app, then play_music, then pause_music/resume_music, each
 * its own real, separate fix). These four expose ScreenControl's already-
 * real, already-built action primitives (click-by-accessible-name via UI
 * Automation, type, key, scroll - all pre-dating this session) generically
 * instead, so composing a UI interaction is something the model does
 * itself with existing capabilities, not something that needs a new
 * bespoke tool written for it.
 *
 * Real, disclosed limit this does NOT close: `click_element` matches by
 * accessible NAME (UI Automation), same as findAndClick() always has -
 * it cannot click something identified only by visual description
 * ("the video with X in the thumbnail") with no real accessible name.
 * That's a genuinely different, harder capability (real screen vision
 * grounding a click location) - this project tried a vision-guessing
 * click once already (thirty-second pass, moondream) and rejected it as
 * a real misclick risk; closing that gap for real needs a deliberate,
 * separate decision, not folded silently into this generic pass.
 */
const SCREEN_CONTROL_PRIMITIVES = {
  click_element: {
    description: "Click a specific button, link, or control on screen by its accessible name (not by visual description or coordinates).",
    riskTier: "normal" as RiskTier,
    parameters: { target: { type: "string" as const, description: "The exact or approximate name of the button/link/control to click.", required: true } },
  },
  type_text: {
    description: "Type text into whatever currently has keyboard focus.",
    riskTier: "normal" as RiskTier,
    parameters: { text: { type: "string" as const, description: "The text to type.", required: true } },
  },
  press_key: {
    description: "Press a single keyboard key or key combination (e.g. 'Enter', 'Escape', 'Tab', 'Ctrl+A').",
    riskTier: "normal" as RiskTier,
    parameters: { key: { type: "string" as const, description: "The key or key combination to press.", required: true } },
  },
  scroll_screen: {
    description: "Scroll the active window up or down.",
    riskTier: "normal" as RiskTier,
    parameters: { amount: { type: "number" as const, description: "Scroll amount - positive scrolls down, negative scrolls up.", required: true } },
  },
  // [ADDED 2026-09-04] Real screen-vision-guided click - per Gavin,
  // directly, after click_element's real limit came up live: "this is
  // where screen vision and mouse control come in and where he goes
  // form assistant to jarvis." See core/vision-click.ts's own header
  // comment for the real mechanism and the real, disclosed misclick risk
  // this doesn't eliminate, only reduces versus the local-model attempt
  // this project already tried and rejected once.
  click_by_description: {
    description:
      "Click something on screen that can only be identified by what it looks like or where it is, " +
      "not by an exact accessible name - e.g. 'the video with the red thumbnail' or 'the button in the top right'. " +
      "Prefer click_element instead when the target has an obvious exact name.",
    riskTier: "normal" as RiskTier,
    parameters: {
      description: {
        type: "string" as const,
        description: "A specific visual/positional description of what to click.",
        required: true,
      },
    },
  },
  // [ADDED 2026-09-04] THE real fix for Gavin's actual ask, which the
  // earlier generic-bridge pass didn't close: "i dont want a easier way
  // to add actions i want a simpler way to make bigger dents in more
  // actions... more actions in one thing." Every capability above does
  // exactly one atomic thing - a real multi-step task (open an app, wait
  // for it, type something, press Enter) cost one full voice round trip
  // PER STEP. This exposes ScreenControl's already-real ControlSequence
  // system (open/close/click/type/key/scroll/wait, chained - this
  // predates this session, just never exposed as a single capability) as
  // ONE tool that takes a whole real plan and runs it as one composed
  // operation, instead of a new bespoke tool per verb.
  run_actions: {
    description:
      "Run a sequence of computer-control steps in one operation - open/close apps, click (by accessible " +
      "name or by x/y coordinates), type text, press keys, scroll, or wait between steps. Use this for any " +
      "multi-step task instead of calling single-step tools repeatedly.",
    riskTier: "normal" as RiskTier,
    parameters: {
      steps: {
        type: "array" as const,
        description: "The ordered steps to run.",
        required: true,
        items: {
          type: "object" as const,
          description: "One step.",
          required: true,
          properties: {
            action: { type: "string" as const, description: "One of: open, close, click, type, key, scroll, wait.", required: true },
            target: { type: "string" as const, description: "For open/close/click-by-name: the app/window/control name.", required: false },
            text: { type: "string" as const, description: "For type: the text to type.", required: false },
            key: { type: "string" as const, description: "For key: the key or key combination to press.", required: false },
            x: { type: "number" as const, description: "For click by coordinate: the x position.", required: false },
            y: { type: "number" as const, description: "For click by coordinate: the y position.", required: false },
            amount: { type: "number" as const, description: "For scroll: positive scrolls down, negative scrolls up.", required: false },
            durationMs: { type: "number" as const, description: "For wait: how long to wait, in milliseconds.", required: false },
          },
        },
      },
    },
  },
} satisfies Record<string, { description: string; riskTier: RiskTier; parameters: Record<string, CapabilityParameter> }>;

/**
 * [ADDED 2026-09-04] Same real motivation as SCREEN_CONTROL_PRIMITIVES
 * above - music control used to mean a new bespoke tool per verb
 * (play_music, then pause_music/resume_music, each its own real fix this
 * session). Registered generically here instead, all backed by the exact
 * same real spotify.ts functions the non-Live conversational path
 * already calls - one real implementation, reachable everywhere.
 */
const SPOTIFY_CAPABILITIES = {
  play_music: {
    description: "Play a song or artist on Spotify. Opens Spotify automatically if it isn't already running.",
    riskTier: "normal" as RiskTier,
    parameters: { query: { type: "string" as const, description: "The song title and/or artist to play.", required: true } },
  },
  pause_music: {
    description: "Pause the currently playing Spotify track.",
    riskTier: "normal" as RiskTier,
    parameters: {},
  },
  resume_music: {
    description: "Resume/unpause Spotify playback.",
    riskTier: "normal" as RiskTier,
    parameters: {},
  },
  next_track: {
    description: "Skip to the next Spotify track.",
    riskTier: "normal" as RiskTier,
    parameters: {},
  },
  previous_track: {
    description: "Go back to the previous Spotify track.",
    riskTier: "normal" as RiskTier,
    parameters: {},
  },
} satisfies Record<string, { description: string; riskTier: RiskTier; parameters: Record<string, CapabilityParameter> }>;

type ScreenPrimitiveName = keyof typeof SCREEN_CONTROL_PRIMITIVES;
type SpotifyCapabilityName = keyof typeof SPOTIFY_CAPABILITIES;

/** ParameterDefinition's type union is wider (array/object) than any real capability registered here actually uses - narrowed to what a Gemini Live/function-calling schema can express (STRING/NUMBER/BOOLEAN), defaulting the rare unsupported case to string rather than failing the whole capability. */
function narrowParamType(type: string): "string" | "number" | "boolean" {
  return type === "number" || type === "boolean" ? type : "string";
}

class CapabilityRegistry {
  private screenControl = new ScreenControl();

  /**
   * Everything JARVIS can currently do, regardless of which executor
   * backs it - including a real parameter schema for each, so a caller
   * (a future MCP bridge, or live-voice-interface.ts's Gemini Live tool
   * bridge) can build an accurate tool declaration from list() alone,
   * without hand-writing one per capability.
   */
  list(): CapabilityDescriptor[] {
    const toolCapabilities: CapabilityDescriptor[] = toolManager.getAvailableTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      riskTier: tool.requiresApproval ? "admin" : "normal",
      system: "tool_manager",
      parameters: Object.fromEntries(
        Object.entries(tool.parameters).map(([key, def]) => [
          key,
          { type: narrowParamType(def.type), description: def.description, required: def.required },
        ])
      ),
    }));

    const screenCapabilities: CapabilityDescriptor[] = (
      Object.keys(SCREEN_CONTROL_CAPABILITIES) as Array<"open_app" | "close_app">
    ).map((name) => ({
      name,
      description: SCREEN_CONTROL_CAPABILITIES[name].description,
      riskTier: SCREEN_CONTROL_CAPABILITIES[name].riskTier,
      system: "screen_control",
      parameters: { target: { type: "string", description: `Name of the application/window to ${name === "open_app" ? "open" : "minimize"}.`, required: true } },
    }));

    const primitiveCapabilities: CapabilityDescriptor[] = (Object.keys(SCREEN_CONTROL_PRIMITIVES) as ScreenPrimitiveName[]).map((name) => ({
      name,
      description: SCREEN_CONTROL_PRIMITIVES[name].description,
      riskTier: SCREEN_CONTROL_PRIMITIVES[name].riskTier,
      system: "screen_control",
      parameters: SCREEN_CONTROL_PRIMITIVES[name].parameters,
    }));

    const spotifyCapabilities: CapabilityDescriptor[] = (Object.keys(SPOTIFY_CAPABILITIES) as SpotifyCapabilityName[]).map((name) => ({
      name,
      description: SPOTIFY_CAPABILITIES[name].description,
      riskTier: SPOTIFY_CAPABILITIES[name].riskTier,
      system: "spotify",
      parameters: SPOTIFY_CAPABILITIES[name].parameters,
    }));

    return [...toolCapabilities, ...screenCapabilities, ...primitiveCapabilities, ...spotifyCapabilities];
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
    if (name in SCREEN_CONTROL_PRIMITIVES) {
      return this.executeScreenPrimitive(name as ScreenPrimitiveName, parameters, identity, taskId);
    }
    if (name in SPOTIFY_CAPABILITIES) {
      return this.executeSpotify(name as SpotifyCapabilityName, parameters, identity);
    }
    // ToolManager already handles authorization and action-journal
    // recording for its own tools (tools/manager.ts) — no need to repeat
    // either here.
    return toolManager.executeTool({ toolName: name, parameters }, taskId ?? "capability-registry", identity);
  }

  private async executeScreenPrimitive(
    name: ScreenPrimitiveName,
    parameters: Record<string, unknown>,
    identity: IdentityResult,
    taskId?: string
  ): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      let result: { success: boolean; output?: string; error?: string };
      switch (name) {
        case "click_element": {
          const target = typeof parameters.target === "string" ? parameters.target : "";
          if (!target) return { success: false, error: "click_element called without a 'target' parameter.", executionTime: 0 };
          result = await this.screenControl.findAndClick(`Click ${target}`, target, identity);
          break;
        }
        case "type_text": {
          const text = typeof parameters.text === "string" ? parameters.text : "";
          if (!text) return { success: false, error: "type_text called without a 'text' parameter.", executionTime: 0 };
          const seq = this.screenControl.buildSequence(`Type "${text}"`);
          this.screenControl.type(seq, text);
          result = await this.screenControl.executeSequence(seq, identity);
          break;
        }
        case "press_key": {
          const key = typeof parameters.key === "string" ? parameters.key : "";
          if (!key) return { success: false, error: "press_key called without a 'key' parameter.", executionTime: 0 };
          const seq = this.screenControl.buildSequence(`Press ${key}`);
          this.screenControl.key(seq, key);
          result = await this.screenControl.executeSequence(seq, identity);
          break;
        }
        case "scroll_screen": {
          const amount = typeof parameters.amount === "number" ? parameters.amount : 0;
          if (!amount) return { success: false, error: "scroll_screen called without a nonzero 'amount' parameter.", executionTime: 0 };
          const seq = this.screenControl.buildSequence(`Scroll ${amount}`);
          this.screenControl.scroll(seq, amount);
          result = await this.screenControl.executeSequence(seq, identity);
          break;
        }
        case "click_by_description": {
          const description = typeof parameters.description === "string" ? parameters.description : "";
          if (!description) return { success: false, error: "click_by_description called without a 'description' parameter.", executionTime: 0 };
          const visionResult = await clickByDescription(description);
          result = { success: visionResult.success, output: visionResult.label, error: visionResult.error };
          break;
        }
        case "run_actions": {
          const steps = Array.isArray(parameters.steps) ? (parameters.steps as Record<string, unknown>[]) : [];
          if (steps.length === 0) return { success: false, error: "run_actions called without any 'steps'.", executionTime: 0 };
          const seq = this.screenControl.buildSequence(`Run ${steps.length} action(s)`);
          for (const step of steps) {
            const action = typeof step.action === "string" ? step.action.toLowerCase() : "";
            switch (action) {
              case "open":
                if (typeof step.target === "string") {
                  this.screenControl.open(seq, step.target);
                  // [FIXED 2026-09-04] Real bug found live (Gavin: "it did
                  // the notepad mutosept but becuase i had the powershell
                  // focues it typed on there") - opening an app is
                  // asynchronous (Start-Process/Get-StartApps return
                  // immediately, well before the real window even exists,
                  // let alone has focus), so a "type"/"click" step right
                  // after "open" in the same plan landed on whatever
                  // already had focus - here, the terminal running
                  // listen-live itself. ScreenControl.openApp() (the
                  // single-purpose convenience method) already bakes in a
                  // real 2s wait for exactly this reason - run_actions
                  // didn't, since it built the sequence directly from
                  // whatever steps the model provided, and nothing forced
                  // it to remember a wait. Matches openApp()'s own proven
                  // pattern exactly, not a new one: deliberately NOT also
                  // chaining an explicit focus() action here - that throws
                  // outright on any title mismatch (e.g. "Notepad" vs its
                  // real window title "Untitled - Notepad"), and this
                  // sequence loop has no per-action try/catch, so one
                  // failed focus() would silently abort every step after
                  // it, including the real type/click the user asked for -
                  // worse than the bug this is fixing. A real wait plus
                  // Windows' own normal "a newly launched app takes focus"
                  // behavior is what openApp() already relies on
                  // successfully; this just gives run_actions the same
                  // real behavior instead of a second, riskier idea.
                  this.screenControl.wait(seq, 2000);
                }
                break;
              case "close":
                if (typeof step.target === "string") this.screenControl.close(seq, step.target);
                break;
              case "click":
                if (typeof step.x === "number") this.screenControl.click(seq, step.x, typeof step.y === "number" ? step.y : 0);
                else if (typeof step.target === "string") this.screenControl.click(seq, step.target);
                break;
              case "type":
                if (typeof step.text === "string") this.screenControl.type(seq, step.text);
                break;
              case "key":
                if (typeof step.key === "string") this.screenControl.key(seq, step.key);
                break;
              case "scroll":
                if (typeof step.amount === "number") this.screenControl.scroll(seq, step.amount);
                break;
              case "wait":
                this.screenControl.wait(seq, typeof step.durationMs === "number" ? step.durationMs : 1000);
                break;
              default:
                // An unrecognized step is skipped, not fatal to the rest of
                // the plan - same "a partial real result beats an all-or-
                // nothing failure" reasoning the rest of this codebase uses.
                console.log(`   ⚠️  run_actions: skipping unrecognized step action "${step.action}"`);
            }
          }
          result = await this.screenControl.executeSequence(seq, identity);
          break;
        }
      }
      void recordAction({
        taskId,
        system: "screen_control",
        tool: name,
        parameters,
        success: result.success,
        result: result.success ? undefined : { error: result.error },
        riskTier: SCREEN_CONTROL_PRIMITIVES[name].riskTier,
        // No real inverse exists for a click/keypress/scroll the way
        // open_app<->close_app do - honestly journaled as irreversible
        // rather than guessing at one.
        inverseAction: null,
      });
      return { success: result.success, data: result.output, error: result.error, executionTime: Date.now() - startTime };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), executionTime: Date.now() - startTime };
    }
  }

  private async executeSpotify(
    name: SpotifyCapabilityName,
    parameters: Record<string, unknown>,
    identity: IdentityResult
  ): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      let result: { success: boolean; playing?: string; error?: string };
      switch (name) {
        case "play_music": {
          const query = typeof parameters.query === "string" ? parameters.query : "";
          if (!query) return { success: false, error: "play_music called without a 'query' parameter.", executionTime: 0 };
          result = await spotifyPlayWithAutoOpen(query, async (target) => {
            const openResult = await this.screenControl.openApp(target, identity);
            return { success: openResult.success, error: openResult.error };
          });
          break;
        }
        case "pause_music":
          result = await spotifyPause();
          break;
        case "resume_music":
          result = await spotifyResume();
          break;
        case "next_track":
          result = await spotifyNext();
          break;
        case "previous_track":
          result = await spotifyPrevious();
          break;
      }
      return { success: result.success, data: result.playing, error: result.error, executionTime: Date.now() - startTime };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), executionTime: Date.now() - startTime };
    }
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
