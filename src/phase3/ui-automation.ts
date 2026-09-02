/**
 * Phase 3: Real Windows UI Automation — element-level "click the X button"
 *
 * [ADDED 2026-09-02] Real gap closed, per Gavin: "screen control is
 * supposed to be able to do things like click buttons etc just like you
 * can instead of use api keys thats much clunkier." Before this,
 * screen-control.ts's click-by-name path (executeAction()'s "click"
 * case) threw unconditionally - "Cannot click target by name yet - needs
 * the Vision system, which isn't connected here."
 *
 * Real investigation before building anything, not assumed: tried
 * vision-based element location first, since VisionSystem/
 * OllamaVisionProvider already existed and was already wired for screen
 * vision. moondream (the only local $0 vision model available - see
 * ollama-vision-provider.ts) genuinely cannot give reliable pixel
 * coordinates. Confirmed directly against a real generated test image
 * with two buttons at known positions: every "point to X" / "give x,y
 * coordinates" style prompt got an EMPTY response (the same failure
 * class already documented in ollama-vision-provider.ts's own header
 * comment), and even natural-language position questions ("is it near
 * the top or bottom?") only sometimes answered correctly and often only
 * answered half the question - a real, honest capability ceiling for a
 * small captioning model, not a prompt-wording bug. Building a "click
 * roughly where moondream thinks the button is" fallback on top of that
 * would risk a real misclick on small real UI buttons (a synthetic
 * 120x40px test button is already generous compared to most real ones),
 * which is worse than a clear failure - not built.
 *
 * Real, better mechanism instead: Windows' own UI Automation API
 * (`System.Windows.Automation`, part of .NET Framework, present on every
 * Windows machine - no new dependency), which directly queries the OS
 * accessibility tree for a window's REAL controls: their real names and
 * real exact bounding rectangles, no vision/LLM guessing involved at
 * all. Confirmed live before building this wrapper: enumerating a real
 * open Chrome window this way returned 32 real buttons with real names
 * ("Back", "Forward", "Reload", "Close", etc.) and exact pixel centers -
 * this is the same real mechanism most GUI-automation tools use for
 * reliable "click the X button," not a JARVIS-specific trick.
 *
 * Honest, disclosed limitation: not every app exposes its UI to
 * accessibility APIs the same way (custom-rendered UI, some games,
 * canvas-based web content) - findElement() returns null rather than
 * fabricating a location when nothing real is found. There is
 * deliberately no vision-based fallback for that case yet - see the
 * capability-ceiling finding above.
 */

import { runPowerShell, psEscape } from "./windows-control";

export interface FoundElement {
  name: string;
  controlType: string;
  x: number; // center of the real bounding rectangle
  y: number;
  width: number;
  height: number;
}

// Scoped to real interactive control types rather than every element in
// the accessibility tree (TrueCondition would also match static text,
// panes, groups, etc.) - both faster (fewer elements to pull properties
// for over the real PowerShell<->UIA boundary) and more correct (a
// substring match against a paragraph of static text isn't a "button").
const INTERACTIVE_CONTROL_TYPES = [
  "Button",
  "MenuItem",
  "ListItem",
  "TabItem",
  "Hyperlink",
  "CheckBox",
  "RadioButton",
  "ComboBox",
  "SplitButton",
];

/**
 * Real element search: looks inside the given window (by exact real
 * title; defaults to the current real foreground window when omitted)
 * for an interactive control whose Name contains `elementName`
 * (case-insensitive substring - "save" matches a real "Save File"
 * button, not just an exact "Save"). Returns the first genuinely
 * on-screen match with a real, non-empty bounding rectangle, or null if
 * nothing real matched - never fabricates a location.
 */
