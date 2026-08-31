#!/usr/bin/env python3
"""
Persistent Chatterbox TTS daemon - loads the model exactly once (a real,
possibly multi-second GPU model load) and then serves one text->WAV
synthesis request at a time over stdin/stdout as newline-delimited JSON -
the same persistent-process pattern wakeword_detect_daemon.py already
uses for openWakeWord, and for the same reason: a fresh subprocess per
request would pay the full model-load cost on every single JARVIS
response, which was already a real, confirmed bug once this session (see
wake-word-detector.ts's history) and isn't worth repeating here.

Usage: chatterbox_synthesize_daemon.py <reference_audio_path> [device]
  device: cuda (default), cpu, or mps

Protocol (stdin -> stdout, both newline-delimited JSON):
  startup:  stdout emits {"ready": true, "sample_rate": <int>}
  request:  stdin line  {"text": "...", "out_path": "C:\\...\\tmp.wav"}
  response: stdout line {"done": true, "out_path": "...", "duration_ms": <float>}
            or          {"error": "..."} (daemon keeps running after a
            per-request error - matches wakeword_detect_daemon.py's
            per-chunk resilience, one bad request shouldn't kill the
            whole warm session)
"""
import sys
import json
import time


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: chatterbox_synthesize_daemon.py <reference_audio_path> [device]"}))
        return 1

    reference_audio_path = sys.argv[1]
    device = sys.argv[2] if len(sys.argv) > 2 else "cuda"

    try:
        import torchaudio as ta
        # Turbo model (English, 350M params) - chosen over the base
        # ChatterboxTTS model specifically for lower per-response latency
        # in a live voice assistant, per Resemble AI's own README
        # positioning it as the faster variant. Real, disclosed tradeoff:
        # not yet A/B tested against the base model's voice-clone quality
        # on Gavin's real reference clip - if Turbo's cloned voice isn't
        # convincing enough once he has a clip to test with, switching
        # this one import (chatterbox.tts_turbo -> chatterbox.tts,
        # ChatterboxTurboTTS -> ChatterboxTTS) is the whole change needed.
        from chatterbox.tts_turbo import ChatterboxTurboTTS
    except ImportError as e:
        print(json.dumps({"error": f"chatterbox-tts not installed: {e}. Run scripts/setup-chatterbox.ps1."}))
        return 1

    try:
        model = ChatterboxTurboTTS.from_pretrained(device=device)
    except Exception as e:
        print(json.dumps({"error": f"failed to load Chatterbox model (device={device}): {e}"}))
        return 1

    print(json.dumps({"ready": True, "sample_rate": model.sr}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            text = request["text"]
            out_path = request["out_path"]
        except Exception as e:
            print(json.dumps({"error": f"bad request JSON: {e}"}), flush=True)
            continue

        try:
            start = time.time()
            wav = model.generate(text, audio_prompt_path=reference_audio_path)
            ta.save(out_path, wav, model.sr)
            duration_ms = (time.time() - start) * 1000
            print(json.dumps({"done": True, "out_path": out_path, "duration_ms": duration_ms}), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
