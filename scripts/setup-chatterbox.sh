#!/usr/bin/env bash
# Linux counterpart to setup-chatterbox.ps1 - see that file for the full
# real rationale/comments (CUDA index URL sourcing, why a separate venv
# from tools/whisper/venv). Gavin's actual machine is Windows, so this
# script is for parity/documentation and hasn't been run for real - if
# you're on Linux, verify your driver's CUDA version with `nvidia-smi`
# and adjust the --index-url below if it's not cu124
# (https://pytorch.org/get-started/previous-versions/ has the exact URLs
# for torch 2.6.0).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Chatterbox TTS (local voice cloning) venv =="
if [ ! -d tools/chatterbox/venv ]; then
  python3 -m venv tools/chatterbox/venv
else
  echo "  venv already present, reusing"
fi
tools/chatterbox/venv/bin/pip install --quiet --upgrade pip

echo "== Installing CUDA-accelerated PyTorch 2.6.0 (cu124) =="
echo "   No NVIDIA GPU? Swap the --index-url below for https://download.pytorch.org/whl/cpu"
tools/chatterbox/venv/bin/pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124

echo "== Installing chatterbox-tts =="
tools/chatterbox/venv/bin/pip install chatterbox-tts

# [ADDED 2026-09-01] See scripts/patch-chatterbox-numpy2-bug.py and
# https://github.com/resemble-ai/chatterbox/issues/499 - chatterbox-tts
# 0.1.7 crashes every synthesis under numpy>=2.0. Idempotent, safe to
# re-run.
echo "== Patching chatterbox-tts numpy>=2.0 float64 bug (resemble-ai/chatterbox#499) =="
tools/chatterbox/venv/bin/python scripts/patch-chatterbox-numpy2-bug.py

echo "== Verifying GPU is actually visible to PyTorch =="
tools/chatterbox/venv/bin/python -c "import torch; print('CUDA available:', torch.cuda.is_available()); print('Device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU only')"

echo
echo "Chatterbox setup complete. You still need a real ~10 second reference audio"
echo "clip of the voice to clone. Once you have one, set in .env:"
echo "  CHATTERBOX_PYTHON_PATH=tools/chatterbox/venv/bin/python"
echo "  CHATTERBOX_VOICE_CLIP_PATH=<full path to your reference clip>"
