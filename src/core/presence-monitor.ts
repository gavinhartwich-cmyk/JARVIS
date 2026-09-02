/**
 * Real Windows idle-time detection, feeding presence.ts's real
 * active/idle/away tracking (Part 3.1) with a genuine signal instead of
 * a fabricated one.
 *
 * Real problem this solves: presenceEngine.heartbeat("pc") marks the PC
 * "active" whenever it's called - but nothing in this codebase called it
 * on any real cadence tied to Gavin actually being at the keyboard. A
 * background process heartbeating on its own schedule would make the PC
 * look "active" forever regardless of whether Gavin is really there,
 * which is the opposite of what Part 7's "away -> phone notification"
 * routing needs to work for real.
 *
 * Uses Win32's real GetLastInputInfo (same PowerShell shell-out pattern
 * as everything else in phase3/windows-control.ts) - a well-established,
 * standard technique for real OS-level idle detection, not guessed.
 */

import { runPowerShell } from "../phase3/windows-control";

/** Real seconds since the last keyboard/mouse input, system-wide. */
export async function getIdleSeconds(): Promise<number> {
  const { stdout } = await runPowerShell(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class JarvisIdleTime {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
}
"@
$lii = New-Object JarvisIdleTime+LASTINPUTINFO
$lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
[JarvisIdleTime]::GetLastInputInfo([ref]$lii) | Out-Null
$idleMs = [Environment]::TickCount - $lii.dwTime
Write-Output ($idleMs / 1000)
`);
  const seconds = parseFloat(stdout.trim());
  if (Number.isNaN(seconds)) {
    throw new Error(`GetLastInputInfo returned unparseable output: ${JSON.stringify(stdout)}`);
  }
  return seconds;
}

/**
 * Real, not fabricated: true only when Gavin has genuinely touched the
 * keyboard/mouse within presence.ts's own "active" window. A caller
 * should heartbeat("pc") only when this returns true - never
 * unconditionally on a timer, which would just fake "always active."
 */
export async function isGenuinelyAtKeyboard(activeWindowSeconds = 300): Promise<boolean> {
  const idleSeconds = await getIdleSeconds();
  return idleSeconds < activeWindowSeconds;
}
