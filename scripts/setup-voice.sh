#!/usr/bin/env bash
# Downloads/builds everything Phase 2 (voice) needs: Piper TTS binary +
# voice model, and a Python venv with faster-whisper for STT.
# Zero-cost, fully local — no API keys.
#
# Linux only as written (piper_linux_x86_64 release + apt). On Gavin's
# Windows PC, swap the Piper download for piper_windows_amd64.zip from the
# same GitHub release and use `py -m venv` / `.\venv\Scripts\python.exe`
# instead of the python3/bin paths below.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Piper (TTS) =="
mkdir -p tools/piper models/piper
if [ ! -f tools/piper/piper/piper ]; then
  curl -sL -o /tmp/piper.tar.gz \
    https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
  tar -xzf /tmp/piper.tar.gz -C tools/piper
  rm /tmp/piper.tar.gz
else
  echo "  already present, skipping"
fi
if [ ! -f models/piper/en_US-amy-medium.onnx ]; then
  curl -sL -o models/piper/en_US-amy-medium.onnx \
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx"
  curl -sL -o models/piper/en_US-amy-medium.onnx.json \
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json"
else
  echo "  voice model already present, skipping"
fi

echo "== faster-whisper (STT) =="
if [ ! -d tools/whisper/venv ]; then
  python3 -m venv tools/whisper/venv
  tools/whisper/venv/bin/pip install --quiet --upgrade pip
  tools/whisper/venv/bin/pip install --quiet faster-whisper
else
  echo "  venv already present, skipping"
fi

echo "== Verifying =="
echo "Hello from JARVIS." | tools/piper/piper/piper \
  -m models/piper/en_US-amy-medium.onnx -f /tmp/jarvis-voice-check.wav \
  --espeak_data tools/piper/piper/espeak-ng-data -q
tools/whisper/venv/bin/python scripts/whisper_transcribe.py tiny /tmp/jarvis-voice-check.wav en
rm -f /tmp/jarvis-voice-check.wav

echo
echo "Voice setup complete. Run 'bun test src/tests/speech-synthesizer.test.ts src/tests/speech-recognizer.test.ts' to confirm."
