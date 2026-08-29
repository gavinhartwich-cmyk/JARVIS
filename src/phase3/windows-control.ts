/**
 * Real Windows input automation, backed by PowerShell.
 *
 * IMPORTANT — read before trusting this: this file was written and
 * typechecked on a Linux sandbox that cannot run PowerShell or drive a
 * Windows desktop. It has NEVER been executed. It is real code, not a
 * simulation, but it is UNVERIFIED until it's actually run on the PC.
 * Use `bun run dev control-test` there first and report back what happens
 * before trusting it inside a real task pipeline.
 *
 * Approach: shell out to `powershell.exe` per action rather than a native
 * Node addon (robotjs/nut-js) — native addons have a history of breaking
 * against Bun's ABI, and a PowerShell one-liner is something a human can
 * read, copy, and run by hand to debug when something goes wrong.
 */

import { spawn } from "node:child_process";

function runPowerShell(script: string, timeoutMs = 10_000): Promise<{ stdout: string; stderr: string }> {
  if (process.platform !== "win32") {
    return Promise.reject(
      new Error(
        `Computer control requires Windows (got "${process.platform}"). ` +
          `This can only run on the actual PC, not in the Zo sandbox.`
      )
    );
  }

  return new Promise((resolve, reject) => {
    const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`PowerShell exited ${code}: ${stderr || stdout}`));
    });
  });
}

// Escapes a string for safe interpolation inside a PowerShell double-quoted string.
function psEscape(s: string): string {
  return s.replace(/`/g, "``").replace(/"/g, '`"').replace(/\$/g, "`$");
}

// Win32 API bindings, loaded once per PowerShell invocation via Add-Type.
const WIN32_TYPE = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Control {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
}
"@
`;

const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_WHEEL = 0x0800;

export class WindowsController {
  async click(x: number, y: number): Promise<void> {
    await runPowerShell(`
${WIN32_TYPE}
[Win32Control]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})
Start-Sleep -Milliseconds 30
[Win32Control]::mouse_event(${MOUSEEVENTF_LEFTDOWN}, 0, 0, 0, 0)
Start-Sleep -Milliseconds 30
[Win32Control]::mouse_event(${MOUSEEVENTF_LEFTUP}, 0, 0, 0, 0)
`);
  }

  async typeText(text: string): Promise<void> {
    await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${psEscape(text)}")
`);
  }

  /**
   * key("ctrl+s"), key("enter"), key("escape") — translates a simple
   * "mod+mod+key" string into SendKeys syntax.
   */
  async pressKey(combo: string): Promise<void> {
    const sendKeysCombo = this.toSendKeysSyntax(combo);
    await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${psEscape(sendKeysCombo)}")
`);
  }

  private toSendKeysSyntax(combo: string): string {
    const specialKeys: Record<string, string> = {
      enter: "{ENTER}",
      escape: "{ESC}",
      esc: "{ESC}",
      tab: "{TAB}",
      backspace: "{BACKSPACE}",
      delete: "{DELETE}",
      up: "{UP}",
      down: "{DOWN}",
      left: "{LEFT}",
      right: "{RIGHT}",
      home: "{HOME}",
      end: "{END}",
      pageup: "{PGUP}",
      pagedown: "{PGDN}",
      f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}", f5: "{F5}", f6: "{F6}",
    };

    const parts = combo.toLowerCase().split("+").map((p) => p.trim());
    let modifiers = "";
    let mainKey = parts[parts.length - 1];

    for (const part of parts.slice(0, -1)) {
      if (part === "ctrl" || part === "control") modifiers += "^";
      else if (part === "alt") modifiers += "%";
      else if (part === "shift") modifiers += "+";
    }

    // SECURITY FIX (2026-08-28, full-codebase review): every other method
    // in this file (typeText, openApplication, closeApplication,
    // focusWindow) runs its string argument through psEscape() before
    // interpolating it into the PowerShell double-quoted SendKeys/
    // Start-Process string. This method didn't — `mainKey` falls through
    // to `specialKeys[mainKey] ?? mainKey` verbatim for any key name not
    // in the small special-keys map above, so an unescaped value reached
    // the caller (previously interpolated with no escaping at all; now
    // psEscape() is applied to the whole combo string at the call site
    // above as a second layer of defense too). A key/combo string
    // containing `"` followed by PowerShell statement separators could
    // otherwise break out of the SendKeys("...") string and run arbitrary
    // PowerShell — this is a first-class field on the public
    // ControlAction/ScreenControl.key() API, so it's reachable by
    // anything (a future agent/LLM tool-calling path, not just the
    // current hardcoded "ctrl+a" caller) that constructs one.
    const mainKeySyntax = specialKeys[mainKey] ?? psEscape(mainKey);
    return modifiers + mainKeySyntax;
  }

  async openApplication(name: string): Promise<void> {
    await runPowerShell(`Start-Process "${psEscape(name)}"`);
  }

  async closeApplication(name: string): Promise<void> {
    // Stops the first matching process by name (without .exe). Best-effort —
    // if nothing matches, PowerShell just reports nothing to stop.
    await runPowerShell(`Get-Process "${psEscape(name)}" -ErrorAction SilentlyContinue | Stop-Process`);
  }

  async focusWindow(windowTitle: string): Promise<void> {
    // BUG FIX (2026-08-28, full-codebase review): AppActivate returns a
    // boolean — false, not an exception, when no window matches the
    // title — but that return value was never checked. The script exited
    // 0 either way, so ScreenControl.executeSequence() reported success
    // regardless of whether anything was actually focused, and any
    // type/key/click actions later in the same sequence silently landed
    // on whatever window actually had focus instead of the intended one.
    // Now the script itself throws (nonzero exit, caught by
    // runPowerShell's reject path) when AppActivate reports no match.
    await runPowerShell(`
$shell = New-Object -ComObject WScript.Shell
$activated = $shell.AppActivate("${psEscape(windowTitle)}")
if (-not $activated) {
  Write-Error "No window matching title '${psEscape(windowTitle)}' could be activated."
  exit 1
}
`);
  }

  async scroll(amount: number): Promise<void> {
    // amount > 0 scrolls up, < 0 scrolls down, following the mouse_event WHEEL_DELTA convention (120 per notch).
    const delta = Math.round(amount) * 120;
    await runPowerShell(`
${WIN32_TYPE}
[Win32Control]::mouse_event(${MOUSEEVENTF_WHEEL}, 0, 0, ${delta}, 0)
`);
  }
}

export const windowsController = new WindowsController();
