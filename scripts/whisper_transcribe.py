#!/usr/bin/env python3
"""
Real local speech-to-text using faster-whisper (CTranslate2, CPU-friendly,
no API key, no network calls after the model is cached).

Usage: whisper_transcribe.py <model_size> <audio_path> [language]
Prints a single JSON object to stdout:
  {"text": str, "language": str, "duration": float, "segments": [...]}

Any failure prints {"error": "..."} to stdout and exits 1 — callers must
check for the "error" key rather than assuming success.
"""
import json
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: whisper_transcribe.py <model_size> <audio_path> [language]"}))
        return 1

    model_size = sys.argv[1]
    audio_path = sys.argv[2]
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "auto" else None

    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        print(json.dumps({"error": f"faster-whisper not installed: {e}. Run scripts/setup-voice.sh."}))
        return 1

    try:
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments, info = model.transcribe(audio_path, language=language, beam_size=5)
        segment_list = []
        full_text_parts = []
        for seg in segments:
            segment_list.append({
                "start": seg.start,
                "end": seg.end,
                "text": seg.text.strip(),
                "avg_logprob": seg.avg_logprob,
            })
            full_text_parts.append(seg.text.strip())

        result = {
            "text": " ".join(full_text_parts).strip(),
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
            "segments": segment_list,
        }
        print(json.dumps(result))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
