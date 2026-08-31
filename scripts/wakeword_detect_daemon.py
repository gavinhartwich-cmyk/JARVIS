#!/usr/bin/env python3
"""
Persistent wake-word detection daemon.

Real fix (2026-08-31), directly measured: wakeword_detect.py's one-shot
design (fresh subprocess per detection cycle) works, but pays real,
measured overhead on EVERY cycle - `python3 -c "import numpy, openwakeword"`
plus openwakeword.model.Model() construction cost ~1.1-1.5s in this
project's own venv, on top of wake-word-detector.ts's ~1s buffer-fill
wait before it even runs. That's 2+ real seconds between Gavin actually
saying "jarvis" and detection completing - measured as the direct cause
of "very delayed from the wakeword to the listening mode" once he tried
speaking a full sentence ("jarvis, open notepad") in one breath.

This script loads the model exactly ONCE at startup, then stays alive
for the life of the `listen` session, reading raw int16 mono 16kHz PCM
continuously from stdin and scoring it in real 80ms/1280-sample chunks
(openWakeWord's native frame size) as they arrive - eliminating the
per-cycle reload entirely and cutting the buffering window from ~1s down
to ~80ms. Prints one JSON line per chunk to stdout, flushed immediately:
  {"score": float}
so the parent process (wake-word-detector.ts) can react to each chunk
as it's scored, not once per full buffer. The first line printed is
  {"ready": true, "model": str}
once model loading completes - the parent waits for this before feeding
any audio, so the one real unavoidable cost (model load) only ever
blocks session startup, not every single detection.

Usage: wakeword_detect_daemon.py <model_name_or_path>
Exits cleanly on stdin EOF (parent closed the pipe, e.g. process.kill()
closing stdio, or explicit stdin.end()).
"""
import sys
import json


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: wakeword_detect_daemon.py <model_name_or_path>"}))
        return 1

    model_name_or_path = sys.argv[1]

    try:
        import numpy as np
        from openwakeword.model import Model
        from _wakeword_model_setup import ensure_model_downloaded
    except ImportError as e:
        print(json.dumps({"error": f"openwakeword not installed: {e}. Run scripts/setup-voice.sh."}))
        return 1

    try:
        ensure_model_downloaded(model_name_or_path)
        # Same ONNX-backend reasoning as wakeword_detect.py - see its own
        # comment (tflite_runtime is built against NumPy 1.x, segfaults
        # under this venv's NumPy 2.x).
        model = Model(wakeword_models=[model_name_or_path], inference_framework="onnx")
        real_model_name = list(model.models.keys())[0]
    except Exception as e:
        print(json.dumps({"error": f"failed to load model: {e}"}))
        return 1

    print(json.dumps({"ready": True, "model": real_model_name}), flush=True)

    CHUNK_SAMPLES = 1280  # 80ms at 16kHz, openWakeWord's expected frame size
    CHUNK_BYTES = CHUNK_SAMPLES * 2  # 16-bit samples
    buf = b""
    stdin = sys.stdin.buffer

    while True:
        data = stdin.read(4096)
        if not data:
            break  # EOF - parent closed stdin, shut down cleanly
        buf += data
        while len(buf) >= CHUNK_BYTES:
            chunk_bytes = buf[:CHUNK_BYTES]
            buf = buf[CHUNK_BYTES:]
            try:
                chunk = np.frombuffer(chunk_bytes, dtype=np.int16)
                prediction = model.predict(chunk)
                score = float(prediction[real_model_name])
                print(json.dumps({"score": score}), flush=True)
            except Exception as e:
                # A single bad chunk shouldn't kill a long-running daemon -
                # report it and keep going, unlike the one-shot script
                # where a failure just ends that one detection cycle
                # anyway.
                print(json.dumps({"error": str(e)}), flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
