/**
 * Phase 5 (Visual HUD) — minimal real implementation
 *
 * The master architecture doc listed Phase 5 as "doesn't exist. No
 * `desktop/` folder. Never got past a chat message." This is the first
 * real piece of it: a tiny local HTTP server (Bun's built-in Bun.serve -
 * no new dependency) that serves the animated HUD page (public/hud.html)
 * and a `/state` endpoint the page polls to know which of idle/listening/
 * thinking/speaking to render. cli.ts's `listen` command owns updating
 * the state (via voice.on(...) listeners) and opening the actual window -
 * this class only serves content, it doesn't know anything about voice
 * pipeline internals, so it stays reusable if a native overlay ever
 * replaces the browser-window approach later.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// [UPDATED 2026-09-01] Added "acting" - a distinct visual state for when
// JARVIS is actually executing a real-world action (opening an app, etc.),
// separate from "thinking" (LLM latency). See orchestrator.ts's
// onActionStart/onActionEnd and voice-interface.ts's "acting"/"acting-done"
// events for how this gets set.
export type HudState = "idle" | "listening" | "thinking" | "acting" | "speaking";

export class HudServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private state: HudState = "idle";
  // [ADDED 2026-09-03] Real activity text, per Gavin: "the text at the
  // top isnt actaully what hes doing its just for show, make it
  // accurate." hud.html's own cycling readout words (SYS NOMINAL,
  // PROCESSING, etc.) were honestly disclosed as ambient decoration, not
  // real telemetry - this is the real telemetry that decoration was
  // standing in for. null when there's nothing specific to report (a
  // plain conversational reply has no distinct "action" beyond thinking)
  // - hud.html falls back to its own honest generic per-state label in
  // that case, not a fabricated specific one.
  private activity: string | null = null;
  private htmlPath: string;

  // [ADDED 2026-09-04] Real bug found live via Gemini Live specifically
  // (Gavin: "soemtimes i get thourgh and hes listening but it doesnt go
  // to listneing mode so i dont know and it messes me up a lot") -
  // setState() used to overwrite this.state synchronously with no
  // history at all, and the native HUD only learns about state by
  // polling /state every 400ms (see native-hud's own "polling every
  // 400ms" log lines). Gemini Live is fast enough that a full
  // listening -> speaking transition can complete in well under 400ms,
  // meaning "listening" could be set and then overwritten before the
  // native app's next poll ever observed it - a real state the user
  // needed to see, silently erased. A minimum dwell time fixes this
  // generically (not a Gemini-Live-specific patch) - any state now
  // stays visible for at least one real poll cycle before a newer one
  // can replace it, queuing the newest pending state rather than
  // dropping it outright.
  private lastStateChangeAt = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MIN_DWELL_MS = 500; // comfortably above the native HUD's 400ms poll interval

  constructor(htmlPath: string = join(process.cwd(), "public", "hud.html")) {
    this.htmlPath = htmlPath;
  }

  setState(state: HudState, activity: string | null = null): void {
    const elapsed = Date.now() - this.lastStateChangeAt;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (elapsed >= HudServer.MIN_DWELL_MS) {
      this.applyState(state, activity);
    } else {
      this.pendingTimer = setTimeout(() => this.applyState(state, activity), HudServer.MIN_DWELL_MS - elapsed);
    }
  }

  private applyState(state: HudState, activity: string | null): void {
    this.state = state;
    this.activity = activity;
    this.lastStateChangeAt = Date.now();
  }

  start(port: number): void {
    if (this.server) return;
    const html = readFileSync(this.htmlPath, "utf-8");

    this.server = Bun.serve({
      port,
      // Bind to localhost only - this is a local visual indicator for
      // whoever is sitting at this PC, not a service meant to be reachable
      // from the network.
      hostname: "127.0.0.1",
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/state") {
          return new Response(JSON.stringify({ state: this.state, activity: this.activity }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      },
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  get url(): string {
    return this.server ? `http://127.0.0.1:${this.server.port}` : "";
  }
}
