/**
 * Real adaptive proactive-monitoring scheduler (Part 7).
 *
 * Per Gavin: "The scheduler should run whenever is needed decided by
 * Jarvis" - not a fixed dumb cron interval. Each pass looks at what it
 * actually found (something notified? a real calendar event approaching
 * soon?) and decides its OWN next delay from that, within real bounds
 * (5min floor so it never hammers real APIs, 45min relaxed ceiling so it
 * never goes fully silent for hours).
 *
 * Also real, not fabricated (per Gavin: "text me when it knows im not at
 * my pc"): presence is driven by genuine Win32 idle-time detection
 * (presence-monitor.ts), not a heartbeat called unconditionally on a
 * timer - a background process heartbeating on its own schedule would
 * make the PC look permanently "active" regardless of whether Gavin is
 * really there, which would silently break the exact "away -> text"
 * routing this was built for. When no active device is found (Gavin
 * genuinely away, per the real idle check), this sends a real SMS
 * (core/sms.ts) instead of just logging - the real delivery half of
 * Part 7.2's "Away? -> Phone notification" step, not just the decision.
 */

import { runAllMonitors } from "./system-monitors";
import { proactivityEngine, type MonitoredEvent } from "./proactivity";
import { presenceEngine } from "./presence";
import { isGenuinelyAtKeyboard } from "./presence-monitor";
import { sendSms } from "./sms";

const MIN_INTERVAL_MS = 5 * 60 * 1000;
const RELAXED_INTERVAL_MS = 45 * 60 * 1000;
const APPROACHING_INTERVAL_MS = 10 * 60 * 1000;
const AFTER_NOTIFY_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Real decision from what THIS pass actually found, not a fixed number.
 */
export function decideNextIntervalMs(events: MonitoredEvent[], notifiedCount: number): number {
  if (notifiedCount > 0) return AFTER_NOTIFY_INTERVAL_MS;

  // calendar-monitor.ts's own urgency buckets shift at 15/60/180 minutes -
  // if something real is inside that window, check again before a
  // relaxed interval would miss the transition into a more urgent one.
  const calendarMinutes = events
    .filter((e): e is MonitoredEvent & { metadata: { minutesUntil: number } } => e.source === "calendar" && typeof e.metadata?.minutesUntil === "number")
    .map((e) => e.metadata.minutesUntil)
    .filter((m) => m >= 0);
  const soonest = calendarMinutes.length > 0 ? Math.min(...calendarMinutes) : undefined;

  if (soonest !== undefined && soonest < 180) {
    return APPROACHING_INTERVAL_MS;
  }
  return RELAXED_INTERVAL_MS;
}

export async function runProactivePass(): Promise<{ events: MonitoredEvent[]; notifiedCount: number }> {
  console.log(`\n[${new Date().toISOString()}] Proactive pass starting...`);

  await presenceEngine.registerDevice("pc", "pc", ["voice", "screen", "notification"]);
  let atKeyboard = false;
  try {
    atKeyboard = await isGenuinelyAtKeyboard();
    if (atKeyboard) {
      await presenceEngine.heartbeat("pc");
    }
    console.log(`   Presence: ${atKeyboard ? "at keyboard (real idle check - heartbeated active)" : "away (real idle check - no heartbeat, letting presence decay)"}`);
  } catch (err) {
    console.error(`   ⚠️  Idle-time check failed (non-fatal, presence not updated this pass): ${err instanceof Error ? err.message : err}`);
  }

  const events = await runAllMonitors();
  let notifiedCount = 0;

  for (const event of events) {
    const decision = await proactivityEngine.evaluate(event);
    if (decision.outcome === "notified") {
      notifiedCount++;
      console.log(`   🔔 [${event.source}] ${event.summary} (${decision.reason})`);
      // Real device routing found an active PC. The actual "speak/show
      // on the PC" delivery channel is still real, disclosed follow-up
      // work (see the master doc's Phase 4 status) - this logs it, same
      // as `proactive-check`.
    } else if (decision.outcome === "queued_no_device") {
      // Part 7.2's own diagram: "Away? -> Phone notification." No active
      // PC device found (genuinely, per the real idle check above) -
      // exactly the real trigger for the SMS fallback Gavin asked for.
      console.log(`   📱 [${event.source}] ${event.summary} - no active device, texting instead`);
      try {
        await sendSms(`JARVIS: ${event.summary}`);
        notifiedCount++;
      } catch (err) {
        console.error(`   ⚠️  SMS send failed (non-fatal): ${err instanceof Error ? err.message : err}`);
      }
    } else {
      console.log(`   ${decision.outcome} [${event.source}] ${event.summary}`);
    }
  }

  if (events.length === 0) {
    console.log("   Nothing to report this pass.");
  }

  return { events, notifiedCount };
}

/**
 * Runs real passes forever, choosing its own next delay each time - see
 * this file's own header. Never returns; caller owns process lifetime
 * (Ctrl+C, same as `listen`).
 */
export async function runProactiveScheduler(): Promise<never> {
  console.log("🔁 Proactive scheduler starting - JARVIS decides its own check interval each pass, not a fixed cron. Press Ctrl+C to stop.");
  for (;;) {
    let nextDelayMs = RELAXED_INTERVAL_MS;
    try {
      const { events, notifiedCount } = await runProactivePass();
      nextDelayMs = Math.max(MIN_INTERVAL_MS, decideNextIntervalMs(events, notifiedCount));
    } catch (err) {
      console.error(`   ⚠️  Proactive pass failed entirely (non-fatal, will retry next interval): ${err instanceof Error ? err.message : err}`);
    }
    console.log(`   Next check in ${Math.round(nextDelayMs / 60_000)} min.`);
    await new Promise((resolve) => setTimeout(resolve, nextDelayMs));
  }
}
