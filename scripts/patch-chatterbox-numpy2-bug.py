#!/usr/bin/env python3
"""
Re-apply a real, verified fix for a chatterbox-tts bug that breaks TTS
synthesis under numpy>=2.0.

Root cause (confirmed 2026-09-01 against Gavin's actual install, and
matches https://github.com/resemble-ai/chatterbox/issues/499 exactly -
same file, same line): chatterbox/tts_turbo.py's norm_loudness() does
`wav = wav * gain_linear`. `wav` is a float32 numpy array; `gain_linear`
is a Python float (effectively float64). Under numpy's pre-2.0 type
promotion rules that stayed float32; numpy>=2.0 changed the rule so the
whole result silently promotes to float64. That float64 array then gets
fed into a float32 PyTorch model deeper in generate(), crashing with:

  RuntimeError: expected scalar type Double but found Float

Not fixed upstream in chatterbox-tts 0.1.7 (the version this project
installs) as of this writing - a PR (#500) exists but isn't released to
PyPI yet. Patching the installed package directly is the only way to get
a working install today. This patch is IDEMPOTENT (safe to run every
time setup runs, including on a version that's already patched, or a
future chatterbox-tts release that fixes this properly upstream) and
SAFE-BY-DESIGN if `wav`'s dtype ever isn't float32 for some other reason,
since it casts back to whatever dtype `wav` already was rather than
hardcoding float32.

Run with the SAME python/venv that has chatterbox-tts installed - e.g.
`tools/chatterbox/venv/Scripts/python.exe scripts/patch-chatterbox-numpy2-bug.py`
(Windows) - not this project's own bun/node runtime.
"""
import importlib.util
import sys


def main() -> int:
    spec = importlib.util.find_spec("chatterbox.tts_turbo")
    if spec is None or spec.origin is None:
        print("chatterbox.tts_turbo not found - is chatterbox-tts installed in this Python environment?")
        return 1

    path = spec.origin
    content = open(path, encoding="utf-8").read()

    if ").astype(wav.dtype)" in content:
        print(f"Already patched: {path}")
        return 0

    old = (
        "            gain_linear = 10.0 ** (gain_db / 20.0)\n"
        "            if math.isfinite(gain_linear) and gain_linear > 0.0:\n"
        "                wav = wav * gain_linear"
    )
    if old not in content:
        print(
            f"Expected code not found in {path} - chatterbox-tts's internals "
            "have likely changed since this patch was written (0.1.7). Check "
            "https://github.com/resemble-ai/chatterbox/issues/499 for current "
            "status; this patch may no longer be needed, or may need updating."
        )
        return 1

    new = (
        "            gain_linear = 10.0 ** (gain_db / 20.0)\n"
        "            if math.isfinite(gain_linear) and gain_linear > 0.0:\n"
        "               # [PATCHED by JARVIS project's patch-chatterbox-numpy2-bug.py]\n"
        "               # See that script's own docstring for the full story -\n"
        "               # numpy>=2.0 type-promotion bug, resemble-ai/chatterbox#499.\n"
        "               wav = (wav * gain_linear).astype(wav.dtype)"
    )
    content = content.replace(old, new)
    open(path, "w", encoding="utf-8").write(content)
    print(f"Patched: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
