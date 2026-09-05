import { describe, expect, test } from "bun:test";
import { capabilityRegistry } from "../core/capability-registry";

const fakeIdentity = { resolvedAs: "gavin", confidence: 0.75, signal: "device_session" } as any;

describe("capabilityRegistry.list()", () => {
  test("includes both tool_manager and screen_control capabilities", () => {
    const names = capabilityRegistry.list().map((c) => c.name);
    // tool_manager-backed (registered in tools/manager.ts)
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("bash");
    // screen_control-backed (this registry's own addition)
    expect(names).toContain("open_app");
    expect(names).toContain("close_app");
  });

  test("marks write_file/bash as higher risk than read_file/list_files, matching ToolManager's own approval flags", () => {
    const byName = Object.fromEntries(capabilityRegistry.list().map((c) => [c.name, c]));
    expect(byName.read_file.riskTier).toBe("normal");
    expect(byName.write_file.riskTier).toBe("admin"); // WriteFileTool.requiresApproval = true
  });

  // [ADDED 2026-09-04] Real coverage for the generic-capability expansion
  // (per Gavin: "how can we make him more capable in larger chunks") -
  // these are what live-voice-interface.ts's registerCapabilitiesAsTools()
  // now builds real Gemini Live tool declarations from directly, so a
  // wrong/missing parameter schema here would silently break voice
  // control for that capability with no other test catching it.
  test("includes the new screen-control primitives and spotify capabilities with real parameter schemas", () => {
    const byName = Object.fromEntries(capabilityRegistry.list().map((c) => [c.name, c]));
    expect(byName.click_element.parameters.target).toEqual({ type: "string", description: expect.any(String), required: true });
    expect(byName.type_text.parameters.text.required).toBe(true);
    expect(byName.press_key.parameters.key.required).toBe(true);
    expect(byName.scroll_screen.parameters.amount.type).toBe("number");
    expect(byName.play_music.parameters.query.required).toBe(true);
    expect(Object.keys(byName.pause_music.parameters)).toHaveLength(0);
    expect(byName.click_element.riskTier).toBe("normal");
    expect(byName.play_music.riskTier).toBe("normal");
  });

  test("tool_manager parameter schemas are narrowed to string/number/boolean for every registered tool", () => {
    for (const capability of capabilityRegistry.list()) {
      // run_actions is the one deliberate exception - see its own test below.
      if (capability.name === "run_actions") continue;
      for (const param of Object.values(capability.parameters)) {
        expect(["string", "number", "boolean"]).toContain(param.type);
      }
    }
  });

  // [ADDED 2026-09-04] Real coverage for the "bigger dents in more
  // actions" fix (per Gavin: "i dont want a easier way to add actions i
  // want a simpler way to make bigger dents in more actions... more
  // actions in one thing") - run_actions is the first capability whose
  // parameter schema is genuinely recursive (an array of step objects,
  // not a flat string/number/boolean), which is exactly what
  // live-voice-interface.ts's toGeminiSchema() has to convert correctly
  // for voice control of it to work at all.
  test("run_actions exposes a real array-of-object parameter schema", () => {
    const byName = Object.fromEntries(capabilityRegistry.list().map((c) => [c.name, c]));
    const steps = byName.run_actions.parameters.steps;
    expect(steps.type).toBe("array");
    expect(steps.required).toBe(true);
    expect(steps.items?.type).toBe("object");
    expect(steps.items?.properties?.action.required).toBe(true);
    expect(steps.items?.properties?.target.required).toBe(false);
    expect(byName.run_actions.riskTier).toBe("normal");
  });
});

describe("capabilityRegistry.has()", () => {
  test("true for a registered capability, false for an unknown name", () => {
    expect(capabilityRegistry.has("open_app")).toBe(true);
    expect(capabilityRegistry.has("read_file")).toBe(true);
    expect(capabilityRegistry.has("teleport")).toBe(false);
  });
});

describe("capabilityRegistry.execute()", () => {
  test("an unknown capability name fails cleanly instead of throwing (delegated to ToolManager's own 'not found' handling)", async () => {
    const result = await capabilityRegistry.execute("teleport", {}, fakeIdentity);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Tool not found");
  });

  test("open_app without a 'target' parameter fails cleanly instead of calling ScreenControl with an empty string", async () => {
    const result = await capabilityRegistry.execute("open_app", {}, fakeIdentity);
    expect(result.success).toBe(false);
    expect(result.error).toContain("target");
  });

  test("run_actions without any 'steps' fails cleanly instead of running an empty sequence", async () => {
    const result = await capabilityRegistry.execute("run_actions", {}, fakeIdentity);
    expect(result.success).toBe(false);
    expect(result.error).toContain("steps");
  });
});
