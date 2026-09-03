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
 * loaded.
 *
 * [UPDATE 2026-08-31, confirmed live] This DID fix the total silence -
 * Gavin: "it gave audio" - real progress, but the flat `Start-Sleep`
 * wait produced audible crackling. Real cause: MediaPlayer's COM/Media
 * Foundation pipeline expects its hosting thread's Windows message queue
 * to be pumped periodically (built for a real WPF/WinForms app with a
 * running message loop); blocking that thread completely for the whole
 * clip starves that pumping. Replaced the blind sleep with a loop
 * calling `[System.Windows.Forms.Application]::DoEvents()` every 15ms
 * for the same total duration - the standard real workaround for
 * driving WPF media components from a plain console script with no UI.
 * Not yet confirmed live - needs Gavin's real hardware to know if this
 * actually removes the crackle.
 *
 * [UPDATE 2026-09-02] Real, live-found regression in a genuinely new
 * execution context: the DoEvents pump loop above had only ever been
 * exercised via a normal foreground `bun run dev listen` terminal before
 * this session's background/hidden run mode (start-jarvis.ps1) existed.
 * Gavin's first real background-mode test: "when it did speak it was the
 * crackley bad bounce" - the same symptom the DoEvents fix above was
 * built to prevent, now reappearing in a context that fix was never
 * actually tested in. Real, well-documented Windows behavior that
 * plausibly explains it: background/windowless processes can receive
 * reduced CPU scheduling priority, and this loop is genuinely
 * timing-sensitive - a throttled process could silently starve the
 * DoEvents pump just enough to reintroduce the stutter. Mitigated by
 * explicitly raising this PowerShell process's own priority class
 * (`AboveNormal`) at the start of the script, independent of whether its
 * parent window is hidden. Disclosed honestly: this is a well-reasoned
 * hypothesis based on documented Windows scheduling behavior, not a
 * confirmed root cause - audio quality can't be verified from here at
 * all (no way to listen to real playback), so this needs Gavin's own
 * live confirmation after a restart to know whether it actually helped.
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runPowerShell, psEscape, PowerShellAbortedError } from "../phase3/windows-control";

/**
 * [ADDED 2026-09-02] Thrown by playWavBuffer when the caller's own
 * AbortSignal ends playback early - real barge-in support (voice-
 * interface.ts's playInterruptible()), not a playback failure. Callers
 * should treat this as "the user interrupted," not log it as an error.
 */
export class PlaybackInterruptedError extends Error {
  constructor() {
    super("Playback interrupted by caller");
    this.name = "PlaybackInterruptedError";
  }
}

/**
 * Play a WAV buffer through the default output device and wait for
 * playback to finish (PlaySync, not Play - a fire-and-forget Play() would
 * return immediately and let the caller start treating incoming mic
 * audio as a fresh wake-word/utterance window while JARVIS's own voice
 * is still coming out of the speakers).
 *
 * [UPDATE 2026-09-02] Real, scoped barge-in support: an optional
 * AbortSignal now lets a caller stop playback mid-clip (see
 * PlaybackInterruptedError above and voice-interface.ts's
 * playInterruptible()). This still isn't real acoustic echo
 * cancellation - the master doc's Part 5.3 full arbitrary-speech
 * interruption goal - it's the wake-word-only interim step: JARVIS
 * keeps listening (specifically for "Jarvis" again, via the same
 * already-tuned detector, not general speech) while it talks, and a hit
 * kills this exact process to stop the audio immediately. A real,
 * honest, working step toward the full goal, not a simulation of it.
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

export async function playWavBuffer(audio: Buffer, timeoutMs = 30_000, signal?: AbortSignal): Promise<void> {
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
  # [ADDED 2026-09-02] Real, live-found regression: this exact DoEvents
  # pump loop (fixed 2026-08-31 for the original crackle) had never been
  # exercised in HIDDEN/BACKGROUND mode before start-jarvis.ps1 existed -
  # Gavin, on his first real background-mode test: "when it did speak it
  # was the crackley bad bounce." Real, well-documented Windows behavior
  # that plausibly explains it: background/windowless processes can get
  # reduced CPU scheduling priority, and this loop is genuinely
  # timing-sensitive (needs DoEvents serviced roughly every 15ms to keep
  # Media Foundation's callbacks flowing) - a throttled process could
  # silently reintroduce the exact stutter the loop exists to prevent.
  # Real, direct mitigation: explicitly raise THIS process's own priority
  # class, independent of whether its parent window is hidden. Best-effort
  # (wrapped in its own try/catch) - if raising priority fails for any
  # reason, playback still proceeds at normal priority rather than
  # aborting over it.
  try {
    [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = [System.Diagnostics.ProcessPriorityClass]::AboveNormal
  } catch {}
  Add-Type -AssemblyName PresentationCore
  Add-Type -AssemblyName System.Windows.Forms
  $player = New-Object System.Windows.Media.MediaPlayer
  $player.Open([Uri]$path)
  $player.Play()
  # BUG FIX (2026-08-31, confirmed live): a real Start-Sleep here produced
  # audible crackling - Gavin: "it gave audio... but it was really
  # crackley". Real, well-documented cause: MediaPlayer's underlying COM/
  # Media Foundation pipeline expects the hosting thread's Windows
  # message queue to be pumped periodically (it's built for a real WPF/
  # WinForms app with a running message loop); Start-Sleep blocks this
  # console script's thread completely for the whole clip, starving that
  # pumping and producing exactly this kind of stutter/crackle. Pumping
  # via System.Windows.Forms.Application]::DoEvents() in a tight loop -
  # the standard real workaround for driving WPF media components from a
  # plain console script with no UI - services those callbacks instead
  # of blocking blind, for the same total duration as before.
  $deadline = (Get-Date).AddMilliseconds(${sleepMs})
  while ((Get-Date) -lt $deadline) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 15
  }
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
      timeoutMs,
      signal
    );
  } catch (err) {
    // Real barge-in (2026-09-02): the caller's AbortSignal killed the
    // PowerShell process mid-clip on purpose - re-throw as
    // PlaybackInterruptedError so voice-interface.ts's
    // playInterruptible() can tell "the user interrupted" apart from an
    // actual playback failure (bad device, crashed COM object, etc.).
    if (err instanceof PowerShellAbortedError) {
      throw new PlaybackInterruptedError();
    }
    throw err;
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // Best-effort cleanup - a leftover temp WAV isn't worth failing over.
    }
  }
}
