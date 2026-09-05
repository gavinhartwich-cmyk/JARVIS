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

/**
 * [ADDED 2026-09-02] Thrown instead of the generic "killed by signal"
 * error when the caller's own AbortSignal is what ended the process -
 * lets a caller (see audio-player.ts's playWavBuffer) distinguish "I
 * asked for this" (e.g. real barge-in, interrupting JARVIS's own
 * playback) from a genuine failure/timeout, which need very different
 * handling (silent/expected vs. logged as a real error).
 */
export class PowerShellAbortedError extends Error {
  constructor() {
    super("PowerShell process aborted by caller");
    this.name = "PowerShellAbortedError";
  }
}

export function runPowerShell(
  script: string,
  timeoutMs = 10_000,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
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

    // Real cancellation (2026-09-02, for barge-in playback) - killing the
    // process is what actually stops audio mid-clip, since the PowerShell
    // script owns the real MediaPlayer/SoundPlayer COM object; there's no
    // separate "stop playback" message to send it, the process itself IS
    // the playback.
    let abortedByCaller = false;
    if (signal) {
      const onAbort = () => {
        abortedByCaller = true;
        proc.kill();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.on("close", (code, killSignal) => {
      if (code === 0) resolve({ stdout, stderr });
      else if (abortedByCaller) {
        reject(new PowerShellAbortedError());
      } else {
        // BUG FIX (2026-08-31): code is null when the process was killed
        // by a signal (e.g. this call's own timeoutMs firing) rather than
        // exiting on its own - a bare "PowerShell exited null:" told
        // Gavin nothing real about what happened. Report the signal too
        // so a real hang (killed by our own timeout) reads differently
        // from a real PowerShell error (nonzero exit code, real stderr).
        const reason = killSignal ? `killed by signal ${killSignal} (likely timed out after ${timeoutMs}ms)` : `exited ${code}`;
        reject(new Error(`PowerShell ${reason}: ${stderr || stdout}`));
      }
    });
  });
}

