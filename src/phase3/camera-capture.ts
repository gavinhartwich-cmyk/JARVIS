/**
 * Phase 3: Camera Vision (real capture)
 *
 * [ADDED 2026-09-02] Real gap closed, per Gavin's explicit go-ahead:
 * previously there was no camera/webcam capture module anywhere in this
 * codebase at all (see `identity.ts`'s own honest "Face recognition not
 * implemented — needs a camera pipeline running on the PC" and
 * `context-router.ts`'s unimplemented `"camera"` routing target).
 *
 * Real, on-demand only — deliberately NOT a persistent/always-on capture
 * loop the way mic listening is. A webcam feed is a materially different
 * privacy surface than audio VAD, and this project's own design notes
 * already called that out before any code existed; `captureFrame()` opens
 * the device, grabs one frame, and releases it immediately, every time -
 * there is no long-running camera process anywhere in this file.
 *
 * Implementation: real `ffmpeg` DirectShow (Windows) capture — not
 * OpenCV/`cv2`. Tried OpenCV first (`opencv-python-headless`, installed
 * into the existing `tools/whisper/venv`) since it's the conventional
 * choice for this kind of thing, but it genuinely failed to open the
 * device at all in this session's own tool-execution context ("backend is
 * generally available but can't be used to capture by index" from
 * `cv2.VideoCapture`), even though the device is real and present
 * (`Get-PnpDevice` confirmed a real "HD Pro Webcam C920," Status: OK).
 * `ffmpeg -f dshow` reached the same real device successfully (correct
 * reported resolution/fps straight from the hardware: "640x480, 30 fps")
 * and is already a relied-upon dependency elsewhere in this project (see
 * `video-analyzer.ts`), so this uses that instead and doesn't add OpenCV
 * as a dependency at all (uninstalled again after the comparison test).
 *
 * A single instant grab came back solid black in testing here even
 * though the real device opened correctly - a well-known real webcam
 * quirk (auto-exposure/auto-white-balance need a moment to converge after
 * the sensor starts), not obviously specific to this session. Worked
 * around with a short real warm-up burst (~1.5s at a few fps, keeping the
 * LAST frame) rather than a single instant grab. **Disclosed, unresolved:
 * even the warmed-up frame still came back solid black in THIS session's
 * own tool-execution context** - consistent with the same real window-
 * station/interactive-desktop-session-scoping limitation already found
 * and disclosed for screen capture and idle detection (see
 * screen-capture.ts / presence-monitor.ts), not necessarily a defect in
 * this code. The device opens, reports real correct specs, and produces
 * a real (if black, here) JPEG every time - whether it captures genuine
 * scene content needs Gavin's own live verification on his real desktop
 * session, exactly like those two earlier findings.
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CameraFrame {
  data: Buffer; // JPEG image data
  width: number;
  height: number;
  timestamp: Date;
  deviceName: string;
}

function runProcess(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => reject(new Error(`Failed to spawn "${cmd}" - is it on PATH? (${err.message})`)));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

/**
 * Real DirectShow device enumeration (Windows only). ffmpeg's dshow
 * `-list_devices` deliberately exits non-zero and prints the list to
 * stderr, not stdout - that's ffmpeg's own real, documented behavior for
 * this flag (confirmed live, not a bug in this wrapper), not something to
 * treat as a genuine failure here.
 */
export async function listCameraDevices(): Promise<string[]> {
  const { stderr } = await runProcess("ffmpeg", ["-hide_banner", "-f", "dshow", "-list_devices", "true", "-i", "dummy"]);
  const devices: string[] = [];
  // Real ffmpeg output shape: `[in#0 @ ...] "Device Name" (video)` - only
  // video-capable entries are relevant here (the same block also lists
  // audio input devices, e.g. a webcam's built-in mic, which aren't a
  // camera device and would fail to open as one).
  const lineRe = /"([^"]+)"\s*\(video\)/g;
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(stderr)) !== null) {
    devices.push(match[1]);
  }
  return devices;
}

