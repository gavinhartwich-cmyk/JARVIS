/**
 * Manual test harness for the Gemini Live prototype — text in, since this
 * codebase has no microphone capture yet (per JARVIS-MASTER-ARCHITECTURE-
 * UPDATED.md, that needs real hardware I/O on Gavin's PC). Exercises
 * everything the architecture update's step 4 asks for except the actual
 * microphone: realtime response, streamed audio, session persistence
 * (prints the resumable handle — pass it back in via --resume to prove
 * reconnection continues the same session), and the one registered JARVIS
 * tool. Interruption can't be meaningfully exercised without a second,
 * overlapping input mid-response — the listener is wired up regardless so
 * a real mic-driven caller gets it for free.
 *
 * This lives outside core/ on purpose — the prototype stays isolated from
 * the rest of JARVIS (architecture doc step 4); this harness is the one
 * place that's allowed to reach into core/telemetry, since measuring it is
 * the entire point of step 5.
 */

import { GeminiLiveSession } from "./gemini-live-session";
import { OPEN_APP_DECLARATION, createOpenAppToolHandler } from "./live-tools";
import { telemetry, Stage } from "../../core/telemetry";

const SYSTEM_INSTRUCTION =
  "You are JARVIS, a helpful voice assistant. Keep replies short and conversational " +
  "since they will be spoken aloud. You can open applications on the user's computer " +
  "using the open_app tool when asked to.";

export async function runLiveHarness(text: string, resumeHandle?: string): Promise<void> {
  const traceId = telemetry.start("gemini-live.harness");
  telemetry.mark(traceId, Stage.INPUT_RECEIVED);

  const session = new GeminiLiveSession({ systemInstruction: SYSTEM_INSTRUCTION, resumeHandle });
  session.registerTool(OPEN_APP_DECLARATION, createOpenAppToolHandler());

  session.on("audio", () => {
    telemetry.mark(traceId, Stage.FIRST_AUDIO); // harmless if called more than once — later chunks just show as ~0ms deltas
  });
  session.on("text", (data) => {
    console.log(`🤖 [text delta] ${data}`);
  });
  session.on("interrupted", () => {
    console.log("🔇 Model generation interrupted — playback queue should be cleared now.");
  });
  session.on("session-handle", (handle) => {
    console.log(`🔖 Session resumption handle: ${handle}`);
    console.log(`   Re-run with --resume ${handle} to continue this same session.`);
  });
  session.on("error", (err) => {
    console.error("❌ Gemini Live error:", err);
  });

  console.log("🔌 Connecting to Gemini Live...");
  await session.connect();
  telemetry.mark(traceId, Stage.PROVIDER_CONNECTION, "gemini-live");
  console.log("✅ Connected. Sending turn...");

  session.sendText(text);

  // The prototype has no real audio playback sink yet — give the server a
  // window to stream its response, then close. A production integration
  // (step 6) would instead await turnComplete and/or a real playback queue
  // draining, not a fixed timer.
  await new Promise((resolve) => setTimeout(resolve, 15_000));

  session.close();
  telemetry.mark(traceId, Stage.TOTAL_COMPLETION);
  telemetry.finish(traceId);
}
