# Fix list — 2026-09-02 session

Not committed to history as a permanent doc; working checklist for this
pass, referenced from chat. Delete or fold into the master doc once done.

- [x] **1. Chatterbox latency (13-45s/line)** — profile where the time
      actually goes (model params: steps/cfg_weight/exaggeration in
      chatterbox-tts's `generate()`), see if there's a real, disclosed
      speed/quality tradeoff to expose, not just accept it as fixed cost.
- [x] **2. STT-garble → LLM hallucination gap** — fixed via
      jarvis-personality.ts: explicit instruction to ask for
      clarification on genuinely-garbled input instead of inventing
      context. Measured whether a bigger Whisper model would help
      accuracy too - "small" is ~5.4x slower than "base" on the same
      clip (26.9s vs 5.0s), a real cost for an unmeasured accuracy gain -
      left model size unchanged rather than trade away the Chatterbox
      latency win just made. Revisit if the prompt fix alone isn't enough.
- [x] **3. HUD repositioning — make it verifiable** — the logic's built
      but I couldn't force a live OS-focus test myself. Add real
      diagnostic logging to the decision loop (native-hud) so the next
      live test proves it working (or not) from log output, not just
      eyeballing it.
- [ ] **4. Phase 1 Coder-agent timeout on large files** — root cause is
      architectural (reproducing an entire file costs 7000-9000+ tokens),
      already patched twice by raising timeouts/caps. Real fix: a
      targeted edit protocol (anchored find/replace blocks) instead of
      whole-file reproduction, so it doesn't scale with file size.

Rule for this pass: fix and verify what's verifiable without a live mic/
speaker session (typecheck, code-level tests, native build). No
`bun run dev listen` until Gavin says go.
