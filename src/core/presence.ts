import { eq, desc } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { devices, presenceEvents, type Device } from "../db/schema";
import { logAuditEvent } from "./audit";

/**
 * Presence & Device Awareness (master plan Part 3.1)
 *
 * Tracks which devices exist, whether they're currently reachable, and which
 * one should receive a given piece of communication. Real for PC (this
 * process sends its own heartbeat). Phone/wearable rows can be registered
 * and heartbeat externally once a phone client exists — nothing here
 * pretends that integration is built yet.
 */

const IDLE_AFTER_MS = 5 * 60 * 1000; // no heartbeat in 5 min -> idle
const AWAY_AFTER_MS = 20 * 60 * 1000; // no heartbeat in 20 min -> away

export type PresenceState = "active" | "idle" | "away" | "unknown";
export type Urgency = "low" | "medium" | "high" | "critical";

export interface DeviceWithComputedState extends Device {
  computedState: PresenceState;
}

export class PresenceEngine {
  async registerDevice(
    name: string,
    type: "pc" | "phone" | "wearable" | "other",
    capabilities: string[] = []
  ): Promise<Device> {
    const db = getDatabase();
    const existing = await db
      .select()
      .from(devices)
      .where(eq(devices.name, name))
      .limit(1);

    if (existing.length > 0) {
      return existing[0];
    }

    const [created] = await db
      .insert(devices)
      .values({ name, type, capabilities, presenceState: "unknown" })
      .returning();

    await logAuditEvent({
      actor: "presence-engine",
      action: "device_registered",
      resource: "device",
      resourceId: created.id,
      result: { name, type, capabilities },
    });

    return created;
  }

  /** Call periodically from a live process (e.g. the CLI/orchestrator) to mark a device active. */
  async heartbeat(deviceName: string): Promise<void> {
    const db = getDatabase();
    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.name, deviceName))
      .limit(1);

    if (!device) {
      throw new Error(
        `Cannot heartbeat unregistered device "${deviceName}" — call registerDevice() first.`
      );
    }

    const now = new Date();
    await db
      .update(devices)
      .set({ lastSeenAt: now, presenceState: "active" })
      .where(eq(devices.id, device.id));

    await db.insert(presenceEvents).values({
      deviceId: device.id,
      state: "active",
      source: "heartbeat",
    });
  }

  /** Explicit override — e.g. "I'm going out" should mark the PC away regardless of recent heartbeats. */
  async setPresence(
    deviceName: string,
    state: PresenceState,
    source: string = "explicit_command"
  ): Promise<void> {
    const db = getDatabase();
    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.name, deviceName))
      .limit(1);

    if (!device) {
      throw new Error(`Cannot set presence for unregistered device "${deviceName}".`);
    }

    await db.update(devices).set({ presenceState: state }).where(eq(devices.id, device.id));
    await db.insert(presenceEvents).values({ deviceId: device.id, state, source });

    await logAuditEvent({
      actor: "presence-engine",
      action: "presence_set",
      resource: "device",
      resourceId: device.id,
      result: { state, source },
    });
  }

  /** Computes real-time state from lastSeenAt, unless an explicit override (away) is newer than the last heartbeat window allows. */
  private computeState(device: Device): PresenceState {
    if (!device.lastSeenAt) return device.presenceState ?? "unknown";
    const ageMs = Date.now() - new Date(device.lastSeenAt).getTime();
    if (ageMs < IDLE_AFTER_MS) return "active";
    if (ageMs < AWAY_AFTER_MS) return "idle";
    return "away";
  }

  async listDevices(): Promise<DeviceWithComputedState[]> {
    const db = getDatabase();
    const rows = await db.select().from(devices).orderBy(desc(devices.lastSeenAt));
    return rows.map((d) => ({ ...d, computedState: this.computeState(d) }));
  }

  /** Which device should receive communication right now, given available devices and their live state. */
  async getActiveDevice(): Promise<DeviceWithComputedState | null> {
    const all = await this.listDevices();
    const active = all.filter((d) => d.computedState === "active");
    if (active.length === 0) return null;
    // Most recently seen active device wins.
    return active[0];
  }

  /**
   * Routing decision per master plan 3.1 / 7.3: presence must influence
   * communication. Returns which device (if any) should receive a message
   * of the given urgency right now, or null if nothing should be sent.
   */
  async routeCommunication(
    urgency: Urgency,
    requiredCapability?: string
  ): Promise<DeviceWithComputedState | null> {
    const all = await this.listDevices();
    const eligible = requiredCapability
      ? all.filter((d) => (d.capabilities ?? []).includes(requiredCapability))
      : all;

    const active = eligible.filter((d) => d.computedState === "active");
    if (active.length > 0) return active[0];

    if (urgency === "critical") {
      // Critical alerts override quiet/away state (invariant #10) — fall back
      // to the most recently seen eligible device even if not currently active.
      const idle = eligible.filter((d) => d.computedState === "idle");
      if (idle.length > 0) return idle[0];
      const away = eligible.filter((d) => d.computedState === "away");
      if (away.length > 0) return away[0];
    }

    // low/medium/high with no active device: queue, don't interrupt.
    return null;
  }
}

export const presenceEngine = new PresenceEngine();
