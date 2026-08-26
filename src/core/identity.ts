import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { identitySessions, type IdentitySession } from "../db/schema";
import { logAuditEvent } from "./audit";

/**
 * Identity Recognition (master plan Part 3.2)
 *
 * CRITICAL INVARIANT: identity confidence is NOT an authorization level.
 * This engine only answers "how confident are we this is Gavin, and how."
 * The AuthorizationEngine (separate module) decides what that confidence
 * is allowed to do.
 *
 * Real signals implemented now: device session (this process running under
 * Gavin's own machine) and PIN (explicit verification for high-risk actions).
 * Face/voice recognition are declared but throw NOT_IMPLEMENTED — they need
 * camera/mic hardware on the actual PC and should not be faked here.
 */

export type IdentitySignal = "device_session" | "pin" | "face" | "voice";
export type ResolvedIdentity = "unknown" | "recognized" | "gavin";

export interface IdentityResult {
  signal: IdentitySignal;
  confidence: number; // 0.00 - 1.00
  resolvedAs: ResolvedIdentity;
  sessionId: string;
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

export class IdentityEngine {
  /**
   * Baseline signal: this process is running on Gavin's own PC, under his
   * OS session — the normal case for a single-user local assistant, so it
   * resolves as "gavin" (enough for Level 2 / normal access). Confidence is
   * capped below PIN-grade trust (0.75, not 0.95+) because it can't actually
   * distinguish Gavin from anyone else sitting at an unlocked PC — that gap
   * is exactly why admin-tier actions require a PIN on top of this, not
   * this signal alone (see AuthorizationEngine).
   */
  async resolveFromDeviceSession(deviceId?: string): Promise<IdentityResult> {
    const confidence = 0.75;
    const resolvedAs: ResolvedIdentity = confidence >= 0.6 ? "gavin" : "unknown";
    return this.record("device_session", confidence, resolvedAs, deviceId);
  }

  /**
   * Strong signal: PIN set via JARVIS_PIN env var, checked in constant time.
   * This is what should back Level 3 ("Verified Gavin") authorization checks.
   */
  async resolveFromPin(providedPin: string, deviceId?: string): Promise<IdentityResult> {
    const configuredPin = process.env.JARVIS_PIN;
    if (!configuredPin) {
      return this.record("pin", 0, "unknown", deviceId, {
        error: "JARVIS_PIN not configured — cannot verify.",
      });
    }

    const matches = constantTimeEqual(providedPin, configuredPin);
    const confidence = matches ? 0.98 : 0;
    const resolvedAs: ResolvedIdentity = matches ? "gavin" : "unknown";
    return this.record("pin", confidence, resolvedAs, deviceId);
  }

  async resolveFromFace(): Promise<IdentityResult> {
    throw new Error(
      "Face recognition not implemented — needs a camera pipeline running on the PC. " +
        "Not stubbed as fake-working; do not call this until it's actually built."
    );
  }

  async resolveFromVoice(): Promise<IdentityResult> {
    throw new Error(
      "Voice recognition not implemented — needs a microphone pipeline running on the PC. " +
        "Not stubbed as fake-working; do not call this until it's actually built."
    );
  }

  private async record(
    signal: IdentitySignal,
    confidence: number,
    resolvedAs: ResolvedIdentity,
    deviceId?: string,
    metadata?: Record<string, unknown>
  ): Promise<IdentityResult> {
    const db = getDatabase();
    const [session] = await db
      .insert(identitySessions)
      .values({
        deviceId,
        claimedIdentity: "gavin",
        signal,
        confidence: confidence.toFixed(2),
        resolvedAs,
        metadata,
      })
      .returning();

    await logAuditEvent({
      actor: "identity-engine",
      action: "identity_resolved",
      resource: "identity_session",
      resourceId: session.id,
      result: { signal, confidence, resolvedAs },
    });

    return { signal, confidence, resolvedAs, sessionId: session.id };
  }

  async getSession(sessionId: string): Promise<IdentitySession | undefined> {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(identitySessions)
      .where(eq(identitySessions.id, sessionId))
      .limit(1);
    return rows[0];
  }
}

export const identityEngine = new IdentityEngine();
