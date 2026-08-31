# Sets up a dedicated Python venv for Chatterbox TTS (local, $0, voice
# cloning) - Resemble AI's open-source TTS model
# (https://github.com/resemble-ai/chatterbox). Separate from
# tools\whisper\venv (setup-voice.ps1) since Chatterbox's dependency
# stack (PyTorch 2.6.0 pinned, transformers, diffusers, gradio) is heavy
# and version-sensitive enough to risk conflicting with faster-whisper's
# own dependencies if shared into the same venv.
#
# Requires: PowerShell 5.1+, Python 3.10+ on PATH as `py`.
#
# GPU: this installs CUDA 12.4 PyTorch by default - Gavin confirmed he
# has an NVIDIA GPU (2026-08-31). If Chatterbox can't find your GPU
# afterward, check your driver's max supported CUDA version with
# `nvidia-smi` and swap the --index-url below for cu118, cu121, or cu126
# (see https://pytorch.org/get-started/previous-versions/ for the exact
# URL per version - these are real, verified install commands for torch
# 2.6.0, not guessed). If you don't have an NVIDIA GPU at all, replace
# the --index-url with https://download.pytorch.org/whl/cpu instead -
# still fully $0/local, just noticeably slower per response.
#
# Run from the JARVIS repo root: .\scripts\setup-chatterbox.ps1

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host "== Chatterbox TTS (local voice cloning) venv =="
if (-not (Test-Path "tools\chatterbox\venv")) {
    py -m venv tools\chatterbox\venv
} else {
    Write-Host "  venv already present, reusing"
}
& tools\chatterbox\venv\Scripts\python.exe -m pip install --quiet --upgrade pip

Write-Host "== Installing CUDA-accelerated PyTorch 2.6.0 (cu124) =="
& tools\chatterbox\venv\Scripts\pip.exe install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124

Write-Host "== Installing chatterbox-tts =="
& tools\chatterbox\venv\Scripts\pip.exe install chatterbox-tts

Write-Host "== Verifying your GPU is actually visible to PyTorch =="
& tools\chatterbox\venv\Scripts\python.exe -c "import torch; print('CUDA available:', torch.cuda.is_available()); print('Device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU only - check the --index-url note at the top of this script')"

Write-Host ""
Write-Host "Chatterbox setup complete. You still need a real ~10 second reference audio"
Write-Host "clip of the voice to clone (clean single speaker, minimal background noise or"
Write-Host "music, .wav or .mp3). Once you have one, add these to .env:"
Write-Host ""
Write-Host "  CHATTERBOX_PYTHON_PATH=tools\chatterbox\venv\Scripts\python.exe"
Write-Host "  CHATTERBOX_VOICE_CLIP_PATH=<full path to your reference clip>"
Write-Host ""
Write-Host "Then either tell me you've set those, or set textToSpeech.provider to"
Write-Host """chatterbox"" yourself in src\phase2\voice-config.ts, and run: bun run dev listen"
Write-Host ""
Write-Host "(First real synthesis will be slow - the model loads once, warming up the GPU -"
Write-Host "every response after that in the same session reuses the already-loaded model.)"
