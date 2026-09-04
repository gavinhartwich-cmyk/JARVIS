import { describe, expect, test } from "bun:test";
import {
  recordAction,
  inverseOfScreenControlAction,
  inverseOfFileAction,
  undoLastActions,
} from "../core/action-journal";

describe("inverseOfScreenControlAction", () => {
  test("open_app's inverse is close_app on the same target", () => {
    expect(inverseOfScreenControlAction("open_app", "Notepad")).toEqual({
      tool: "close_app",
      parameters: { target: "Notepad" },
    });
  });

  test("close_app's inverse is open_app on the same target", () => {
    expect(inverseOfScreenControlAction("close_app", "Spotify")).toEqual({
      tool: "open_app",
      parameters: { target: "Spotify" },
    });
  });
});

describe("inverseOfFileAction", () => {
  test("write_file over an existing file inverts to restoring its prior content", () => {
    const inverse = inverseOfFileAction("write_file", { path: "/tmp/x.txt" }, "old content");
    expect(inverse).toEqual({ tool: "write_file", parameters: { path: "/tmp/x.txt", content: "old content" } });
  });

  test("write_file over a file that didn't exist before inverts to deleting it", () => {
    const inverse = inverseOfFileAction("write_file", { path: "/tmp/new.txt" }, undefined);
    expect(inverse).toEqual({ tool: "delete_file", parameters: { path: "/tmp/new.txt" } });
  });

  test("delete_file inverts to restoring the deleted content", () => {
    const inverse = inverseOfFileAction("delete_file", { path: "/tmp/gone.txt" }, "was here");
    expect(inverse).toEqual({ tool: "write_file", parameters: { path: "/tmp/gone.txt", content: "was here" } });
  });

  test("actions with no general inverse (read_file, list_files, bash) return null", () => {
    expect(inverseOfFileAction("read_file", { path: "/tmp/x.txt" }, "content")).toBeNull();
    expect(inverseOfFileAction("bash", { command: "ls" }, undefined)).toBeNull();
  });

  test("a missing path returns null instead of a malformed inverse", () => {
    expect(inverseOfFileAction("write_file", {}, "content")).toBeNull();
  });
});

describe("recordAction — graceful degradation without a database", () => {
  test("returns null instead of throwing when no database is configured", async () => {
    const id = await recordAction({
      system: "screen_control",
      tool: "open_app",
      parameters: { target: "Notepad" },
      success: true,
      riskTier: "normal",
    });
    expect(id).toBeNull();
  });
});

describe("undoLastActions — without a database", () => {
  test("fails clearly rather than hanging or silently no-opping", async () => {
    const fakeIdentity = { resolvedAs: "gavin", confidence: 0.75, signal: "device_session" } as any;
    await expect(undoLastActions(1, fakeIdentity)).rejects.toThrow(/Database not initialized/);
  });
});
