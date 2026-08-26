import { getDatabase } from "../db/client";
import { authorizationDecisions } from "../db/schema";
import { logAuditEvent } from "./audit";
import type { IdentityResult } from "./identity";

/**
 * Authorization Engine (master plan Part 3.3, invariants #1/#2/#6/#9/#12)
 *
 * Deliberately independent of the LLM and independent of IdentityEngine's
 * confidence score. Identity answers "who is this, probably." Authorization
 * answers "is that enough to do this specific thing." The two must never be
 * collapsed into one check — that's the exact bug this system exists to
 * prevent.
 */

export type AuthLevel = "unknown" | "recognized" | "gavin" | "verified";
export type RiskTier = "low" | "normal" | "admin";
export type Decision = "allowed" | "denied" | "needs_verification";

const LEVEL_RANK: Record<AuthLevel, number> = {
  unknown: 0,
  recognized: 1,
  gavin: 2,
  verified: 3,
};

// Master plan Part 3.3's explicit "High-Risk Actions Requiring Level 3" list.
const ADMIN_ACTIONS = new Set([
  "install_software",
  "change_system_permissions",
  "access_credentials",
  "modify_security_settings",
  "delete_bulk_data",
  "modify_jarvis_core",
  "grant_permission",
  "bash", // arbitrary shell execution is admin-tier by default; narrow later per-command if needed
]);

const LOW_RISK_ACTIONS = new Set(["chat", "public_question", "read_public_info"]);

export interface AuthorizeResult {
  decision: Decision;
  allowed: boolean;
  level: AuthLevel;
  requiredLevel: AuthLevel;
  riskTier: RiskTier;
  reason: string;
  decisionId: string;
}

export class AuthorizationEngine {
  /**
   * Identity confidence is NOT authorization level (invariant #1). This
   * mapping is the one deliberate, auditable place that translates one into
   * the other — everywhere else must go through here, not roll its own.
   */
  levelFromIdentity(identity: IdentityResult): AuthLevel {
    if (identity.resolvedAs === "gavin" && identity.signal === "pin" && identity.confidence >= 0.9) {
      return "verified";
    }
    if (identity.resolvedAs === "gavin") return "gavin";
    if (identity.resolvedAs === "recognized") return "recognized";
    return "unknown";
  }

  inferRiskTier(action: string): RiskTier {
    if (ADMIN_ACTIONS.has(action)) return "admin";
    if (LOW_RISK_ACTIONS.has(action)) return "low";
    return "normal";
  }

  private requiredLevelFor(riskTier: RiskTier): AuthLevel {
    switch (riskTier) {
      case "low":
        return "unknown";
      case "normal":
        return "gavin";
      case "admin":
        return "verified";
    }
  }

  /**
   * The single entry point every tool/action must pass through. Returns a
   * decision and always records it — allowed or not — so "what did JARVIS
   * let happen and why" is answerable later (invariant #12).
   */
  async authorize(
    identity: IdentityResult,
    action: string,
    riskTierOverride?: RiskTier
  ): Promise<AuthorizeResult> {
    const level = this.levelFromIdentity(identity);
    const riskTier = riskTierOverride ?? this.inferRiskTier(action);
    const requiredLevel = this.requiredLevelFor(riskTier);
    const hasRank = LEVEL_RANK[level] >= LEVEL_RANK[requiredLevel];

    let decision: Decision;
    let reason: string;

    if (hasRank) {
      decision = "allowed";
      reason = `Level "${level}" meets required "${requiredLevel}" for ${riskTier}-risk action "${action}".`;
    } else if (riskTier === "admin" && level === "gavin") {
      // Recognized as Gavin via device session, but admin actions require
      // an actual verification step (PIN), not just being logged in.
      decision = "needs_verification";
      reason = `"${action}" is admin-tier. Being recognized as Gavin isn't enough — provide PIN verification first.`;
    } else {
      decision = "denied";
      reason = `Level "${level}" does not meet required "${requiredLevel}" for ${riskTier}-risk action "${action}".`;
    }

    const db = getDatabase();
    const [record] = await db
      .insert(authorizationDecisions)
      .values({
        identitySessionId: identity.sessionId,
        level,
        action,
        riskTier,
        requiredLevel,
        decision,
        verificationMethod: identity.signal === "pin" ? "pin" : null,
      })
      .returning();

    await logAuditEvent({
      actor: "authorization-engine",
      action: "authorize",
      resource: "authorization_decision",
      resourceId: record.id,
      input: { requestedAction: action, riskTier },
      result: { decision, level, requiredLevel },
      statusCode: decision === "allowed" ? 200 : decision === "needs_verification" ? 401 : 403,
    });

    return {
      decision,
      allowed: decision === "allowed",
      level,
      requiredLevel,
      riskTier,
      reason,
      decisionId: record.id,
    };
  }
}

export const authorizationEngine = new AuthorizationEngine();
