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
});