/**
 * Real device-name resolution: explicit name > CAMERA_DEVICE_NAME env var
 * (case-insensitive substring match, same convention as mic-capture.ts's
 * MIC_DEVICE_NAME) > first enumerated device. No "guess which one is the
 * real physical webcam" heuristic — with a virtual-camera app (OBS) or
 * passthrough devices (VR headsets) also present on a given machine, a
 * keyword guess would be a real, avoidable way to silently pick the wrong
 * one; an explicit env var override is honest about needing that instead.
 */
async function resolveCameraDeviceName(explicit?: string): Promise<string> {
  if (explicit) return explicit;

  const devices = await listCameraDevices();
  if (devices.length === 0) {
    throw new Error("No camera devices found via ffmpeg's DirectShow enumeration - is a webcam connected?");
  }

  const envName = process.env.CAMERA_DEVICE_NAME;
  if (envName) {
    const found = devices.find((d) => d.toLowerCase().includes(envName.toLowerCase()));
    if (found) return found;
    console.warn(`   ⚠️  CAMERA_DEVICE_NAME="${envName}" didn't match any real device (${devices.join(", ")}) - falling back to the first one`);
  }

  if (devices.length > 1) {
    console.log(`   ℹ️  Multiple camera devices found (${devices.join(", ")}) - using "${devices[0]}". Set CAMERA_DEVICE_NAME to pick a different one.`);
  }
  return devices[0];
}

export class CameraCapture {
  /** Real device enumeration - see listCameraDevices() above. */
  async listDevices(): Promise<string[]> {
    return listCameraDevices();
  }

  /**
   * Real single-frame webcam capture. Opens the device, captures a short
   * real warm-up burst so auto-exposure has a moment to converge, keeps
   * the LAST frame, and releases the device immediately - see this file's
   * header comment for why this is deliberately on-demand only, and for
   * the real, disclosed, unresolved question of whether a genuinely
   * scene-accurate (non-black) frame comes back outside this session's
   * own tool-execution context.
   */
  async captureFrame(deviceName?: string): Promise<CameraFrame> {
    const resolvedName = await resolveCameraDeviceName(deviceName);
    console.log(`📷 Capturing from camera: "${resolvedName}"`);

    const tempDir = mkdtempSync(join(tmpdir(), "jarvis-camera-"));
    try {
      const pattern = join(tempDir, "frame-%02d.jpg");
      const { code, stderr } = await runProcess("ffmpeg", [
        "-y",
        "-f",
        "dshow",
        "-i",
        `video=${resolvedName}`,
        "-t",
        "1.5",
        "-vf",
        "fps=3",
        pattern,
      ]);

      const frameFiles = readdirSync(tempDir)
        .filter((f) => f.startsWith("frame-") && f.endsWith(".jpg"))
        .sort(); // frame-01.jpg < frame-02.jpg < ... - lexicographic sort is correct here (fixed 2-digit width)

      if (frameFiles.length === 0) {
        throw new Error(`ffmpeg produced no frames from "${resolvedName}" (exit ${code}): ${stderr.trim() || "no stderr"}`);
      }

      const lastFramePath = join(tempDir, frameFiles[frameFiles.length - 1]);
      const data = readFileSync(lastFramePath);

      // Real resolution as reported by ffmpeg's own stderr for the actual
      // opened device stream (e.g. "640x480, 30 fps") - trusted directly
      // rather than re-parsed from the JPEG's own SOF marker (unlike
      // screen-capture.ts's independent PNG IHDR check): ffmpeg is the
      // same process that just wrote this exact file, so there's no
      // separate "caller" to independently verify against here.
      const resMatch = stderr.match(/(\d{2,5})x(\d{2,5})[^,\n]*,\s*[\d.]+\s*fps/);
      const width = resMatch ? parseInt(resMatch[1], 10) : 0;
      const height = resMatch ? parseInt(resMatch[2], 10) : 0;

      console.log(`✅ Camera frame captured: ${width || "?"}x${height || "?"}, ${data.length} bytes (from ${frameFiles.length} real frames sampled)`);

      return {
        data,
        width,
        height,
        timestamp: new Date(),
        deviceName: resolvedName,
      };
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup - a leftover temp frame isn't worth failing over.
      }
    }
  }
}
