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

  constructor(htmlPath: string = join(process.cwd(), "public", "hud.html")) {
    this.htmlPath = htmlPath;
  }

  setState(state: HudState, activity: string | null = null): void {
    this.state = state;
    this.activity = activity;
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