// Escapes a string for safe interpolation inside a PowerShell double-quoted string.
export function psEscape(s: string): string {
  return s.replace(/`/g, "``").replace(/"/g, '`"').replace(/\$/g, "`$");
}

// Win32 API bindings, loaded once per PowerShell invocation via Add-Type.
//
// [2026-09-02] Rewritten from the legacy SetCursorPos + mouse_event combo
// to SendInput, for two real, independently-confirmed reasons, not a
// stylistic preference:
//
// 1. SendInput is Microsoft's own documented replacement for mouse_event
//    ("has been superseded by SendInput") and, unlike a separate
//    SetCursorPos + relative mouse_event call, moves and clicks in one
//    atomic injected event using SCREEN-SIZE-NORMALIZED absolute
//    coordinates (0-65535, via GetSystemMetrics) - immune to a real class
//    of bug the old code had no defense against at all: any DPI/display-
//    scaling mismatch between the calling process and the real screen
//    would have silently sent the click to the wrong physical pixel.
//
// 2. A real, previously-undisclosed bug found live while building
//    click-by-element-name (ui-automation.ts): the OLD code never checked
//    whether SetCursorPos/mouse_event actually succeeded - both are
//    void/best-effort-looking Win32 calls, and a real live test in this
//    session's own tool-execution context (rebuilding a small isolated
//    repro, not guessed) found SetCursorPos returning FALSE and
//    SendInput returning 0 events sent, with GetLastWin32Error()
//    reporting ERROR_ACCESS_DENIED (5) - the OS refused to inject
//    synthetic input at all in that context, yet the OLD click()
//    reported complete, silent success regardless, because nothing ever
//    checked. That's the same category of bug this whole codebase treats
//    as unacceptable elsewhere (a hardcoded confidence fallback, a
//    fabricated vision description) - a real action silently claiming to
//    have happened when it didn't. Fixed here at the root: SendInput's
//    real return value (events actually injected) is checked, and a
//    short-of-expected count throws a real, honest error surfacing the
//    real Win32 error code, instead of returning cleanly regardless.
//
// Disclosed, NOT resolved by this fix: WHETHER input injection is denied
// this same way when JARVIS's real process runs under Gavin's own
// interactive Windows login session (a normal user desktop process, not
// this session's own restricted tool-execution context) is genuinely
// unverified from here - this is the same real category of environment
// limitation already found for screen capture (blank screenshots) and
// camera capture (black frames): this fix guarantees a real, loud error
// instead of a silent false success either way, which is the actual
// point - previously there was no way to even tell the two cases apart.
const WIN32_INPUT_TYPE = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Input {
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
}
"@
function New-JarvisMouseInput([uint32]$flags, [int]$dx = 0, [int]$dy = 0, [uint32]$data = 0) {
  $mi = New-Object Win32Input+MOUSEINPUT
  $mi.dx = $dx; $mi.dy = $dy; $mi.mouseData = $data; $mi.dwFlags = $flags; $mi.time = 0; $mi.dwExtraInfo = [IntPtr]::Zero
  $inp = New-Object Win32Input+INPUT
  $inp.type = 0
  $inp.mi = $mi
  return $inp
}
function Send-JarvisInput([Win32Input+INPUT[]]$inputs) {
  $sent = [Win32Input]::SendInput($inputs.Length, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type][Win32Input+INPUT]))
  if ($sent -ne $inputs.Length) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Error "SendInput injected only $sent of $($inputs.Length) real events (Win32 error $err) - the OS refused synthetic input, this process may lack interactive-desktop input permission"
    exit 1
  }
}
`;

const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_WHEEL = 0x0800;

export class WindowsController {
  async click(x: number, y: number): Promise<void> {
    await runPowerShell(`
${WIN32_INPUT_TYPE}
$screenW = [Win32Input]::GetSystemMetrics(0)
$screenH = [Win32Input]::GetSystemMetrics(1)
$normX = [int]([Math]::Round(${Math.round(x)} * 65535 / $screenW))
$normY = [int]([Math]::Round(${Math.round(y)} * 65535 / $screenH))
Send-JarvisInput @(
  (New-JarvisMouseInput -flags (${MOUSEEVENTF_MOVE} -bor ${MOUSEEVENTF_ABSOLUTE}) -dx $normX -dy $normY)
)
Start-Sleep -Milliseconds 30
Send-JarvisInput @((New-JarvisMouseInput -flags ${MOUSEEVENTF_LEFTDOWN}))
Start-Sleep -Milliseconds 30
Send-JarvisInput @((New-JarvisMouseInput -flags ${MOUSEEVENTF_LEFTUP}))
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

  // [ADDED 2026-09-03] Real gap closed - per Gavin: "he needs to
  // understnad when soemting requires opening chrome then seartching,"
  // after asking to "open youtube" and getting a failure. YouTube isn't
  // a native Windows app - Get-StartApps genuinely has nothing to find,
  // and the old code's only fallback (plain Start-Process "<name>") just
  // fails outright for a website name. A curated real list of well-known
  // WEBSITES (not a "guess <name>.com" heuristic - too unreliable for
  // things like "notepad" or "calculator," which are never websites) -
  // matched BEFORE the Get-StartApps lookup, since none of these
  // realistically collide with an installed native app on a normal
  // Windows machine. Deliberately excludes Spotify - opening the
  // Spotify *app* should stay app-control's job; playing music is
  // core/spotify.ts's real, separate intent.
  private static readonly KNOWN_WEBSITES: Record<string, string> = {
    youtube: "https://www.youtube.com",
    gmail: "https://mail.google.com",
    google: "https://www.google.com",
    netflix: "https://www.netflix.com",
    reddit: "https://www.reddit.com",
    amazon: "https://www.amazon.com",
    "twitter": "https://www.x.com",
    x: "https://www.x.com",
    facebook: "https://www.facebook.com",
    instagram: "https://www.instagram.com",
    linkedin: "https://www.linkedin.com",
    outlook: "https://outlook.com",
    twitch: "https://www.twitch.tv",
    wikipedia: "https://www.wikipedia.org",
    maps: "https://maps.google.com",
    "google maps": "https://maps.google.com",
  };

  /**
   * [UPDATE 2026-09-03] Now returns a real, honest description of WHAT
   * actually happened, not just void - per Gavin's own real ask, this
   * feeds back into the conversational reply so JARVIS can honestly say
   * "I wasn't sure exactly what that was, so I searched for it" instead
   * of implying it opened the specific named thing when it actually
   * fell back to a search.
   */
  async openApplication(name: string): Promise<string> {
    const knownUrl = WindowsController.KNOWN_WEBSITES[name.trim().toLowerCase()];
    if (knownUrl) {
      console.log(`   → "${name}" is a real website, not a native app - opening it in the default browser: ${knownUrl}`);
      // Windows resolves a URL-shaped Start-Process target to the real
      // default browser automatically - no need to name a specific
      // browser executable (Chrome/Edge/whatever Gavin actually has set
      // as default), same real mechanism as double-clicking a link.
      await runPowerShell(`Start-Process "${psEscape(knownUrl)}"`);
      return `Opened ${name} in your browser (${knownUrl})`;
    }

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
    // [UPDATE 2026-09-03] Real, more general fallback added - per Gavin,
    // beyond the curated KNOWN_WEBSITES check above: "he needs to
    // understnad when soemting requires opening chrome then seartching."
    // If Get-StartApps finds no real installed app AND the bare
    // Start-Process attempt ALSO genuinely fails (not a real executable
    // name either - the common case for a website/service name not on
    // the curated list), fall back to a real Google search for the name
    // in the default browser instead of just failing outright. This is
    // deliberately the LAST resort, after both real, more precise
    // options (an actual installed app, or a specifically-known website)
    // have already failed - a graceful "I don't know exactly what this
    // is, but here's a real search for it" rather than a bare error.
    const { stdout } = await runPowerShell(`
$name = "${escapedName}"
$app = Get-StartApps | Where-Object { $_.Name -like "*$name*" } | Select-Object -First 1
if ($app) {
  Write-Output "REAL_APP:$($app.Name)"
  Start-Process "explorer.exe" -ArgumentList "shell:AppsFolder\\$($app.AppID)"
} else {
  try {
    Start-Process "$name" -ErrorAction Stop
    Write-Output "REAL_APP:$name"
  } catch {
    Write-Output "FALLBACK_SEARCH"
    Start-Process "https://www.google.com/search?q=$([uri]::EscapeDataString($name))"
  }
}
`);
    if (stdout.includes("FALLBACK_SEARCH")) {
      return `Couldn't find a real app or website called "${name}" - searched for it on Google instead`;
    }
    const realAppMatch = stdout.match(/REAL_APP:(.+)/);
    return `Opened ${realAppMatch ? realAppMatch[1].trim() : name}`;
  }

  /**
   * [CHANGED 2026-09-04] Real behavior change per Gavin's direct
   * preference: "I want close to be minimized." Previously this did a
   * `Get-Process <name> | Stop-Process` - a real, working match for a
   * native app whose process name matches what was asked (Notepad,
   * Spotify), but it silently did NOTHING for a website opened via
   * openApplication()'s KNOWN_WEBSITES/search fallback (a browser tab,
   * not its own process) - "close YouTube" found no process literally
   * named "youtube" and reported success having done nothing. Real fix,
   * not just closing that one gap: match by real window TITLE instead of
   * process name (Get-Process's own MainWindowTitle - the same real
   * mechanism focusWindow()'s AppActivate already relies on for the same
   * "loosely-named target -> the actual window" problem), and MINIMIZE
   * the match (real Win32 ShowWindowAsync, SW_MINIMIZE) instead of
   * killing it - safer (reversible, the user can restore it any time)
   * and works uniformly for both a native app's window and a browser
   * tab's window, since a browser tab's title genuinely includes the
   * page title ("YouTube - Microsoft Edge") the same way any other
   * window's title would match.
   *
   * [FIXED 2026-09-05] Real bug found live: asked to close Spotify right
   * after playing a track, and it reported "Couldn't find a real open
   * window matching 'Spotify'" - Spotify never actually minimized (Gavin,
   * directly: "on the spotify closing it didnt minimize it thats what im
   * saying"). Root cause: this only matched on MainWindowTitle, but
   * Spotify's real window title changes to the currently-playing
   * "Song - Artist" the moment something plays - it does NOT keep saying
   * "Spotify" the way a freshly-opened, idle window does. Title-only
   * matching is exactly right for a browser tab (no stable process name
   * to match on) but wrong for a native app whose title is dynamic -
   * media players being the obvious case, but also things like editors
   * that show the open file name. Fixed by ALSO matching on the real
   * process name (Get-Process's own Name - stable for "Spotify"
   * regardless of what the window title currently says), tried alongside
   * the existing title match rather than instead of it, so the browser-
   * tab case keeps working unchanged.
   */
  async closeApplication(name: string): Promise<string> {
    const escapedName = psEscape(name);
    const { stdout } = await runPowerShell(`
Add-Type -Namespace JarvisWin32 -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);'
$name = "${escapedName}"
$matches = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -like "*$name*" -or $_.ProcessName -like "*$name*") }
if ($matches) {
  foreach ($p in $matches) { [JarvisWin32.Native]::ShowWindowAsync($p.MainWindowHandle, 6) | Out-Null }
  Write-Output "MINIMIZED:$($matches.Count):$($matches[0].MainWindowTitle)"
} else {
  Write-Output "NOT_FOUND"
}
`);
    if (stdout.includes("NOT_FOUND")) {
      return `Couldn't find a real open window matching "${name}" to minimize.`;
    }
    const match = stdout.match(/MINIMIZED:(\d+):(.+)/);
    return match
      ? `Minimized "${match[2].trim()}"${parseInt(match[1], 10) > 1 ? ` (and ${parseInt(match[1], 10) - 1} other matching window(s))` : ""}`
      : `Minimized ${name}`;
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
    // amount > 0 scrolls up, < 0 scrolls down, following the WHEEL_DELTA convention (120 per notch) - unchanged by the SendInput rewrite above.
    const delta = Math.round(amount) * 120;
    // mouseData for a wheel event is a signed delta but the struct field
    // (and New-JarvisMouseInput's -data param) is uint32 - converted to
    // its real unsigned 32-bit representation here (JS's >>> 0) so
    // PowerShell never has to do a signed->unsigned cast itself (which
    // throws on a negative literal assigned to a uint32-typed parameter).
    const unsignedDelta = delta >>> 0;
    await runPowerShell(`
${WIN32_INPUT_TYPE}
Send-JarvisInput @((New-JarvisMouseInput -flags ${MOUSEEVENTF_WHEEL} -data ${unsignedDelta}))
`);
  }
}

export const windowsController = new WindowsController();
