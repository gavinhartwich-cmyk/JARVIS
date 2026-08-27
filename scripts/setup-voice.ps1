# Windows counterpart to setup-voice.sh — downloads/builds everything
# Phase 2 (voice) needs: Piper TTS binary + voice model, a Python venv with
# faster-whisper for STT, and openWakeWord (+ ONNX runtime) for wake word
# detection. Zero-cost, fully local — no API keys.
#
# Requires: PowerShell 5.1+, Python 3.9+ on PATH as `py`, and ffmpeg on PATH
# (winget install ffmpeg, or download from https://www.gyan.dev/ffmpeg/builds/
# and add its bin folder to PATH).
#
# Run from the JARVIS repo root: .\scripts\setup-voice.ps1

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host "== Piper (TTS) =="
New-Item -ItemType Directory -Force -Path "tools\piper", "models\piper" | Out-Null
if (-not (Test-Path "tools\piper\piper\piper.exe")) {
    Invoke-WebRequest -Uri "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip" -OutFile "$env:TEMP\piper.zip"
    Expand-Archive -Path "$env:TEMP\piper.zip" -DestinationPath "tools\piper" -Force
    Remove-Item "$env:TEMP\piper.zip"
} else {
    Write-Host "  already present, skipping"
}
if (-not (Test-Path "models\piper\en_US-amy-medium.onnx")) {
    Invoke-WebRequest -Uri "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx" -OutFile "models\piper\en_US-amy-medium.onnx"
    Invoke-WebRequest -Uri "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json" -OutFile "models\piper\en_US-amy-medium.onnx.json"
} else {
    Write-Host "  voice model already present, skipping"
}

Write-Host "== faster-whisper (STT) + openWakeWord (wake word) =="
if (-not (Test-Path "tools\whisper\venv")) {
    py -m venv tools\whisper\venv
    & tools\whisper\venv\Scripts\python.exe -m pip install --quiet --upgrade pip
    & tools\whisper\venv\Scripts\pip.exe install --quiet faster-whisper openwakeword onnxruntime
} else {
    Write-Host "  venv already present, skipping"
    & tools\whisper\venv\Scripts\pip.exe install --quiet openwakeword onnxruntime
}

Write-Host "== Verifying =="
"hey jarvis, hello from JARVIS." | tools\piper\piper\piper.exe `
    -m models\piper\en_US-amy-medium.onnx -f "$env:TEMP\jarvis-voice-check.wav" `
    --espeak_data tools\piper\piper\espeak-ng-data -q
& tools\whisper\venv\Scripts\python.exe scripts\whisper_transcribe.py tiny "$env:TEMP\jarvis-voice-check.wav" en
ffmpeg -y -loglevel error -i "$env:TEMP\jarvis-voice-check.wav" -ar 16000 -ac 1 -sample_fmt s16 "$env:TEMP\jarvis-voice-check-16k.wav"
& tools\whisper\venv\Scripts\python.exe scripts\wakeword_detect.py hey_jarvis "$env:TEMP\jarvis-voice-check-16k.wav"
Remove-Item "$env:TEMP\jarvis-voice-check.wav", "$env:TEMP\jarvis-voice-check-16k.wav" -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Voice setup complete. Add these lines to .env so JARVIS finds the Windows binaries"
Write-Host "(the code's built-in defaults are Linux paths):"
Write-Host ""
Write-Host "  PIPER_BINARY_PATH=tools\piper\piper\piper.exe"
Write-Host "  PIPER_ESPEAK_DATA_PATH=tools\piper\piper\espeak-ng-data"
Write-Host "  WHISPER_PYTHON_PATH=tools\whisper\venv\Scripts\python.exe"
Write-Host "  WAKEWORD_PYTHON_PATH=tools\whisper\venv\Scripts\python.exe"
Write-Host ""
Write-Host "Then run: bun test src/tests/speech-synthesizer.test.ts src/tests/speech-recognizer.test.ts src/tests/wake-word-detector.test.ts"
