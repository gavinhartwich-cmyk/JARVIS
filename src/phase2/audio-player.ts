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
 * `Media.SoundPlayer` is a stock .NET Framework class (System.Windows.Forms
 * assembly not even required for it), present on every Windows install by
 * default - no new dependency to install.
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
      `(New-Object Media.SoundPlayer "${psEscape(path)}").PlaySync()`,
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