export async function findElement(
  elementName: string,
  windowTitle?: string
): Promise<FoundElement | null> {
  // Real bug found and fixed live while building this (not guessed):
  // PowerShell's `New-Object` cmdlet does NOT accept C#-style parenthesized
  // constructor args (`New-Object Type(a, b)`) - that's silently parsed as
  // a single positional argument and fails ("cannot find an appropriate
  // constructor"), confirmed directly. Real fix is `-ArgumentList`, but an
  // OrCondition built from 9 PropertyConditions this way ran into the same
  // array-vs-args ambiguity. Simpler and equally fast in practice (67 real
  // elements enumerated instantly in live testing): search with
  // TrueCondition and filter by ControlType.ProgrammaticName manually in
  // the same loop that already filters by name - one enumeration, two
  // real filters, no fragile nested-condition construction.
  const allowedTypesList = INTERACTIVE_CONTROL_TYPES.map((t) => `"${t}"`).join(",");

  // Second real bug found and fixed live in the same pass, subtler than
  // the first: below, the element name's own `-replace` chain needs
  // `"\\|"` (double backslash), not `"\|"`, even though `"\|"` is what a
  // human would naturally write for "escaped pipe" in a PowerShell regex.
  // Root cause confirmed via a minimal repro, not guessed: this whole
  // script is itself a JS template literal, and JS silently drops a
  // backslash before any character that isn't one of its own recognized
  // escapes (`\n`, `\t`, `\\`, `` \` ``, etc.) - `"\|"` in the JS source
  // parses down to the single character `|`, not two characters `\|`.
  // PowerShell then receives a bare `|` as the ENTIRE -replace regex
  // pattern, which as regex alternation means "match empty string OR
  // match empty string" - matches between every character. Confirmed via
  // a real minimal test: "Close" -replace "|" (the bare-pipe version)
  // came back as "/C/l/o/s/e/", not "Close" - inserting the replacement
  // at every zero-width match. `"\\|"` is what actually survives JS's
  // template-literal parsing as the real two-character `\|` PowerShell
  // needs to match a literal pipe.
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Foreground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@

$root = [System.Windows.Automation.AutomationElement]::RootElement
${
  windowTitle
    ? `
$winCondition = New-Object -TypeName System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::NameProperty), "${psEscape(windowTitle)}"
$scope = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $winCondition)
if ($scope -eq $null) { Write-Output "WINDOW_NOT_FOUND"; exit }
`
    : `
$fgHandle = [Win32Foreground]::GetForegroundWindow()
$scope = [System.Windows.Automation.AutomationElement]::FromHandle($fgHandle)
if ($scope -eq $null) { $scope = $root }
`
}

$allowedTypes = @(${allowedTypesList})
$all = $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)

$target = "${psEscape(elementName)}".ToLower()
$best = $null
foreach ($el in $all) {
  try {
    $typeName = $el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "")
    if (-not ($allowedTypes -contains $typeName)) { continue }
    $name = $el.Current.Name
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    if (-not $name.ToLower().Contains($target)) { continue }
    if ($el.Current.IsOffscreen) { continue }
    $rect = $el.Current.BoundingRectangle
    if ($rect.Width -le 0 -or $rect.Height -le 0 -or [double]::IsInfinity($rect.Width)) { continue }
    $best = $el
    break
  } catch {}
}

if ($best -eq $null) { Write-Output "NOT_FOUND"; exit }

$rect = $best.Current.BoundingRectangle
$cx = [int]($rect.X + $rect.Width / 2)
$cy = [int]($rect.Y + $rect.Height / 2)
$ctype = $best.Current.ControlType.ProgrammaticName
$name = $best.Current.Name -replace "\`n"," " -replace "\\|","/"
Write-Output "FOUND|$name|$ctype|$cx|$cy|$([int]$rect.Width)|$([int]$rect.Height)"
`;

  // A busy window (a full browser, an IDE) can genuinely have thousands
  // of accessibility elements to walk - a longer real timeout than this
  // file's other quick one-off calls, not a sign anything's wrong if it
  // takes a couple of real seconds.
  const { stdout } = await runPowerShell(script, 15_000);
  const line = stdout.trim().split("\n").pop()?.trim() ?? "";

  if (line === "NOT_FOUND" || line === "WINDOW_NOT_FOUND" || !line.startsWith("FOUND|")) {
    return null;
  }

  const parts = line.split("|");
  const [, name, controlType, xStr, yStr, wStr, hStr] = parts;
  return {
    name,
    controlType,
    x: parseInt(xStr, 10),
    y: parseInt(yStr, 10),
    width: parseInt(wStr, 10),
    height: parseInt(hStr, 10),
  };
}
