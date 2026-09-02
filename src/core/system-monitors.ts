/**
 * Real, $0, no-credential event monitors (master plan Part 7.1).
 *
 * Honest scope: Part 7.1's full monitoring list (Calendar, Email, Tasks,
 * Business, Personal/health, Patterns) needs real external API access
 * this codebase doesn't have yet - Google Calendar/Gmail OAuth, business
 * tooling, wearable data. That's real, blocked follow-up work (see the
 * master doc's Phase 4 status), not something to fabricate against.
 *
 * What IS real right now: local Windows system health. No new
 * dependency, no API key, no OAuth - the same PowerShell shell-out
 * pattern windows-control.ts already uses. This is the honest, buildable
 * slice of Part 7.1 that proves the real proactivity.ts decision engine
 * works end to end against real data, not a placeholder.
 */

import { runPowerShell } from "../phase3/windows-control";
import type { MonitoredEvent } from "./proactivity";

const LOW_DISK_THRESHOLD_GB = 10;
const CRITICAL_DISK_THRESHOLD_GB = 3;

interface DriveInfo {
  DeviceID: string;
  FreeGB: number;
  TotalGB: number;
}

/**
 * Real free-space check on every fixed local drive (DriveType=3 - not
 * network shares or removable media, which have their own real-world
 * "low space" semantics this doesn't try to cover). Confidence: 55
 * relevance (a real, ordinary housekeeping concern - matches Part 7.4's
 * "No Permission Needed: Organize files" territory, not something
 * requiring approval to just mention), urgency scales with how close to
 * actually full the drive is.
 */
export async function checkDiskSpace(): Promise<MonitoredEvent[]> {
  const events: MonitoredEvent[] = [];
  try {
    const { stdout } = await runPowerShell(
      `Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ` +
        `Select-Object DeviceID, @{N='FreeGB';E={[math]::Round($_.FreeSpace/1GB,1)}}, @{N='TotalGB';E={[math]::Round($_.Size/1GB,1)}} | ` +
        `ConvertTo-Json -Compress`
    );
    const parsed = JSON.parse(stdout.trim() || "[]");
    const drives: DriveInfo[] = Array.isArray(parsed) ? parsed : [parsed];

    for (const d of drives) {
      if (typeof d.FreeGB !== "number" || d.FreeGB >= LOW_DISK_THRESHOLD_GB) continue;
      const critical = d.FreeGB < CRITICAL_DISK_THRESHOLD_GB;
      events.push({
        source: "disk-space",
        summary: `Drive ${d.DeviceID} is down to ${d.FreeGB}GB free out of ${d.TotalGB}GB.`,
        dedupeKey: `disk-space:${d.DeviceID}`,
        relevance: 55,
        urgency: critical ? 65 : 30,
        metadata: { drive: d.DeviceID, freeGb: d.FreeGB, totalGb: d.TotalGB },
      });
    }
  } catch (err) {
    console.error(`   ⚠️  Disk space monitor failed (non-fatal, skipping this pass): ${err instanceof Error ? err.message : err}`);
  }
  return events;
}

/**
 * Every real monitor this codebase currently has - see this file's own
 * header for what's deliberately not here yet. Calendar (checkUpcomingMeetings,
 * calendar-monitor.ts) is real too as of 2026-09-02, kept in its own file
 * since it's a real external API integration, not local-only like the
 * monitors above.
 */
export async function runAllMonitors(): Promise<MonitoredEvent[]> {
  const { checkUpcomingMeetings } = await import("./calendar-monitor");
  const results = await Promise.all([checkDiskSpace(), checkUpcomingMeetings()]);
  return results.flat();
}
