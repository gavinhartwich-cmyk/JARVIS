/**
 * Phase 2: Audio Playback
 *
 * Real gap found 2026-08-30 while wiring up the `listen` command: every
 * existing TTS path (speech-synthesizer.ts's synthesize(), the
 * `voice-reply` CLI command) produces a real synthesized WAV buffer and
 * then just writes it to a temp file - nothing anywhere in this codebase
 * ever actually plays audio out loud. Closes that gap the same way
 * windows-control.ts already does for input automation: shell out to a
 * PowerShell one-liner rather than pull in a native Node audio-output
 * dependency that would need compiling against Bun's ABI.
 *
 * [UPDATE 2026-08-31] `Media.SoundPlayer` (the original approach - kept
 * below as the last-resort fallback) is a stock, dependency-free .NET
 * class, but it plays through Windows' legacy MME/waveOut audio path,
 * which has a known real quirk: it can target a different "default
 * device" than the one the rest of Windows (and every other app) treats
 * as default, especially on a machine with more than one playback
 * device. Confirmed live with Gavin: `PlaySync()` on a real Windows
 * system sound (notify.wav) via a plain manual PowerShell command -
 * completely outside JARVIS's own code - produced NO audible sound at
 * all, while his speakers work fine for everything else. That isolates
 * the problem to this exact API, not JARVIS's code, not his hardware,
 * and not general Windows muting. Primary path is now the Windows Media
 * Player ActiveX/COM object (`WMPlayer.OCX`) instead - it uses the
 * modern media pipeline and follows the actual current default output
 * device, the same one every normal app uses. It ships with Windows
 * Media Player, present on effectively every standard Windows 10/11
 * install (not a new download) - but on the off chance it's missing
 * (e.g. an N/KN edition without the media feature pack), this falls
 * back to the original SoundPlayer path rather than throwing. Not yet
 * confirmed live - needs Gavin's real hardware to know if this actually
 * fixes the silence or if the true cause is upstream of the audio API
 * entirely (e.g. this process's audio session being isolated some other
 * way).
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runPowerShell, psEscape } from "../phase3/windows-control";

/**
 * Play a WAV buffer through the default output device and wait for
 * playback to finish (PlaySync, not Play - a fire-and-forget Play() would
 * return immediately and let the caller (e.g. the `listen` loop) start
 * treating incoming mic audio as a fresh wake-word/utterance window while
 * JARVIS's own voice is still coming out of the speakers - exactly the
 * self-triggering/echo problem the master architecture doc's own STT
 * pipeline spec calls out as needing "echo cancellation" (Part 5.3). This
 * isn't real acoustic echo cancellation, but blocking here is what lets
 * voice-interface.ts's listen loop simply not re-arm the mic until
 * PlaySync's promise resolves - a real, honest interim fix, not a
 * simulation of one.
 */
export async function playWavBuffer(audio: Buffer, timeoutMs = 30_000): Promise<void> {
  const path = join(tmpdir(), `jarvis-playback-${randomUUID()}.wav`);
  writeFileSync(path, audio);
  try {
    await runPowerShell(
      `
$path = "${psEscape(path)}"
$wmp = $null
try {
  $wmp = New-Object -ComObject WMPlayer.OCX.7
} catch {
  try { $wmp = New-Object -ComObject WMPlayer.OCX } catch { $wmp = $null }
}
if ($wmp) {
  # WMPPlayState values that mean "still doing something before/while
  # playing": 10=Ready, 6=Buffering, 9=Transitioning, 7=Waiting,
  # 3=Playing. Looping while any of these hold blocks until real
  # playback actually finishes (state moves to 8=MediaEnded or
  # 1=Stopped), the same "wait for it to really be done" contract
  # SoundPlayer's PlaySync() gave us.
  $wmp.settings.autoStart = $false
  $wmp.URL = $path
  $wmp.controls.play()
  Start-Sleep -Milliseconds 150
  $activeStates = 3,6,7,9,10
  while ($activeStates -contains $wmp.playState) {
    Start-Sleep -Milliseconds 100
  }
  $wmp.controls.stop()
  $wmp.close()
} else {
  (New-Object Media.SoundPlayer $path).PlaySync()
}
`,
      timeoutMs
    );
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // Best-effort cleanup - a leftover temp WAV isn't worth failing over.
    }
  }
}
