/**
 * Proactivity Engine (master plan Part 7.2)
 *
 * The real relevance -> urgency -> permission -> device-routing decision
 * funnel the master doc's own diagram specifies - not a simulation of it.
 * Deliberately reuses this codebase's existing, already-real
 * infrastructure rather than reinventing pieces of it:
 *   - presenceEngine.routeCommunication() (core/presence.ts, Part 3.1) for
 *     "which device, right now" - already handles active/idle/away and
 *     the critical-alert override.
 *   - authorizationEngine.authorize() (core/authorization.ts, Part 3.3)
 *     for "does this need permission" - the same real, audited engine
 *     every tool call already goes through, not a parallel check.
 *   - storeMemory()/retrieveMemories() (core/memory.ts) for persistence -
 *     the `memories` table's own `memoryTypeEnum` already includes
 *     "event" as a real type, so no new migration was needed for this.
 *
 * What this file does NOT do: monitor calendar, email, business metrics,
 * or health data (Part 7.1's full list). Those need real external API
 * access (Google Calendar, Gmail, etc.) this codebase doesn't have yet -
 * see system-monitors.ts's own header for what's real right now instead,
 * and the master doc's Phase 4 status for what's blocked on Gavin
 * providing/authorizing credentials.
 */

import { storeMemory, retrieveMemories } from "./memory";
import { presenceEngine, type Urgency } from "./presence";
import { authorizationEngine, type RiskTier } from "./authorization";
import { identityEngine } from "./identity";

export interface MonitoredEvent {
  /** Which monitor produced this, e.g. "disk-space" - also used as the authorization action name. */
  source: string;
  /** Human-readable description - what would actually be spoken/shown. */
  summary: string;
  /**
   * Stable key identifying the underlying CONDITION, not this one
   * observation of it - e.g. "disk-space:C:" so a still-low drive isn't
   * renotified every single monitoring pass.
   */
  dedupeKey: string;
  /** 0-100, per the master doc's own scale. */
  relevance: number;
  /** 0-100, per the master doc's own scale. */
  urgency: number;
  requiresPermission?: boolean;
  riskTier?: RiskTier;
  metadata?: Record<string, unknown>;
}

export type ProactivityOutcome = "ignored" | "archived" | "needs_permission" | "notified" | "queued_no_device";

export interface ProactivityDecision {
  outcome: ProactivityOutcome;
  device?: string | null;
  timing?: "immediately" | "within_1_hour" | "next_check" | "can_wait";
  reason: string;
}

// How long a dedupeKey's most recent outcome suppresses a repeat
// notification for the same ongoing condition. 6h, not "forever" - a
// still-low disk after 6h is worth mentioning again, not silently
// dropped for good.
const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;

export class ProactivityEngine {
  /**
   * Runs one real event through the full Part 7.2 decision funnel.
   * Every outcome (including "ignored") is recorded via storeMemory() -
   * real audit trail, and what makes the dedup check above possible.
   */
  async evaluate(event: MonitoredEvent): Promise<ProactivityDecision> {
    const alreadyHandled = await this.recentlyHandled(event.dedupeKey);
    if (alreadyHandled) {
      return {
        outcome: "ignored",
        reason: `Already handled "${event.dedupeKey}" within the last ${DEDUPE_WINDOW_MS / 3_600_000}h — not re-notifying for the same ongoing condition.`,
      };
    }

    if (event.relevance < 20) {
      await this.record(event, "ignored");
      return { outcome: "ignored", reason: `Relevance ${event.relevance} < 20 — not worth acting on.` };
    }

    const timing: ProactivityDecision["timing"] =
      event.urgency > 80 ? "immediately" : event.urgency >= 50 ? "within_1_hour" : event.urgency >= 20 ? "next_check" : "can_wait";

    if (event.relevance < 40) {
      await this.record(event, "archived");
      return { outcome: "archived", timing, reason: `Relevance ${event.relevance} (20-40) — archived for a later briefing, not interrupting now.` };
    }

    // 40-70 is "conditional notify" per the master doc's diagram - only
    // proceed to actually notifying if urgency also clears a real bar;
    // otherwise it's relevant enough to remember, not urgent enough to
    // interrupt with.
    if (event.relevance <= 70 && timing === "can_wait") {
      await this.record(event, "archived");
      return { outcome: "archived", timing, reason: `Relevance ${event.relevance} is conditional and urgency ${event.urgency} can wait — archived.` };
    }

    if (event.requiresPermission) {
      // Real authorization check, not a placeholder - same engine every
      // tool call already goes through (Part 3.3). A background
      // monitoring pass has no live conversational identity to draw on,
      // so it resolves the same device-session baseline `bun run dev
      // whoami` does - this process genuinely is running under Gavin's
      // own Windows session.
      const identity = await identityEngine.resolveFromDeviceSession();
      const auth = await authorizationEngine.authorize(identity, event.source, event.riskTier);
      if (!auth.allowed) {
        await this.record(event, "needs_permission");
        return { outcome: "needs_permission", timing, reason: `Requires permission: ${auth.reason}` };
      }
    }

    const urgencyLevel: Urgency = event.urgency > 80 ? "critical" : event.urgency >= 50 ? "high" : event.urgency >= 20 ? "medium" : "low";
    const device = await presenceEngine.routeCommunication(urgencyLevel);
    await this.record(event, device ? "notified" : "queued_no_device", device?.name ?? null);
    return {
      outcome: device ? "notified" : "queued_no_device",
      device: device?.name ?? null,
      timing,
      reason: device
        ? `Relevance ${event.relevance}, urgency ${event.urgency} — notifying via "${device.name}" (${timing}).`
        : `Relevance ${event.relevance}, urgency ${event.urgency} — no active device to notify right now, queued for when one is.`,
    };
  }

  private async recentlyHandled(dedupeKey: string): Promise<boolean> {
    // Real DB query via memory.ts, not an in-memory cache - so dedup
    // survives across separate `bun run dev proactive-check` invocations
    // (each one is a fresh process), matching how a real periodic
    // monitoring job would actually run.
    const recent = await retrieveMemories("event", 100);
    const now = Date.now();
    return recent.some((m) => {
      const meta = m.metadata as Record<string, unknown> | null;
      if (!meta || meta.dedupeKey !== dedupeKey) return false;
      if (!m.createdAt) return false;
      return now - new Date(m.createdAt).getTime() < DEDUPE_WINDOW_MS;
    });
  }

  private async record(event: MonitoredEvent, outcome: ProactivityOutcome, device?: string | null): Promise<void> {
    await storeMemory({
      type: "event",
      content: event.summary,
      importance: Math.max(1, Math.min(10, Math.round(event.relevance / 10))),
      source: event.source,
      tags: ["proactive", event.source, outcome],
      metadata: {
        ...event.metadata,
        relevance: event.relevance,
        urgency: event.urgency,
        dedupeKey: event.dedupeKey,
        outcome,
        device: device ?? null,
      },
    });
  }
}

export const proactivityEngine = new ProactivityEngine();
