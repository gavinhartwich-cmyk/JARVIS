#!/usr/bin/env python3
"""
Phase 2: Continuous microphone capture.

Captures raw 16-bit PCM audio and writes it to stdout as a continuous
byte stream, in fixed-size blocks. Runs until killed (SIGTERM, or stdin
closed) - this is meant to be spawned once by mic-capture.ts and left
running for the life of the `listen` process, not re-spawned per chunk
like wakeword_detect.py/whisper_transcribe.py (those are cheap,
self-contained, one-shot detections on an already-captured clip;
continuous capture needs one persistent OS-level audio stream, not one
open/close cycle per ~1s window).

Usage: mic_capture.py <sample_rate> <channels> <block_ms> [device_substring]

device_substring (2026-08-30, per Gavin: "I didn't expect the wake word
to work when you don't know what mic I want - I want it to be from the
HD Pro Webcam C920"): without it, sounddevice.InputStream opens whatever
the OS currently considers the default input device - on a machine with
more than one microphone connected (built-in laptop mic, a webcam mic,
etc.) that's a guess, not a choice, and it can silently change if Windows
picks a new default after a driver update or a device is unplugged. When
given, this does a case-insensitive substring match against
sd.query_devices() and FAILS LOUDLY if nothing matches (listing every
real input device it actually found) rather than quietly falling back to
the default - a wrong-but-working mic is worse than an obvious startup
error, because it would look like a wake-word/VAD tuning problem instead
of "capturing the wrong microphone entirely."
"""
import sys
import numpy as np
import sounddevice as sd

def resolve_input_device(substring: str):
    devices = sd.query_devices()
    input_devices = [(i, d) for i, d in enumerate(devices) if d["max_input_channels"] > 0]
    matches = [(i, d) for i, d in input_devices if substring.lower() in d["name"].lower()]
    if not matches:
        available = "\n".join(f"  [{i}] {d['name']}" for i, d in input_devices)
        raise SystemExit(
            f"[mic_capture] No input device matched \"{substring}\". Real input devices found:\n{available}\n"
            f"Set MIC_DEVICE_NAME to a substring of the exact name shown above."
        )
    if len(matches) > 1:
        print(
            f"[mic_capture] \"{substring}\" matched {len(matches)} input devices, using the first: "
            f"[{matches[0][0]}] {matches[0][1]['name']}",
            file=sys.stderr,
        )
    index, info = matches[0]
    print(f"[mic_capture] using input device [{index}] {info['name']}", file=sys.stderr)
    return index

def main():
    sample_rate = int(sys.argv[1]) if len(sys.argv) > 1 else 16000
    channels = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    block_ms = int(sys.argv[3]) if len(sys.argv) > 3 else 250
    device_substring = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
    blocksize = int(sample_rate * block_ms / 1000)

    device_index = resolve_input_device(device_substring) if device_substring else None
    if device_index is None:
        print("[mic_capture] no device name given - using the OS default input device", file=sys.stderr)

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
        device=device_index,
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
