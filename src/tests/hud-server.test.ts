import { describe, expect, test } from "bun:test";
import { HudServer } from "../phase2/hud-server";

/**
 * No real native-HUD polling in this suite - covers what's verifiable
 * without one: the minimum-dwell-time fix itself (real bug found live
 * via Gemini Live specifically - see hud-server.ts's own comment).
 * setState() has no public getter, so these tests go through the real
 * HTTP /state endpoint the native HUD actually polls, on an ephemeral
 * port (port 0), same as every real caller does.
 */
async function readState(hud: HudServer): Promise<{ state: string; activity: string | null }> {
  const res = await fetch(`${hud.url}/state`);
  return (await res.json()) as { state: string; activity: string | null };
}

describe("HudServer — minimum dwell time", () => {
  test("a state set immediately after another is not visible until the dwell window passes", async () => {
    const hud = new HudServer();
    hud.start(0);
    try {
      hud.setState("listening");
      expect((await readState(hud)).state).toBe("listening");

      // Set "speaking" right away, well inside the dwell window - the
      // real bug this fixes: without a minimum dwell, this would have
      // overwritten "listening" instantly, before any real poller could
      // ever have observed it.
      hud.setState("speaking");
      expect((await readState(hud)).state).toBe("listening");

      await new Promise((resolve) => setTimeout(resolve, 550));
      expect((await readState(hud)).state).toBe("speaking");
    } finally {
      hud.stop();
    }
  });

  test("a state set after the dwell window has already passed applies immediately", async () => {
    const hud = new HudServer();
    hud.start(0);
    try {
      hud.setState("idle");
      await new Promise((resolve) => setTimeout(resolve, 550));
      hud.setState("acting", "Opening Notepad");
      const result = await readState(hud);
      expect(result.state).toBe("acting");
      expect(result.activity).toBe("Opening Notepad");
    } finally {
      hud.stop();
    }
  });

  test("only the most recent of several rapid state changes is what eventually applies", async () => {
    const hud = new HudServer();
    hud.start(0);
    try {
      hud.setState("listening");
      hud.setState("thinking");
      hud.setState("acting");
      hud.setState("speaking");
      await new Promise((resolve) => setTimeout(resolve, 550));
      expect((await readState(hud)).state).toBe("speaking");
    } finally {
      hud.stop();
    }
  });
});
