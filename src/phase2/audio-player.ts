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
 * [UPDATE 2026-08-31] `Media.SoundPlayer` (the original approach - still
 * kept below as the very last resort) plays through Windows' legacy
 * MME/waveOut audio path, which has a known real quirk: it can target a
 * different "default device" than the one the rest of Windows treats as
 * default. Confirmed live with Gavin: `PlaySync()` on a real Windows
 * system sound (notify.wav), completely outside JARVIS's own code,
 * produced NO audible sound at all, while his speakers work fine for
 * everything else - isolating the problem to this exact API.
 *
 * [UPDATE 2026-08-31, second pass] First fix attempt (Windows Media
 * Player's `WMPlayer.OCX` ActiveX/COM object, polling `playState`)
 * confirmed live to be WORSE, not better - it hung until the outer
 * timeout killed the process ("Filler playback failed: PowerShell exited
 * null" - a real, confirmed timeout/kill, not a clean failure). Real,
 * disclosed reasoning for why: `WMPlayer.OCX` is a *windowed* ActiveX
 * control built to be hosted inside a real UI window with a Windows
 * message loop pumping it - a bare `powershell.exe -Command` console
 * process has neither, and a first-use-ever COM instantiation of it can
 * also silently pop a hidden modal "first run" setup dialog nobody can
 * see or dismiss. Replaced with `System.Windows.Media.MediaPlayer`
 * (WPF/PresentationCore) instead - it plays through the same modern
 * Media Foundation pipeline (so it should still follow the real current
 * default output device, unlike SoundPlayer), but is NOT a windowed
 * ActiveX control - actual audio decoding/rendering happens on Media
 * Foundation's own threads regardless of whether anything pumps this
 * process's message queue, which is exactly what a windowless console
 * host needs. Its `Open()`/`Play()` are asynchronous with no built-in
 * blocking call, so - rather than depend on events that may never fire
 * without a pumped Dispatcher - this computes the real WAV duration from
 * the buffer itself (this file's own `wavDurationMs`, not a shared
 * import - same "no cross-file dependency" convention
 * fish-audio-synthesizer.ts already established) and blocks with
 * `Start-Sleep` for that long, the same standard, commonly-used
 * workaround for scripting WPF MediaPlayer from a plain console host.
 * Falls back to the legacy `SoundPlayer` (known-bad device selection,
 * but at least doesn't hang) only if `PresentationCore` itself can't be
 * loaded. Not yet confirmed live - needs Gavin's real hardware.
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
/**
 * Real duration from a WAV header (same header-walk approach used in
 * speech-synthesizer.ts and fish-audio-synthesizer.ts, duplicated here
 * rather than imported - each of those files deliberately has zero
 * cross-dependency on the others). Falls back to a conservative 4000ms
 * guess for anything that doesn't parse as a standard WAV, so a bad
 * header degrades to "probably long enough" rather than 0ms (which would
 * cut playback off immediately).
 */
function wavDurationMs(wav: Buffer): number {
  try {
    if (wav.length < 44) return 4000;
    const byteRate = wav.readUInt32LE(28);
    let offset = 12;
    while (offset + 8 <= wav.length) {
      const chunkId = wav.toString("ascii", offset, offset + 4);
      const chunkSize = wav.readUInt32LE(offset + 4);
      if (chunkId === "data") {
        return byteRate > 0 ? (chunkSize / byteRate) * 1000 : 4000;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
  } catch {
    // fall through to the conservative guess below
  }
  return 4000;
}

export async function playWavBuffer(audio: Buffer, timeoutMs = 30_000): Promise<void> {
  const path = join(tmpdir(), `jarvis-playback-${randomUUID()}.wav`);
  writeFileSync(path, audio);
  // +600ms real safety margin on top of the exact WAV duration - covers
  // MediaPlayer.Open()'s own real (if usually small) async decode/startup
  // latency before playback truly begins, so Sleep doesn't cut the tail
  // of the clip off.
  const sleepMs = Math.ceil(wavDurationMs(audio)) + 600;
  try {
    await runPowerShell(
      `
$path = "${psEscape(path)}"
$played = $false
try {
  Add-Type -AssemblyName PresentationCore
  $player = New-Object System.Windows.Media.MediaPlayer
  $player.Open([Uri]$path)
  $player.Play()
  Start-Sleep -Milliseconds ${sleepMs}
  $player.Stop()
  $player.Close()
  $played = $true
} catch {
  Write-Error "MediaPlayer playback failed, falling back to SoundPlayer: $_"
}
if (-not $played) {
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
