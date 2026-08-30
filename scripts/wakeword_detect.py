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
        import os
        import numpy as np
        import openwakeword
        from openwakeword.model import Model
        from openwakeword.utils import download_models
    except ImportError as e:
        print(json.dumps({"error": f"openwakeword not installed: {e}. Run scripts/setup-voice.sh."}))
        return 1

    # Real bug found 2026-08-30 on Gavin's actual PC (not caught by any
    # earlier sandbox testing): `pip install openwakeword` installs the
    # Python code but NOT the pretrained model binaries (hey_jarvis's
    # .onnx/.tflite, plus the melspectrogram/embedding/VAD models the
    # feature pipeline needs) - those are separate GitHub release assets
    # that openwakeword.utils.download_models() must be called to fetch
    # explicitly. setup-voice.ps1/.sh never did this, so Model() failed
    # with a raw ONNXRuntimeError "File doesn't exist" the first time this
    # ever ran against a real microphone. Fixed in two places: setup-voice
    # now calls download_models() as part of normal setup, AND this
    # defensive check here means an already-installed-but-incomplete venv
    # (or anyone who runs this before re-running setup) self-heals instead
    # of failing the same way again - only actually reaches out to GitHub
    # when a real file is missing (download_models() itself no-ops on
    # files that already exist), so this is a no-op filesystem check most
    # of the time, not a startup network call on every real run.
    if model_name_or_path in openwakeword.MODELS:
        target_directory = os.path.dirname(openwakeword.MODELS[model_name_or_path]["model_path"])
        expected_path = openwakeword.MODELS[model_name_or_path]["model_path"].replace(".tflite", ".onnx")
        if not os.path.exists(expected_path):
            print(f"[wakeword_detect] {model_name_or_path} model not found locally, downloading...", file=sys.stderr)
            download_models([model_name_or_path])
            # download_models() has a real quirk (found 2026-08-30 by
            # actually reproducing this, not just reading its source): it
            # only checks whether the .tflite variant already exists
            # before deciding to fetch BOTH formats - if a previous
            # partial/interrupted setup left the .tflite present but the
            # .onnx missing (this venv is always run with
            # inference_framework="onnx", never tflite - see the note
            # below), that call silently does nothing and this exact
            # failure would recur. Belt-and-suspenders: if the onnx file
            # still isn't there after asking the library to fetch it,
            # download it directly from its own recorded release URL.
            if not os.path.exists(expected_path):
                from openwakeword.utils import download_file
                onnx_url = openwakeword.MODELS[model_name_or_path]["download_url"].replace(".tflite", ".onnx")
                print(f"[wakeword_detect] download_models() didn't produce {expected_path} - fetching {onnx_url} directly", file=sys.stderr)
                download_file(onnx_url, target_directory)

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
        # (see openwakeword.MODELS name resolution above — it maps names to
        # .tflite paths by default). Force the ONNX backend instead, which
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
