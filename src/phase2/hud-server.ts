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

export type HudState = "idle" | "listening" | "thinking" | "speaking";

export class HudServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private state: HudState = "idle";
  private htmlPath: string;

  constructor(htmlPath: string = join(process.cwd(), "public", "hud.html")) {
    this.htmlPath = htmlPath;
  }

  setState(state: HudState): void {
    this.state = state;
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
          return new Response(JSON.stringify({ state: this.state }), {
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
