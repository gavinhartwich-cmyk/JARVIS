#!/usr/bin/env python3
"""
Persistent faster-whisper STT daemon - loads the model exactly once and
then serves one audio-file->transcript request at a time over
stdin/stdout as newline-delimited JSON. Same reasoning and same protocol
shape as chatterbox_synthesize_daemon.py (see that file's own header):
the previous whisper_transcribe.py spawned a brand-new Python process
and reloaded the model FROM SCRATCH on every single turn.

[ADDED 2026-09-03] Real, measured finding from a live-testing session
where Gavin reported JARVIS being "SUPER slow": model load alone
(WhisperModel(...) construction) measured ~1.18s on this machine, paid
again on every single utterance, on top of ~3.3s of actual transcription
- a real, avoidable ~25% of total STT time on every turn, every time,
for no benefit (the model, device, and compute_type never change
mid-session). This mirrors the exact daemon pattern that already fixed
Chatterbox's own biggest live latency bug the same way.

Usage: whisper_transcribe_daemon.py <model_size> [language]
  language: BCP-47-ish code (e.g. "en"), or omitted/"auto" for
  per-request auto-detect (matches whisper_transcribe.py's own
  behavior - language is passed per-request, not fixed at startup,
  since "auto" is a real, currently-used mode).

Protocol (stdin -> stdout, both newline-delimited JSON):
  startup:  stdout emits {"ready": true}
  request:  stdin line  {"audio_path": "C:\\...\\tmp.wav", "language": "en"}
            ("language" may be null/omitted for auto-detect)
  response: stdout line {"text": str, "language": str, "duration": float,
                          "segments": [...]}
            or          {"error": "..."} (daemon keeps running after a
            per-request error, same resilience contract as
            chatterbox_synthesize_daemon.py and wakeword_detect_daemon.py)
"""
import sys
import json


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: whisper_transcribe_daemon.py <model_size> [language]"}))
        return 1

    model_size = sys.argv[1]
    default_language = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "auto" else None

    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        print(json.dumps({"error": f"faster-whisper not installed: {e}. Run scripts/setup-voice.sh."}))
        return 1

    try:
        # device/compute_type deliberately match whisper_transcribe.py's
        # existing production config (cpu, int8) - NOT switched to cuda
        # here. A real cuda run was measured live during this same
        # investigation (~30% faster transcription: 2.30s vs 3.34s on a
        # real clip) but needs two new pip dependencies
        # (nvidia-cublas-cu12, nvidia-cudnn-cu12) not otherwise part of
        # this project, plus real DLL-search-path wiring, for a real but
        # modest win - a separate, disclosed decision, not bundled into
        # this daemon fix.
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
    except Exception as e:
        print(json.dumps({"error": f"failed to load Whisper model ({model_size}): {e}"}))
        return 1

    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            audio_path = request["audio_path"]
            language = request.get("language") or default_language
        except Exception as e:
            print(json.dumps({"error": f"bad request JSON: {e}"}), flush=True)
            continue

        try:
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

            print(json.dumps({
                "text": " ".join(full_text_parts).strip(),
                "language": info.language,
                "duration": info.duration,
                "segments": segment_list,
            }), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
