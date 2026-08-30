#!/usr/bin/env python3
"""
Phase 2: Continuous microphone capture.

Captures raw 16-bit PCM audio from the default input device and writes it
to stdout as a continuous byte stream, in fixed-size blocks. Runs until
killed (SIGTERM, or stdin closed) - this is meant to be spawned once by
mic-capture.ts and left running for the life of the `listen` process, not
re-spawned per chunk like wakeword_detect.py/whisper_transcribe.py (those
are cheap, self-contained, one-shot detections on an already-captured
clip; continuous capture needs one persistent OS-level audio stream, not
one open/close cycle per ~1s window).

Usage: mic_capture.py <sample_rate> <channels> <block_ms>
Writes raw little-endian int16 PCM to stdout, <block_ms> milliseconds per
write() call (default 250ms - small enough that the wake-word/VAD logic
on the TypeScript side reacts promptly, large enough not to spend most of
the CPU budget on Python/IPC overhead).
"""
import sys
import numpy as np
import sounddevice as sd

def main():
    sample_rate = int(sys.argv[1]) if len(sys.argv) > 1 else 16000
    channels = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    block_ms = int(sys.argv[3]) if len(sys.argv) > 3 else 250
    blocksize = int(sample_rate * block_ms / 1000)

    stdout = sys.stdout.buffer

    def callback(indata, frames, time_info, status):
        if status:
            # Overflow/underflow etc. - real signal, log it, don't crash
            # the stream over it.
            print(f"[mic_capture] stream status: {status}", file=sys.stderr)
        # indata is float32 in [-1, 1] by default; convert to int16 PCM to
        # match what wake-word-detector.ts/speech-recognizer.ts already
        # expect (they build a WAV header assuming 16-bit PCM).
        pcm16 = (indata[:, 0] * 32767.0).astype(np.int16)
        try:
            stdout.write(pcm16.tobytes())
            stdout.flush()
        except BrokenPipeError:
            raise SystemExit(0)

    with sd.InputStream(
        samplerate=sample_rate,
        channels=channels,
        dtype="float32",
        blocksize=blocksize,
        callback=callback,
    ):
        print(f"[mic_capture] listening at {sample_rate}Hz, {block_ms}ms blocks", file=sys.stderr)
        # Block forever - the callback does all the real work. Killed
        # externally (taskkill/SIGTERM) when the parent process stops.
        while True:
            sd.sleep(1000)

if __name__ == "__main__":
    main()
