"""
Shared model-download self-heal check for openWakeWord, used by both
wakeword_detect.py (one-shot, still used by src/tests/wake-word-detector
.test.ts) and wakeword_detect_daemon.py (persistent, used by the real
`bun run dev listen` mic pipeline - see wake-word-detector.ts). Factored
out here instead of duplicated (2026-08-31) so the two real bugs this
already fixes stay fixed in exactly one place, not two copies that could
drift apart the next time either needs another fix.

Real bug found 2026-08-30 on Gavin's actual PC: `pip install openwakeword`
installs the Python code but NOT the pretrained model binaries
(hey_jarvis's .onnx/.tflite, plus the melspectrogram/embedding/VAD models
the feature pipeline needs) - those are separate GitHub release assets
that openwakeword.utils.download_models() must be called to fetch
explicitly. setup-voice.ps1/.sh never did this, so Model() failed with a
raw ONNXRuntimeError "File doesn't exist" the first time this ever ran
against a real microphone. Fixed in two places: setup-voice now calls
download_models() as part of normal setup, AND this defensive check here
means an already-installed-but-incomplete venv (or anyone who runs this
before re-running setup) self-heals instead of failing the same way
again - only actually reaches out to GitHub when a real file is missing
(download_models() itself no-ops on files that already exist), so this is
a no-op filesystem check most of the time, not a startup network call on
every real run.

Second real bug found the same day, while verifying the first fix by
actually reproducing it: openwakeword.utils.download_models() only checks
whether the .tflite variant already exists before deciding to fetch BOTH
formats - if a previous partial/interrupted setup left the .tflite
present but the .onnx missing (this venv always runs with
inference_framework="onnx", never tflite), that call silently does
nothing and this exact failure would recur. Belt-and-suspenders: if the
onnx file still isn't there after asking the library to fetch it,
download it directly from its own recorded release URL.
"""
import os
import sys


def ensure_model_downloaded(model_name_or_path: str) -> None:
    import openwakeword
    from openwakeword.utils import download_models

    if model_name_or_path not in openwakeword.MODELS:
        return  # an explicit custom model path, not a bundled pretrained name - nothing to download

    target_directory = os.path.dirname(openwakeword.MODELS[model_name_or_path]["model_path"])
    expected_path = openwakeword.MODELS[model_name_or_path]["model_path"].replace(".tflite", ".onnx")
    if os.path.exists(expected_path):
        return

    print(f"[wakeword] {model_name_or_path} model not found locally, downloading...", file=sys.stderr)
    download_models([model_name_or_path])
    if not os.path.exists(expected_path):
        from openwakeword.utils import download_file
        onnx_url = openwakeword.MODELS[model_name_or_path]["download_url"].replace(".tflite", ".onnx")
        print(f"[wakeword] download_models() didn't produce {expected_path} - fetching {onnx_url} directly", file=sys.stderr)
        download_file(onnx_url, target_directory)
