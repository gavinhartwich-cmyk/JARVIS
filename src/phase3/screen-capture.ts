/**
 * Phase 3: Screen Capture & Analysis
 *
 * [REWRITTEN 2026-09-02] Real finding, not previously disclosed: every
 * method in this file was a hardcoded/simulated placeholder -
 * captureScreen() generated random-noise pixels via Math.random() for
 * every byte (not a real screenshot at all), getActiveApplication() and
 * getOpenWindows() returned fixed fake data (literally fabricated
 * entries like "Chrome - Gmail" and "wsl.exe" that were never real),
 * and describeScreen() returned a hardcoded string describing that same
 * fake data instead of calling the real vision pipeline that already
 * existed elsewhere in this codebase (ollama-vision-provider.ts,
 * confirmed live and working via `bun run dev vision-test <path>`).
 *
 * Found while wiring vision into real conversation (Gavin's own Stage 4
 * example: "what's wrong with this code?" -> JARVIS looks at the
 * screen) - that scenario genuinely could not have worked before this,
 * regardless of the real vision-analysis half already being confirmed
 * live, because there was no real way to get a live screenshot INTO
 * that pipeline at all.
 *
 * Real implementation now: PowerShell + .NET (System.Windows.Forms.Screen
 * + System.Drawing.Bitmap.CopyFromScreen) for the actual screenshot -
 * the same technique already used (and confirmed working on this exact
 * machine) for this session's own diagnostic screenshots - plus real
 * Win32 GetForegroundWindow/GetWindowText/GetWindowRect for active-
 * window and open-window enumeration, matching windows-control.ts's
 * existing shell-out pattern.
 */

import { runPowerShell, psEscape } from "./windows-control";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface Screenshot {
  id: string;
  data: Buffer; // PNG image data
  width: number;
  height: number;
  timestamp: Date;
  activeApplication?: string;
  activeWindow?: string;
}

export interface WindowInfo {
  title: string;
  processName: string;
  windowClass: string;
  isActive: boolean;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface ScreenContext {
  resolution: { width: number; height: number };
  activeApplication: string;
  activeWindow: string;
  openWindows: WindowInfo[];
  screenshot?: Screenshot;
}

// Shared Win32 bindings for the real window-enumeration/foreground calls
// below - same WIN32_TYPE-style pattern windows-control.ts already uses,
// kept local to this file rather than imported (this codebase's
// established convention - see e.g. speech-synthesizer.ts/
// fish-audio-synthesizer.ts each owning their own wavDurationMs).
const WIN32_WINDOW_TYPE = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class JarvisWindowInfo {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
`;

/**
 * Screen Capture System - real desktop capture and window enumeration.
 */
export class ScreenCapture {
  private lastScreenshot?: Screenshot;
  private activeContext?: ScreenContext;

  constructor() {
    console.log("📺 Screen Capture System initialized");
  }

  /**
   * Real screenshot of the primary display via PowerShell + .NET -
   * writes a real PNG to a temp file (CopyFromScreen doesn't hand back
   * bytes directly), reads it back as a Buffer, cleans up.
   */
  async captureScreen(): Promise<Screenshot> {
    console.log("📸 Capturing screen...");

    const tempPath = join(tmpdir(), `jarvis-screencap-${randomUUID()}.png`);
    try {
      await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save("${psEscape(tempPath)}", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "$($bounds.Width)x$($bounds.Height)"
`);

      const data = readFileSync(tempPath);
      // Real dimensions from the PNG header itself (IHDR chunk, bytes
      // 16-23) rather than trusting the PowerShell echo - independent
      // confirmation, same "verify, don't just trust the caller" habit
      // used elsewhere in this codebase (e.g. audio-player.ts's own WAV
      // header parsing).
      const width = data.readUInt32BE(16);
      const height = data.readUInt32BE(20);

      const activeApp = await this.getActiveApplication();

      const screenshot: Screenshot = {
        id: `screenshot-${Date.now()}`,
        data,
        width,
        height,
        timestamp: new Date(),
        activeApplication: activeApp.application,
        activeWindow: activeApp.window,
      };

