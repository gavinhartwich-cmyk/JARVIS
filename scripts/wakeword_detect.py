#!/usr/bin/env python3
"""
Real local wake-word detection using openWakeWord (ONNX runtime, CPU,
no API key, no network calls after models are cached) with its
pretrained "hey jarvis" model.

Usage: wakeword_detect.py <model_name_or_path> <audio_wav_path>
<model_name_or_path> can be one of openWakeWord's bundled pretrained
names (e.g. "hey_jarvis") or an explicit path to a custom .onnx/.tflite
model. Input audio MUST already be 16kHz mono 16-bit PCM WAV — resample
with ffmpeg before calling this (openWakeWord's feature pipeline assumes
16kHz).

Feeds the audio through in 80ms (1280-sample) chunks, matching real
streaming use, and reports the peak score seen across the whole clip.
Prints a single JSON object to stdout:
  {"model": str, "max_score": float, "scores": [float, ...]}

Any failure prints {"error": "..."} to stdout and exits 1 — callers must
check for the "error" key rather than assuming success.
"""
import json
import sys
import wave


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: wakeword_detect.py <model_path> <audio_wav_path>"}))
        return 1

    model_name_or_path = sys.argv[1]
    audio_path = sys.argv[2]

    try:
        import numpy as np
        from openwakeword.model import Model
        from _wakeword_model_setup import ensure_model_downloaded
    except ImportError as e:
        print(json.dumps({"error": f"openwakeword not installed: {e}. Run scripts/setup-voice.sh."}))
        return 1

    # See _wakeword_model_setup.py (2026-08-31: factored out of this file,
    # now shared with wakeword_detect_daemon.py) for the full story on the
    # two real bugs this closes.
    ensure_model_downloaded(model_name_or_path)

    try:
        with wave.open(audio_path, "rb") as wf:
            if wf.getframerate() != 16000 or wf.getnchannels() != 1 or wf.getsampwidth() != 2:
                print(json.dumps({
                    "error": (
                        f"audio must be 16kHz mono 16-bit PCM, got "
                        f"{wf.getframerate()}Hz, {wf.getnchannels()}ch, "
                        f"{wf.getsampwidth() * 8}-bit. Resample with ffmpeg first."
                    ),
                }))
                return 1
            raw = wf.readframes(wf.getnframes())

        audio = np.frombuffer(raw, dtype=np.int16)

        # tflite_runtime (openWakeWord's default inference backend) is built
        # against NumPy 1.x and segfaults/raises under this venv's NumPy 2.x
        # (openwakeword.MODELS maps names to .tflite paths by default - see
        # _wakeword_model_setup.py). Force the ONNX backend instead, which
        # this venv has installed and verified working.
        model = Model(wakeword_models=[model_name_or_path], inference_framework="onnx")
        model_name = list(model.models.keys())[0]

        chunk_size = 1280  # 80ms at 16kHz, openWakeWord's expected frame size
        scores = []
        for i in range(0, len(audio), chunk_size):
            chunk = audio[i : i + chunk_size]
            if len(chunk) < chunk_size:
                break
            prediction = model.predict(chunk)
            scores.append(float(prediction[model_name]))

        result = {
            "model": model_name,
            "max_score": max(scores) if scores else 0.0,
            "scores": scores,
        }
        print(json.dumps(result))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
