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

export function runPowerShell(script: string, timeoutMs = 10_000): Promise<{ stdout: string; stderr: string }> {
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
export function psEscape(s: string): string {
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
    // BUG FIX (2026-08-31, confirmed live): plain `Start-Process "<name>"`
    // only works when <name> is directly on PATH (system tools like
    // notepad.exe, calc.exe) or an exact file/executable path - it fails
    // outright for a normally-installed Start Menu app under a different
    // real executable name or location. Confirmed live: Gavin has
    // Spotify genuinely installed and it's in his Start Menu, but
    // `Start-Process "Spotify"` failed with "The system cannot find the
    // file specified" - Spotify's actual executable isn't named or
    // located anything a bare guess would find. Real fix: search the
    // actual Windows Start Menu app index (Get-StartApps - the same
    // index Windows Search itself uses, covers both traditional desktop
    // shortcuts and Microsoft Store/UWP apps, which often have no
    // PATH-visible executable at all) for a fuzzy name match, and launch
    // it through the shell:AppsFolder namespace via its real AppID - the
    // same mechanism the real Start Menu/Windows Search uses to launch
    // an app, not a guess at a bare name. Falls back to the old plain
    // Start-Process behavior only when nothing in the Start Menu
    // matches, which still correctly covers bare system tool names
    // (notepad, calc, cmd) that may not surface as a friendly Start Menu
    // tile. Real, disclosed limitation this does NOT fix: it can only
    // launch what was actually asked for - a name garbled by speech
    // recognition upstream (e.g. "no pad" instead of "notepad") won't
    // fuzzy-match anything real either, and correctly falls through to
    // the same "couldn't find it" failure, now for the right reason.
    //
    // [UPDATE 2026-08-31, second confirmation] Ran live and STILL opened
    // plain File Explorer for both "Spotify" and "Notepad" instead of the
    // real app - root-caused to a genuine escaping bug in THIS file, not
    // Windows or Get-StartApps: the PowerShell was built from a TS
    // template literal containing `\$($app.AppID)`, but `\$` inside a
    // JS/TS template literal is itself a recognized escape sequence that
    // collapses to a literal `$` - it silently swallowed the backslash
    // before the string ever reached PowerShell. The PowerShell that
    // actually ran was `shell:AppsFolder$($app.AppID)` (missing the
    // separator between "AppsFolder" and the AppID), which explorer.exe
    // can't resolve to any real app - and its documented behavior on an
    // unresolvable shell: URI is to just open a plain File Explorer
    // window instead of erroring, which is exactly what Gavin saw, with
    // Start-Process itself still reporting success (it launched
    // explorer.exe fine - explorer.exe just didn't do what the URI
    // asked). Verified the exact string this file was producing via a
    // real Node template-literal test before touching this, and verified
    // the fix's output separately - `\\$(...)` (an escaped backslash,
    // producing a real literal `\` in the emitted PowerShell) is what
    // survives into the actual script now.
    const escapedName = psEscape(name);
    await runPowerShell(`
$name = "${escapedName}"
$app = Get-StartApps | Where-Object { $_.Name -like "*$name*" } | Select-Object -First 1
if ($app) {
  Start-Process "explorer.exe" -ArgumentList "shell:AppsFolder\\$($app.AppID)"
} else {
  Start-Process "$name"
}
`);
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