      this.lastScreenshot = screenshot;
      console.log(`✅ Screenshot captured: ${screenshot.width}x${screenshot.height}, ${data.length} bytes`);
      return screenshot;
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      console.error("❌ Screenshot capture failed:", err);
      throw error;
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup - a leftover temp PNG isn't worth failing over.
      }
    }
  }

  /**
   * Real active application/window via Win32 GetForegroundWindow +
   * GetWindowText + the owning process's name.
   */
  async getActiveApplication(): Promise<{
    application: string;
    window: string;
  }> {
    console.log("🔍 Detecting active application...");

    try {
      const { stdout } = await runPowerShell(`
${WIN32_WINDOW_TYPE}
$hwnd = [JarvisWindowInfo]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[JarvisWindowInfo]::GetWindowText($hwnd, $sb, 256) | Out-Null
$procId = 0
[JarvisWindowInfo]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
$procName = ""
try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
Write-Output "$procName|$($sb.ToString())"
`);
      const [processName, ...titleParts] = stdout.trim().split("|");
      const window = titleParts.join("|");
      const active = { application: processName || "unknown", window: window || "(no title)" };
      console.log(`   Active: ${active.application} - ${active.window}`);
      return active;
    } catch (error) {
      console.error(`   ⚠️  Could not detect active application: ${error instanceof Error ? error.message : error}`);
      return { application: "unknown", window: "unknown" };
    }
  }

  /**
   * Real open-window enumeration: every process with a non-empty
   * MainWindowTitle, real bounds via GetWindowRect. Doesn't enumerate
   * every raw HWND on the system (child controls, hidden windows,
   * tooltips) - scoped to real top-level application windows, which is
   * what "what's open" actually means in practice.
   */
  async getOpenWindows(): Promise<WindowInfo[]> {
    console.log("🪟 Enumerating open windows...");

    try {
      const { stdout } = await runPowerShell(`
${WIN32_WINDOW_TYPE}
$fg = [JarvisWindowInfo]::GetForegroundWindow()
Get-Process | Where-Object { $_.MainWindowTitle -ne "" -and $_.MainWindowHandle -ne 0 } | ForEach-Object {
  $rect = New-Object JarvisWindowInfo+RECT
  [JarvisWindowInfo]::GetWindowRect($_.MainWindowHandle, [ref]$rect) | Out-Null
  $isActive = ($_.MainWindowHandle -eq $fg)
  [PSCustomObject]@{
    title = $_.MainWindowTitle
    processName = $_.ProcessName
    isActive = $isActive
    x = $rect.Left
    y = $rect.Top
    width = ($rect.Right - $rect.Left)
    height = ($rect.Bottom - $rect.Top)
  }
} | ConvertTo-Json -Compress
`);
      const trimmed = stdout.trim();
      if (!trimmed) return [];
      const parsed = JSON.parse(trimmed);
      const raw = Array.isArray(parsed) ? parsed : [parsed];

      const windows: WindowInfo[] = raw.map((w: any) => ({
        title: w.title ?? "",
        processName: w.processName ?? "",
        // Real class name isn't fetched here (would need one more Win32
        // call per window, GetClassName) - left as the process name as
        // a real, honest stand-in rather than a fabricated class string.
        windowClass: w.processName ?? "",
        isActive: Boolean(w.isActive),
        bounds: { x: w.x ?? 0, y: w.y ?? 0, width: w.width ?? 0, height: w.height ?? 0 },
      }));

      console.log(`   Found ${windows.length} open windows`);
      return windows;
    } catch (error) {
      console.error(`   ⚠️  Could not enumerate open windows: ${error instanceof Error ? error.message : error}`);
      return [];
    }
  }

  /**
   * Real screen context - combines a real screenshot with real active-
   * window and open-window data.
   */
  async getScreenContext(): Promise<ScreenContext> {
    console.log("🎯 Building screen context...");

    const screenshot = await this.captureScreen();
    const active = await this.getActiveApplication();
    const windows = await this.getOpenWindows();

    const context: ScreenContext = {
      resolution: {
        width: screenshot.width,
        height: screenshot.height,
      },
      activeApplication: active.application,
      activeWindow: active.window,
      openWindows: windows,
      screenshot,
    };

    this.activeContext = context;

    console.log("✅ Screen context ready");
    console.log(`   Resolution: ${context.resolution.width}x${context.resolution.height}`);
    console.log(`   Active: ${context.activeApplication}`);
    console.log(`   Windows: ${context.openWindows.length}`);

    return context;
  }

  /**
   * Monitor screen for changes - real repeated captures at an interval.
   * Honest, disclosed cost: each tick is a real screenshot + real window
   * enumeration (both real shell-outs), not free - callers should pick
   * intervalMs accordingly, not assume this is cheap like a pure state
   * poll.
   */
  async *monitorScreen(intervalMs: number = 1000): AsyncGenerator<ScreenContext> {
    console.log(`👁️  Starting screen monitoring (${intervalMs}ms interval)`);

    while (true) {
      const context = await this.getScreenContext();
      yield context;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /**
   * Detect screen changes between two real captures. Still a real
   * simplification, disclosed: compares real timestamps and real PNG
   * byte-length as a cheap proxy for "did anything change," not a true
   * pixel/region diff (histogram or perceptual hashing) - that's real
   * follow-up work if per-region change detection is ever needed, not
   * done here.
   */
  detectChanges(
    before: Screenshot,
    after: Screenshot
  ): {
    changed: boolean;
    areas: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
  } {
    console.log("🔍 Detecting screen changes...");

    const changed = before.data.length !== after.data.length || !before.data.equals(after.data);

    return {
      changed,
      areas: changed
        ? [{ x: 0, y: 0, width: after.width, height: after.height }]
        : [],
    };
  }

  /**
   * Get last screenshot
   */
  getLastScreenshot(): Screenshot | undefined {
    return this.lastScreenshot;
  }

  /**
   * Get current context
   */
  getCurrentContext(): ScreenContext | undefined {
    return this.activeContext;
  }
}
