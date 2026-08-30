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

Usage: mic_capture.py <sample_rate> <channels> <block_ms> [device_substring] [gain]

gain (2026-08-30, per Gavin's real live data: wake-word scores while he
talked at normal volume through the C920 topped out at 0.0175 - roughly
15-50x below where an actual "jarvis" utterance should score per the
2026-08-26 measurements in JARVIS-MASTER-ARCHITECTURE-UPDATED.md
(0.25-0.99) - which points at the raw input level being too quiet for
openWakeWord's model to recognize confidently, not just a threshold
that needs nudging. Applies a fixed linear multiplier to the captured
float32 samples before the int16 conversion, so every downstream
consumer (wake-word-detector.ts AND the RMS-based VAD in
voice-interface.ts) benefits, not just the wake-word threshold. Hard-
clips to [-1, 1] first to avoid wraparound distortion on loud peaks.
Defaults to 4.0 (a real starting hypothesis, not a measured-correct
value - the [mic] peak-level log line below is there specifically so
this can be recalibrated from Gavin's real numbers instead of guessed
again).

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
import time
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
    gain = float(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] else 4.0
    blocksize = int(sample_rate * block_ms / 1000)

    device_index = resolve_input_device(device_substring) if device_substring else None
    if device_index is None:
        print("[mic_capture] no device name given - using the OS default input device", file=sys.stderr)

    stdout = sys.stdout.buffer

    # Throttled peak-level diagnostic (~1x/sec, not per-block) - this is
    # the real number needed to tell "gain is set right" apart from
    # "mic is still too quiet even after gain" apart from "gain is now
    # clipping" without guessing. raw_peak is the untouched mic level
    # (0-1 float, what sd.InputStream actually captured); post_gain_peak
    # is what wake-word-detector.ts/the VAD actually receive.
    diag_state = {"last_log": 0.0, "raw_peak": 0.0, "post_peak": 0.0}

    def callback(indata, frames, time_info, status):
        if status:
            # Overflow/underflow etc. - real signal, log it, don't crash
            # the stream over it.
            print(f"[mic_capture] stream status: {status}", file=sys.stderr)
        raw = indata[:, 0]
        boosted = np.clip(raw * gain, -1.0, 1.0)
        # indata is float32 in [-1, 1] by default; convert to int16 PCM to
        # match what wake-word-detector.ts/speech-recognizer.ts already
        # expect (they build a WAV header assuming 16-bit PCM).
        pcm16 = (boosted * 32767.0).astype(np.int16)
        try:
            stdout.write(pcm16.tobytes())
            stdout.flush()
        except BrokenPipeError:
            raise SystemExit(0)

        raw_peak = float(np.max(np.abs(raw))) if raw.size else 0.0
        post_peak = float(np.max(np.abs(boosted))) if boosted.size else 0.0
        diag_state["raw_peak"] = max(diag_state["raw_peak"], raw_peak)
        diag_state["post_peak"] = max(diag_state["post_peak"], post_peak)
        wall_now = time.monotonic()
        if wall_now - diag_state["last_log"] >= 1.0:
            clipped = " (CLIPPING - gain too high)" if diag_state["post_peak"] >= 0.999 else ""
            print(
                f"[mic_capture] peak level (last 1s): raw={diag_state['raw_peak']:.4f} "
                f"gain={gain:.1f}x -> post-gain={diag_state['post_peak']:.4f}{clipped}",
                file=sys.stderr,
            )
            diag_state["last_log"] = wall_now
            diag_state["raw_peak"] = 0.0
            diag_state["post_peak"] = 0.0

    with sd.InputStream(
        device=device_index,
        samplerate=sample_rate,
        channels=channels,
        dtype="float32",
        blocksize=blocksize,
        callback=callback,
    ):
        print(f"[mic_capture] listening at {sample_rate}Hz, {block_ms}ms blocks, gain={gain:.1f}x", file=sys.stderr)
        # Block forever - the callback does all the real work. Killed
        # externally (taskkill/SIGTERM) when the parent process stops.
        while True:
            sd.sleep(1000)

if __name__ == "__main__":
    main()
