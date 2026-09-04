# JARVIS — Comprehensive Master Architecture

**Updated:** September 4, 2026  
**Status:** Phase 0 verified real. Everything else below was previously marked "complete" without ever being executed — corrected here after actually reading the source, not the prior status reports.  
**Core Principle:** One persistent intelligence with multiple interfaces, devices, memories, and capabilities

**Adaptive Processing update (2026-09-04):** see `ARCHITECTURE-UPDATE-ADAPTIVE-PROCESSING.md` for the full directive (Intent/Complexity Router, realtime voice layer, streaming, barge-in, action journal/undo, capability registry, etc.) and its 9-step implementation order. Being implemented in that order, one step at a time, with each verified step folded into the ground-truth status below as it lands — see the "Adaptive Processing" entries.

**Ground-truth status (verified by reading code — last updated 2026-09-04):**
- ✅ **Phase 0** — real. 5-agent orchestrator, memory, verification, audit trail. Originally proven end-to-end against live Postgres + Claude-via-Zo, before the standalone pivot; the code path that made that possible (`models/claude-provider.ts`, all `ZO_API_KEY`/`ClaudeProvider` wiring) has since been deleted outright. The system now runs on Gemini only — needs one fresh live run with a real `GEMINI_API_KEY` to reconfirm the vertical slice end-to-end on the new sole provider (not yet done in this pass; blocked on a live key).
- ✅ **Phase 1.5 (Conversational Intelligence)** — real. Actually imported and called from `orchestrator.ts` (`processWithStreaming`, `completeTurn`, memory methods), not just sitting unused.
- ✅ **Part 3 Foundational Subsystems** — real, built 2026-08-26. Presence & Device Awareness (`core/presence.ts`), Identity Recognition (`core/identity.ts`), Authorization Engine (`core/authorization.ts`, 4 levels), and Security Layer are wired into actual tool execution (`tools/manager.ts`, `phase3/screen-control.ts`) — not documentation, actually enforced: `bun run dev whoami` exercises the full chain. Computer Control (`phase3/windows-control.ts`) is real PowerShell/Win32 automation, but **unverified** — written and typechecked on a Linux sandbox that cannot run it; must be confirmed with `bun run dev control-test` on the actual Windows PC before it's trusted.
- ✅ **Sole LLM provider (Gemini)** — real (`models/gemini-provider.ts`), direct REST call to Google's API, zero Zo/Claude/Anthropic dependency anywhere in the codebase (confirmed by a full-source grep). Also unverified against a live key — needs `GEMINI_API_KEY` and a real run to confirm the model name/response shape still match Google's API.
- ❌ **Phase 1 (JARVIS Developer)** — NOT real. `developer.ts`'s 10-agent pipeline has zero calls to any LLM provider; it's console.log simulation. `bun run dev phase1` doesn't even invoke it — prints a static status message and exits.
- ⚠️ **Phase 2 (Voice) — TTS/STT/wake word real, mic capture still not.** As of 2026-08-26: `speech-synthesizer.ts` runs the real Piper binary (local, $0, no API key), `speech-recognizer.ts` runs real `faster-whisper` via `scripts/whisper_transcribe.py`, and `wake-word-detector.ts` runs the real pretrained openWakeWord `hey_jarvis` model via `scripts/wakeword_detect.py`, tuned (sensitivity 0.15, per Gavin's request) to fire on bare "Jarvis" anywhere in speech, not just the literal "hey Jarvis" phrase the model was trained on — all proven live: a full TTS→STT round trip correctly transcribed "the quick brown fox..." back from synthesized audio, and the wake word model scored ~0.999 on "hey jarvis...", 0.25-0.99 on bare "jarvis" depending on sentence position/cadence, and ~0.0001-0.0003 on unrelated speech (`bun test src/tests/speech-synthesizer.test.ts src/tests/speech-recognizer.test.ts src/tests/wake-word-detector.test.ts`). Known limitation: one measured mid-sentence case with no pause after "jarvis" scored only 0.003 and would still be missed — closing that gap fully would need a dedicated custom-trained "jarvis" model, not just this threshold tune. Run `scripts/setup-voice.sh` first (downloads Piper + builds the whisper/openWakeWord venv; gitignored, not committed). `voice-interface.ts`'s `generateResponse()` — previously a hardcoded "I received your command..." stub, meaning "natural conversation" was 0% real even with TTS/STT/wake-word all wired — now calls the real Gemini→Ollama→OpenRouter gateway; verified live that two different questions get two different real answers (`src/tests/voice-interface.test.ts`). A new `bun run dev voice-reply "<text>"` CLI command reaches it (text-in/audio-out, no mic yet — the first command that reaches any of Phase 2). Also found+fixed a real bug along the way: `speech-synthesizer.ts` silently ignored `voiceId` and always used `en_US-amy-medium` regardless of config; it now actually selects the model. Streaming in all classes is honestly labeled non-incremental (whole ~1s buffer, not true low-latency streaming) — fine for proving the models work, but a persistent-subprocess rework is the next step once real-time mic latency matters. Still NOT real: interruption (state machine exists in `conversation-engine.ts` but isn't wired to `voice-interface.ts` or real audio), full-duplex audio, and — the actual hardware blocker underneath all three — there is no microphone capture anywhere in this codebase, which needs real hardware I/O and has to happen on Gavin's PC, not this Linux sandbox.
- ⚠️ **Phase 3 (Vision/Screen)** — screen control is now real (see above); `GeminiVisionProvider` still throws "not yet implemented" on every method — vision itself (not control) remains unbuilt. No CLI command reaches vision or the rest of Perception.
- ❌ **Phase 5 (Visual HUD)** — doesn't exist. No `desktop/` folder. Never got past a chat message.
- ✅ **Standalone / provider-agnostic / $0-first** — true now, not aspirational. Every Claude/Zo/Anthropic reference (`claude-provider.ts`, `ZO_API_KEY`, `ClaudeVisionProvider`, hardcoded `"claude"` entries in `model-router.ts`) has been removed from the codebase. Both real cloud (Gemini, `GEMINI_API_KEY`) and real local (Ollama, no API key at all) providers exist now, unified behind `LLMGateway` (`src/models/llm-gateway.ts`), which tries Gemini first and automatically falls back to Ollama on failure/quota exhaustion — a Gemini 429 no longer kills the pipeline. OpenRouter is a third, optional provider if `OPENROUTER_API_KEY` is set. None of this touches Zo in any form. Verified 2026-08-26 with `llm-gateway.test.ts` (fake-provider fallback/health/cooldown logic) and a live `bun run dev test` run that reached the gateway and failed with the correct "no provider configured" message when no key/Ollama was present in the CI sandbox — the wiring itself is proven, the LLM calls' actual content still needs a live key to exercise end-to-end.
- ✅ **OmniRoute as primary provider (2026-08-27)** — per Gavin's request to stop depending on any single provider's daily quota. New `models/omniroute-provider.ts` (identical wire format to `openrouter-provider.ts` — OpenAI-compatible chat/completions) talks to a self-hosted OmniRoute gateway (https://github.com/diegosouzapw/OmniRoute, MIT, runs locally via `npm install -g omniroute` on Gavin's PC) which itself aggregates 300+ upstream providers, 90+ free, with its own quota-aware auto-fallback — so a single upstream running dry is now absorbed by OmniRoute before it ever reaches JARVIS as an error. `createDefaultGateway()` order is now: OmniRoute (if `OMNIROUTE_API_KEY` set) → Ollama (local, zero-cost floor, always registered) → Gemini (now optional, only if `GEMINI_API_KEY` set) → OpenRouter (optional). Typecheck clean, `llm-gateway.test.ts` (fake-provider logic, unaffected by the reordering) still 7/7 pass. Not yet verified live against a real running OmniRoute instance — that needs Gavin's PC, where OmniRoute actually runs.
- ✅ **Persistent, verified episode cache (2026-09-04)** — `core/episode-cache.ts`. A cache hit on a stable, non-action question skips the reply-generation LLM call entirely; anything action-shaped or time/context-dependent is never cached, and a hit requires real token-similarity plus a strict LLM-judged "still true" check before being served. Persists to the `memories` table (survives restarts), unlike the old in-process `ConversationalIntelligence.checkMemoryCache` it replaces (session-only, matched by a 10-character prefix). Wired into `VoiceInterface.generateResponse` — the actual live reply path. `src/tests/episode-cache.test.ts`, 11/11 pass (DB-free: stability/action gate, token-similarity discrimination, graceful no-DB degradation — DB-backed hit/miss behavior itself is not yet exercised live, no Postgres in this sandbox).
- ⚠️ **Adaptive Processing Step 1 — Measure (2026-09-04, telemetry landed; live numbers still pending)** — `core/telemetry.ts` (`RequestTracer`/`telemetry`) added and wired into both live paths: `VoiceInterface.respondToText`/`generateResponse` (input received → cache check → provider call → TTS → total) and `Orchestrator.orchestrate` (decomposition → per-agent → per-tool-call → synthesis → total). Real bug found and fixed while wiring this in: `agentRuns.startedAt`/`durationMs` were columns that existed in `schema.ts` but nothing ever populated them — per-agent latency was invisible in the DB even though the table was built for it; both are now set from measured spans. `src/tests/telemetry.test.ts`, 5/5 pass (tracer mechanics only — mark ordering/deltas, bounded history, safe no-op on an unknown trace id).
  **Important correction to the Adaptive Processing directive's stated premise:** section 1 assumes simple conversational requests are slow because they're routed through the multi-agent pipeline (Researcher/Reasoner/Critic/Verifier/Auditor). Reading the actual wiring shows that's not what happens today — `VoiceInterface.generateResponse` (the code behind `bun run dev voice-reply`, the only live conversational entry point) already makes one direct `modelProvider.complete()` call and never touches `Orchestrator.orchestrate()` at all; the 5-agent pipeline is only reachable via the `test` CLI command's fixed demo task. So if simple requests are in fact taking minutes, multi-agent orchestration isn't why. The most plausible concrete cause found by reading the code: `OllamaProvider.complete()` — the local, $0 fallback every path shares — forces *every* call, including a 200-token voice reply, through the structured `{content, confidence}` JSON schema built for agent outputs, and retries once with up to 6000 tokens on truncation; that retry alone doubles a generation pass, and a small local model (`qwen2.5-coder:1.5b`) constrained to that schema on modest hardware (the target GTX 1650 Super, or CPU) is a realistic multi-minute story with zero orchestration involved. **Not yet confirmed against real numbers** — no Postgres/Ollama/Gemini reachable in this sandbox — needs one real `bun run dev voice-reply "..."` run on Gavin's PC with `core/telemetry.ts`'s stage breakdown read off the console. The FAST/TOOL/REASONING/DEEP router (Step 2) is still worth building regardless — `orchestrate()` remaining a manual/test-only path today is itself the gap it's meant to close — but it should not be built on the assumption that it's what's currently causing multi-minute replies.
- ✅ **Adaptive Processing Step 2 — Intent/Complexity Router (2026-09-04)** — `core/intent-router.ts`'s `classifyIntent()` is pattern-based (no LLM call to route) and wired into `VoiceInterface.generateResponse` as the first thing it does:
  - **TOOL** — "open/launch/start/close/quit/exit `<app>`" resolves to a structured `{name: "open_app"|"close_app", target}` action and goes straight to a new `VoiceInterface.executeKnownAction()`, which calls `ScreenControl.openApp`/the new `ScreenControl.closeApp` directly — **zero model calls**, per section 8. Verified by test (`voice-interface-routing.test.ts`): a `ModelProvider` whose `complete()` throws is injected, and an "Open Notepad" turn still completes with 0 calls to it.
  - **DEEP** — multi-step/thorough-analysis requests (research/report/step-by-step/sequential clauses/long requests) are handed to an optional `DeepHandler` callback instead of the direct model call. `bun run dev voice-reply` now wires this to the real `Orchestrator.orchestrate()` — the first time the 5-agent pipeline is reachable from a conversational entry point at all, not just the `test` command's fixed demo task. With no handler configured (e.g. a bare `new VoiceInterface()`), it falls back to a direct model call rather than erroring. Also verified by test, both branches.
  - **REASONING** — comparison/judgment requests ("pros and cons", "X vs Y", "should I...") get the same single model call as FAST but with a system prompt asking for real trade-off weighing and a larger token budget (400 vs 200). Honestly scoped down: no retrieval/tool augmentation exists yet for it to reach for, so today this is "FAST with a different prompt," not a distinct pipeline — noted in the module's own header comment as a placeholder pending real tool integration.
  - **FAST** — everything else; unchanged behavior from before the router (one direct `modelProvider.complete()` call).
  Found and fixed one real bug while adding a test for this: `VoiceInterface.respondToText` never wrapped `speechSynthesizer.synthesize()` in try/catch, so a broken/missing Piper binary (true in this sandbox — no `scripts/setup-voice.sh` run) crashed the entire turn instead of degrading to a text-only reply the way the `voice-reply` CLI command's "TTS disabled" case already did; now caught and logged the same way. `src/tests/intent-router.test.ts` (10/10, classification only) and `src/tests/voice-interface-routing.test.ts` (4/4, proves routing actually changes behavior — model-call counts, not just classifier output) both pass; full suite 44 pass / 18 skip, typecheck clean.
- ✅ **Adaptive Processing Step 3 — Deterministic tools (2026-09-04, satisfied by Step 2 + one finding recorded, nothing further to remove)** — section 8's concrete example ("open Spotify" → `open_application("Spotify")`, executed directly, no translation LLM call) was the gap Step 2 closed: before it, `VoiceInterface` had *no* tool execution path at all — "open Spotify" would get a conversational LLM reply describing opening Spotify, without ever touching a tool. A repo-wide audit for the anti-pattern section 8 warns against (an extra LLM call that "translates" an action already known) found none elsewhere — the few `translate`/`interpret` hits in the codebase (`windows-control.ts`, `authorization.ts`) are deterministic code, not model calls.
  **Real finding, left unfixed (out of scope for "remove unnecessary calls" — this is a missing capability, not an excess call):** `Orchestrator.orchestrate()`'s "Execute any tool calls the agent requested" block (`if (output.toolCalls && output.toolCalls.length > 0)`) is dead code. `BaseAgent.execute()` (`agents/agent.ts`) never sets `AgentOutput.toolCalls` — it only ever returns `{content, reasoning, confidence, tokensUsed}` — so no agent in the DEEP path has ever actually called a tool through `toolManager`, despite the plumbing existing end-to-end (authorization check, audit log, `agentRuns` storage). Giving agents real tool-calling (structured output → validated `toolCalls`) is a real feature, not a cleanup, and fits more naturally under Step 8 (capability registry) or its own task than under "Step 3."
- ⚠️ **Adaptive Processing Step 4 — Gemini Live prototype (2026-09-04, built and typechecked; NOT verified against a live connection)** — new, deliberately isolated `src/prototypes/gemini-live/` (own directory, only reaches into the rest of the codebase for the one real tool it wires up — nothing here is imported by `VoiceInterface` or `Orchestrator`, matching the doc's "build and compare, don't integrate yet" instruction for this step):
  - `protocol.ts` — wire message types (`setup`, `realtimeInput`, `serverContent`/`interrupted`, `toolCall`/`toolResponse`, `sessionResumption`/`sessionResumptionUpdate`) transcribed from Google's current Live API docs (fetched live 2026-09-04 — https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket and https://ai.google.dev/api/live — not recalled from training data, given how young and fast-moving this API is), plus pure, unit-tested helpers for base64 PCM encode/decode.
  - `gemini-live-session.ts` — `GeminiLiveSession`: connects over the documented WebSocket endpoint (raw `WebSocket`, no SDK, same convention as `gemini-provider.ts`), sends text/audio turns, emits `audio`/`text`/`interrupted`/`session-handle` events, and on `interrupted` (the model's own signal that the user's speech cut it off) is wired to fire before anything else in that server message — the barge-in requirement (section 5) maps directly onto reacting to that flag.
  - `live-tools.ts` — registers `open_app` as a real Gemini function-calling tool, backed by the *same* `ScreenControl`/`identityEngine` executor the intent router's TOOL path already uses (no duplicate logic) — satisfies "exercise one JARVIS tool" with a real capability, not a demo stub.
  - `cli-harness.ts` + `bun run dev live-prototype "<text>" [--resume <handle>]` — text-in manual test harness (no mic yet, same limitation as `voice-reply`), the one place in this module allowed to touch `core/telemetry` since measuring it is step 5's whole point.
  - `src/tests/gemini-live-protocol.test.ts` (4/4) and `src/tests/gemini-live-session.test.ts` (3/3) cover what's verifiable without a live connection: message encode/decode round-trips, and connect()/send() failing clearly instead of hanging when unconfigured. Full suite 51 pass / 18 skip, typecheck clean.
  **What this prototype has NOT proven, honestly:** it has never connected to Google's Live API — no `GEMINI_API_KEY` and no confirmed live network path to `generativelanguage.googleapis.com`'s WebSocket endpoint from this sandbox. Microphone streaming and speaker playback aren't exercised at all (no audio hardware here, same pre-existing gap as Phase 2's STT/TTS); interruption is wired but untested (needs a real overlapping second input to trigger it); session resumption is implemented per the docs but never actually round-tripped through a real reconnect. All of that needs step 5's real run on Gavin's PC with a real key and a microphone — this step delivered a structurally-sound, typechecked, unit-tested skeleton to run that comparison against, not a proven realtime pipeline.
- ⚠️ **Adaptive Processing Step 5 — Comparison harness (2026-09-04, built; produces NO real numbers in this sandbox)** — `src/prototypes/gemini-live/compare-latency.ts` + `bun run dev compare-latency ["<text>"]`: runs the same prompt(s) against both `VoiceInterface.respondToText` (current JARVIS) and `GeminiLiveSession` (the step 4 prototype) N times each, using the *same* `core/telemetry.ts` traces for both so the numbers are comparable, plus `process.cpuUsage()`/`process.memoryUsage()` deltas around each call for a rough CPU/RAM read and a real success/failure count for reliability. `summarize()` is pure and unit-tested (`src/tests/compare-latency.test.ts`, 3/3 — success-rate math, and that a failed run doesn't corrupt the average of successful ones) independent of any live call.
  **Deliberately not run for real here, and this is not being reported as a completed comparison:** every prompt against both paths in this sandbox resolves to "unreachable" (no Postgres for the current-JARVIS path's memory/episode-cache calls, no Ollama/Gemini/OmniRoute key for its model call, no `GEMINI_API_KEY` for the Live path) — fabricating "current JARVIS: Xms, Gemini Live: Yms" numbers here would be exactly the confidently-wrong result this project's verification-first principle exists to prevent. `bun run dev compare-latency` is ready to produce the real comparison on Gavin's PC once step 4's prototype has a live key to talk to; step 6 (integrate) stays conditional on that real run, not this harness existing.
- ⏸️ **Adaptive Processing Step 6 — Integrate realtime layer: BLOCKED on step 5's real numbers, correctly not started.** The directive is explicit: "If Gemini Live materially improves latency, integrate... while preserving the existing intelligence core." There is no "if" answered yet — step 5 produced a harness, not a result, in this sandbox. Integrating now would mean either guessing the answer or integrating unconditionally, both of which the directive itself rules out. This step starts only after a real `bun run dev compare-latency` run on Gavin's PC (real `GEMINI_API_KEY`, Postgres, and at least one of Ollama/Gemini/OmniRoute reachable) shows Gemini Live materially winning on the metrics step 5 measures.
- ✅ **Adaptive Processing Step 7 — Action Journal + Universal Undo (2026-09-04)** — new `action_journal` table (`db/schema.ts` — needs `bun run db:push` against a real database before use, not yet applied anywhere live) and `core/action-journal.ts`. Every action executed through `ToolManager.executeTool` (all 5 registered tools) and through the TOOL router path's `executeKnownAction` (open/close app) is journaled: tool, parameters, success, result, risk tier, and — where one exists — a real inverse:
  - **open_app / close_app** (`inverseOfScreenControlAction`) — swapping the verb, always defined.
  - **write_file / delete_file** (`inverseOfFileAction`) — `ToolManager.executeTool` now snapshots the file's content *before* running either tool (best-effort `fs.readFile`, tolerating "didn't exist"), so the inverse is "restore exactly what was there before" (or delete, if nothing was) — not a guess.
  - Everything else (`read_file`, `list_files`, `bash`) is still journaled (every executed action, section 10) but honestly marked `reversible: false` — no general inverse exists for an arbitrary shell command.
  `undoLastActions(count, identity, taskId?)` re-executes the most recent reversible, not-yet-undone actions' inverses through whichever system originally ran them, marks the originals undone, and journals the undo itself (`undoOfActionId`) — implemented at the execution layer (`core/`), not the conversational layer, per section 11. Wired to `bun run dev undo [count]`. **Not yet wired to a spoken "undo that"** in the intent router — this step built the mechanism `core/action-journal.ts` exposes and proved it's callable; teaching the router to recognize "undo"/"undo that" as its own TOOL-shaped path is a small, natural follow-up, not done here.
  `src/tests/action-journal.test.ts` (9/9): inverse computation for both cases, `recordAction` degrading to `null` instead of throwing without a database (matches `memory.ts`/`audit.ts` convention), `undoLastActions` failing clearly instead of hanging without one. Worth noting: `core/action-journal.ts` and `tools/manager.ts` import each other (the journal needs `toolManager` to re-run inverses; the manager needs the journal to record actions) — confirmed this doesn't break at runtime (both singletons initialize fine, full suite passes), since both usages are inside function bodies invoked after module evaluation, not at module load time. Full suite 63 pass / 18 skip, typecheck clean.
- ✅ **Adaptive Processing Step 8 — Capability Registry (2026-09-04)** — new `core/capability-registry.ts`: `JARVIS → Capability Registry → Tools/Plugins/MCP → Executors`, per section 14. Before this, "what can JARVIS do" was split across `ToolManager` (the 5 registered file/bash tools) and a hardcoded `if (action.name === "open_app") ... else ...` inside `VoiceInterface.executeKnownAction` that called `ScreenControl` directly and duplicated the action-journal call `ToolManager` already made for its own tools — adding a new screen-control-backed capability meant hand-editing that voice-interface branch, exactly what section 14 says shouldn't be necessary. `capabilityRegistry.list()` now enumerates all 7 capabilities (5 tool_manager + open_app/close_app) uniformly; `capabilityRegistry.execute(name, params, identity, taskId?)` runs any of them through whichever executor actually backs it, with authorization and action-journal recording happening exactly once (delegated to `ToolManager` for its tools, done directly — matching what Step 7 already put in `VoiceInterface` — for screen-control ones). `VoiceInterface.executeKnownAction` now calls this registry instead of `ScreenControl` directly and no longer imports `ScreenControl`, `recordAction`, or `inverseOfScreenControlAction` at all — concretely shorter, and proof the registry actually decouples the caller from the executor, not just an abstraction on paper.
  Deliberately not an MCP client/server itself: section 14 explicitly says MCP is a candidate *interface* for capabilities where appropriate, not the intelligence layer. A future MCP bridge would register its tools into `list()`/`execute()` the same way `open_app`/`close_app` were added here — as another executor behind this registry — not replace it.
  `src/tests/capability-registry.test.ts` (5/5): `list()` includes both backing systems and reflects `ToolManager`'s real `requiresApproval` flags (not a hardcoded guess); `execute()` on an unknown name fails cleanly via `ToolManager`'s own "not found" handling rather than throwing; `open_app` without a `target` fails before ever reaching `ScreenControl`. Full suite 68 pass / 18 skip, typecheck clean.

---

## Core Philosophy

JARVIS is **not** tied to one LLM, one device, or one interface.

JARVIS is a persistent personal intelligence whose underlying components can evolve while its identity, memory, conversation, and permissions remain stable.

**The architecture flows:**
```
JARVIS Intelligence
    ↓
Conversation / Memory / Planning / Autonomy
    ↓
Tools / Devices / Services
    ↓
PC / Phone / Wearables / Future Interfaces
```

The LLM is one component. The system is much larger.

---

## Part 1: Foundation & Non-Negotiable Principles

### 1.1 Local-First

JARVIS runs on Gavin's Windows PC as a local application.

It is not a web app. It is not hosted externally. It belongs to the hardware.

### 1.2 Zero-Cost

JARVIS must work without:
- Paid APIs
- Subscription services
- Paid cloud hosting
- Required third-party services

Every capability must have a free or local path.

### 1.3 Provider-Agnostic

No LLM becomes "JARVIS."

Gemini, Ollama/local models, or future models are **providers** that JARVIS can use through a standardized interface — never Claude or Zo, which this project is intentionally standalone from.

Changing providers must not change JARVIS's behavior, memory, or identity.

### 1.4 Verification-First

Important outputs should be challenged, tested, and verified by independent agents.

JARVIS does not blindly trust itself.

### 1.5 Human-Controlled Autonomy

JARVIS may eventually improve itself, but only through controlled processes with:
- Sandboxing
- Testing
- Verification
- Approval
- Auditability
- Rollback capability

### 1.6 Build the Brain Before the Body

Core reasoning, memory, verification, and tool systems come first.

Voice, phones, AR/VR, and hardware are downstream interfaces.

---

## Part 2: Core Architectural Principles

### 2.1 One Intelligence, Multiple Interfaces

```
                    JARVIS CORE
                       │
        ┌──────────────┼──────────────┐
        │              │              │
    CONVERSATION    INTELLIGENCE    AUTONOMY
    ENGINE          ENGINE           ENGINE
        │              │              │
    MEMORY          PLANNING       RECOVERY
        │              │              │
        └──────────────┼──────────────┘
                       │
                  TOOL SYSTEM
                       │
        ┌──────────────┼──────────────┐
        │              │              │
    COMPUTER       INTERNET       DEVICES
    CONTROL        APIS           HARDWARE
        │              │              │
        ├──────────────┼──────────────┤
        │
    ENVIRONMENT LAYER
    (Presence, Device Awareness, Identity, Authorization, Security)
        │
    INTERFACES
    ┌──────────┬────────────┬─────────────┐
    │          │            │             │
   PC         Phone      Wearables    Future
   │          │            │
   └──────────┼────────────┘
              │
         Shared State
    (Memory, Conversation, Identity)
```

**Critical:** The same JARVIS runs the PC interface, phone interface, and wearable interface.

Conversation started on PC should continue on phone without losing context.

Identity is unified. Memory is shared. Permissions are portable.

### 2.2 JARVIS Identity ≠ Authorization

Recognizing someone as Gavin does NOT automatically grant administrative access.

These are separate systems:

```
Person Detected
    ↓
Identity Engine
    ↓
Identity Confidence
    ↓
Authorization Engine
    ↓
Permission Check
    ↓
Risk Assessment
    ↓
Additional Verification if Needed
    ↓
Tool Execution
    ↓
Audit Log
```

### 2.3 LLM Decision ≠ Permission

The LLM may determine: "The user wants to install software."

The authorization system decides: "Is this person allowed?"

The tool layer decides: "Can this tool execute that action?"

This separation must be enforced architecturally.

### 2.4 JARVIS ≠ One Device

JARVIS is a distributed system where:

- **PC** is the primary computational host
- **Phone** is a mobile interface + sensor platform
- **Wearables** are health sensors
- **Future devices** are additional interfaces

All share the same identity, memory, and conversation state.

---

## Part 3: Foundational Subsystems (Must exist BEFORE Phase 0)

### 3.1 Presence & Device Awareness

JARVIS must know:

**User Presence:**
- Is Gavin at PC?
- Is Gavin on phone?
- Is Gavin away?
- Where is Gavin?

**Device Awareness:**
- Which devices are available?
- Which devices can JARVIS reach?
- What are their capabilities?
- What communication channels exist?

**Active Interface:**
- Which device is currently primary?
- Can Gavin hear/see notifications?
- Which device should receive alerts?

**Communication Routing:**
```
Gavin at PC
    ↓
PC voice + screen available
    ↓
Route all communication to PC

Gavin on phone
    ↓
Phone voice available
    ↓
Route phone-appropriate communication to phone

Gavin away (phone in pocket)
    ↓
Only critical notifications
    ↓
Route to phone notification
```

**Implementation:**
- Device heartbeats (PC sends presence signal)
- Phone location (optional: GPS integration)
- Screen state (PC screen on/locked)
- Activity detection (PC active use)
- Explicit commands ("I'm going out")

### 3.2 Identity Recognition System

JARVIS must identify who is interacting with it.

**Identity Signals:**
- Face recognition (camera)
- Voice recognition (microphone)
- Device identity (logged-in account)
- Behavioral patterns (usage style)
- Session context (login state)

**Confidence Levels:**
```
Unknown Person
    ↓
Identity Engine Analyzes
    ↓
Confidence: 30% → Unknown
Confidence: 70% → Recognized Person (Not Gavin)
Confidence: 95% → Gavin Recognized
```

**CRITICAL:** Confidence score ≠ Permission level.

A 95% identity confidence does NOT automatically grant Level 3 (Verified) authorization.

### 3.3 Authorization Engine

JARVIS has four authorization levels:

**Level 0: Unknown**
- Can: Handle harmless conversation, answer public questions
- Cannot: Access personal data, files, accounts, system settings

**Level 1: Recognized Person**
- Can: Some low-risk personal features (if permission granted)
- Cannot: Access sensitive data without permission

**Level 2: Gavin (Normal Access)**
- Can: Personal assistant tasks (calendar, email, files, projects)
- Cannot: High-risk/admin actions

**Level 3: Verified Gavin (Admin)**
- Can: Anything (software installation, settings, credentials, security changes)
- Requires: Additional verification (PIN, face + voice, device confirmation, explicit approval)

**Permission Check Flow:**
```
Person + Identity Confidence
    ↓
Authorization Engine
    ↓
Base Level (0/1/2/3)
    ↓
Specific Tool Permissions
    ↓
Risk Assessment
    ↓
Action Type (Normal/Admin/Destructive)
    ↓
Is verification needed?
    ├─ NO → Execute
    └─ YES → Request additional auth
```

**High-Risk Actions Requiring Level 3:**
- Installing software
- Changing system permissions
- Accessing credentials
- Modifying security settings
- Large-scale data deletion
- Modifying JARVIS core
- Granting new permissions

### 3.4 Computer Control Abstraction Layer

JARVIS accesses the computer through a controlled tool interface, not direct OS access.

**Application Control**
- Open application by name
- Close application
- Focus window
- Minimize/maximize/restore

**Input Control**
- Type text
- Press keys
- Click mouse
- Scroll
- Drag

**File Operations**
- List directory
- Read file
- Write file
- Delete file
- Move file
- Create directory

**Clipboard**
- Get clipboard
- Set clipboard

**Screenshot**
- Capture screen
- Capture region
- OCR text from screen

**Terminal**
- Execute command (with permission check)
- Get output
- Handle errors

**Window Management**
- List open windows
- Get active window
- Switch window

**System Settings**
- Get settings (always allowed)
- Change settings (requires permission)

All actions pass through authorization before execution.

### 3.5 Security Layer

Core invariants:

1. **LLM output is not automatic permission**
2. **Identity confidence is not authorization level**
3. **Tool availability ≠ Permission to use**
4. **High-risk actions require explicit verification**
5. **All actions are auditable**
6. **Uncontrolled self-modification is prevented**
7. **Permissions are granular, not monolithic**

---

## Part 4: Conversational Intelligence (Phase 1.5)

The most important architectural layer.

JARVIS must feel like a persistent conversational assistant, not a sequence of independent LLM calls.

### 4.1 Conversation State Machine

Explicit, observable conversation state:

```
IDLE
    ↓
User wakes word
    ↓
LISTENING
    ↓
Speech received
    ↓
THINKING
    ↓
Response determined
    ↓
SPEAKING
    ↓
User interrupts (or response ends)
    ↓
INTERRUPTED or IDLE
```

**States:**

- **IDLE:** Not currently conversing
- **LISTENING:** Actively recording speech
- **THINKING:** Processing input, determining response
- **SPEAKING:** Speaking response via TTS
- **INTERRUPTED:** User interrupted, stopping current response
- **EXECUTING:** Running tool/command
- **WAITING_FOR_USER:** Awaiting response (e.g., yes/no)
- **ERROR:** Recoverable error occurred

**State is observable:** Tools can check current state, adjust behavior accordingly.

### 4.2 Working Conversation Memory

Short-term memory for current conversation:

```
Recent Turns (last 10)
├── User utterance
├── Detected intention
├── JARVIS response
├── Actions taken
└── Timestamp

Current Topic
Current Task
Current Subtask

Relevant Entities
├── People mentioned
├── Dates mentioned
├── Locations
└── Projects

Pronoun Referents
├── "that" → (most recent object)
├── "it" → (most recent subject)
├── "he/she" → (most recent person)

Pending Actions
├── Action 1
├── Action 2
└── ...

Recent Decisions
└── (for context)
```

**Lifetime:** Duration of conversation session

**Purpose:** Enable natural follow-ups like:
```
User: "What time is my meeting?"
JARVIS: "2 PM tomorrow."
User: "Move that to Thursday."
← JARVIS knows "that" = the meeting
```

### 4.3 Four-Level Memory Architecture

**Working Memory**
- What is happening right now?
- Current turn, recent context, immediate references
- Expires at end of conversation

**Episodic Memory**
- What happened previously?
- Conversations, events, interactions, past decisions
- Can be queried: "What did we talk about last week?"
- Persists indefinitely (can be pruned)

**Semantic Memory**
- What does JARVIS know about Gavin and his world?
- Preferences, people, projects, locations, facts
- Persists indefinitely
- Used for context

**Procedural Memory**
- How does JARVIS normally do things?
- Workflows, routines, automation patterns
- "When Gavin arrives at office: check calendar, review email"
- Persists indefinitely

**Memory Operations:**
- Retrieve (query by keyword/context)
- Rank (relevance to current task)
- Create (store new memory)
- Update (correct existing memory)
- Consolidate (merge similar memories)
- Expire (remove outdated temporary data)
- Delete (user-requested removal)

### 4.4 Context Assembly

Every reasoning request dynamically assembles context from:

```
Current Utterance
    ↓ (combine with)
Recent Conversation (last 2-3 turns)
    ↓ (add)
Current Task / Topic
    ↓ (add)
Working Memory (entities, decisions)
    ↓ (add)
Relevant Long-Term Memory
    ↓ (add)
Environmental Context (time, location, device)
    ↓ (add)
Tool State (calendar, files, etc.)
    ↓ (add)
Device State (battery, connectivity)
    ↓ (add)
Personality Rules
    ↓
Final Context Assembly
```

**Principle:** Only include relevant information. Do NOT send entire conversation history.

### 4.5 Personality Layer

JARVIS's personality is independent from the underlying LLM.

**Personality Rules:**
- Tone: Professional but warm, helpful, natural
- Formality: Casual (use contractions), not stiff
- Conciseness: Moderate detail, ask if more is needed
- Humor: Appropriate, not forced
- Proactivity: Balanced (suggest, don't override)
- Addressing user: By name, respectful, familiar
- Challenging user: Gentle, evidence-based
- Silence: Only when appropriate (no "umms" or filler)
- Uncertainty: Express clearly without undermining confidence
- Mistakes: Acknowledge, explain, recover

**Applied to every response, regardless of LLM.**

Changing providers does NOT change personality.

### 4.6 Streaming Architecture

Responses stream token-by-token to minimize perceived latency.

```
LLM generates tokens
    ↓
Tokens arrive in stream
    ↓
Response chunked at sentence boundaries
    ↓
Chunks sent to TTS immediately
    ↓
TTS speaks chunk while LLM generates next chunk
    ↓
User hears response while model still thinking
```

**Result:** Perceived latency under 500ms even with full reasoning time.

### 4.7 Interruption Handling

User can interrupt JARVIS mid-sentence.

```
JARVIS: "The weather tomorrow is—"
User: "Actually, what about Friday?"
    ↓
JARVIS detects new speech
    ↓
Cancel current TTS
    ↓
Discard current reasoning
    ↓
Process new utterance
    ↓
Respond to new request

"Friday will be sunny, 72 degrees."
```

No awkwardness. No delay. Natural conversation.

### 4.8 Intelligent Model Routing

Different types of requests use different models.

**Fast Path** (Haiku/small model)
- Greetings ("Hi JARVIS")
- Simple questions ("What time is it?")
- Basic commands ("Turn off lights")
- Acknowledgments ("Got it")
- Short conversational responses

**Main Path** (Opus/medium model)
- Normal conversation
- Moderate reasoning
- Multi-step tasks
- Decision making

**Deep Path** (Opus + extended thinking)
- Complex planning
- Research
- Coding tasks
- Difficult reasoning
- Important decisions

**Deterministic Path** (Small model, temp=0)
- Calendar operations
- File operations
- System commands
- Structured data retrieval

**Selection:** Based on utterance intent, reasoning complexity, user preferences, budget constraints.

---

## Part 5: Voice Interaction Architecture

### 5.1 Full-Duplex Conversation

JARVIS must support simultaneous listening and speaking.

```
LISTEN ←→ THINK ←→ SPEAK
```

Not:

```
LISTEN → THINK → SPEAK → WAIT
```

### 5.2 Wake Word & Attention

**Always-listening mode:**
- Low-power wake word detection (local, no cloud)
- Detects wake word efficiently
- Transitions to full listening on detection

**Push-to-talk fallback:**
- Explicit activation (button press)
- Useful in noisy environments
- Useful when always-listening not available

**Stop-listening:**
- Explicit command ("Stop listening")
- Timeout (30 seconds of inactivity)
- User leaves presence

### 5.3 Speech Recognition

**STT Pipeline:**
```
Audio input
    ↓
Noise suppression
    ↓
Echo cancellation
    ↓
Voice activity detection
    ↓
Speech recognition (local or cloud)
    ↓
Transcript with confidence
```

**Voice Activity Detection (VAD):**
- Detect when user is speaking
- Detect when user stops
- Distinguish:
  - Short pause (wait)
  - Hesitation (wait)
  - Thinking (wait)
  - Sentence break (wait)
  - End of turn (respond)

**Silence Duration Rules:**
- <500ms: Definitely not end-of-turn
- 1000-2000ms: Likely end-of-sentence, prepare to respond
- 3000ms+: Definitely end of turn, respond

### 5.4 TTS Architecture

TTS is an abstraction layer, like LLM providers.

**TTS Provider Interface:**
- Piper (local, free)
- Cloud options (backup)

**TTS Capabilities:**
- Voice selection (male, female, character)
- Speech speed (slow to fast)
- Natural pauses (at punctuation)
- Sentence chunking (for streaming)
- Immediate cancellation
- Urgency levels

**Urgency Levels:**
- Normal: Natural conversational pace
- Quiet: Whispered or soft speech
- Urgent: Faster, more emphatic
- Short: Brief acknowledgment
- Detailed: Slower, more careful

---

## Part 6: Vision & Perception

### 6.1 Screen Awareness

JARVIS understands the PC screen:

**Screen Capture:**
- Full screen screenshot
- Active window capture
- Region capture
- OCR on regions

**Context Routing:**
- What application is active?
- What does the screen show?
- Is this task screen-related?
- Do I need to look at the screen?

**Vision Reasoning:**
- Understand UI elements
- Read text from screen
- Detect changes
- Answer "what's on screen?" questions

### 6.2 Camera Awareness

If camera available, JARVIS can see:

**Object Recognition**
- What objects are in view?
- What people are present?

**Scene Understanding**
- What's the environment?
- Is this office/home/workshop?
- What's happening?

**Gesture Recognition**
- Detect hand gestures
- Hand tracking
- Pointing
- Thumbs up/down

**Questions:**
- "What's that on my desk?"
- "Is anyone in the room?"
- "What am I working on?"

### 6.3 Context Routing

Every request checked:

```
Request arrives
    ↓
Does this need screen context?
    ├─ YES → Capture screen
    └─ NO → Skip
    ↓
Does this need camera context?
    ├─ YES → Capture camera (if available)
    └─ NO → Skip
    ↓
Does this need web research?
    ├─ YES → Search web
    └─ NO → Skip
    ↓
Assemble context
    ↓
Route to appropriate tool/model
```

---

## Part 7: Autonomy & Proactivity Engine

JARVIS should eventually operate continuously, not just react to commands.

### 7.1 Proactive Monitoring

JARVIS continuously monitors for:

**Calendar:**
- Upcoming meetings
- Overdue tasks
- Conflicts
- Travel time

**Email:**
- Important messages
- Required follow-ups
- Overdue responses

**Tasks:**
- Pending actions
- Overdue items
- Progress stalled

**Business:**
- Pipeline metrics
- Stalled deals
- Follow-up opportunities
- Anomalies

**Personal:**
- Health data
- Sleep quality
- Activity levels
- Habit adherence

**Patterns:**
- Unusual activity
- Breaking routine
- Performance changes
- Attention needed

### 7.2 Proactivity Decision Engine

Not all monitoring results warrant notification.

```
Event Detected
    ↓
How relevant? (score: 0-100)
    ├─ <20: Ignore
    ├─ 20-40: Archive for briefing
    ├─ 40-70: Conditional notify
    └─ >70: Notify soon
    ↓
How urgent? (score: 0-100)
    ├─ <20: Can wait
    ├─ 20-50: Notify on next check
    ├─ 50-80: Notify within 1 hour
    └─ >80: Notify immediately
    ↓
Requires permission?
    ├─ YES → Request approval
    └─ NO → Proceed
    ↓
Which device?
    ├─ PC at desk? → Use PC
    ├─ Phone in pocket? → Use phone
    └─ Away? → Phone notification
    ↓
Action
    ├─ Notify
    ├─ Execute silently
    ├─ Queue for briefing
    └─ Ignore
```

### 7.3 Communication Timing

Respect user's current context:

- If in meeting: Queue until after
- If working intensely: Batch non-urgent
- If away: Only critical notifications
- If sleeping: Urgent only
- If with others: Private notifications to phone

### 7.4 Permission-Aware Autonomy

JARVIS can eventually take actions without asking, but only for low-risk work.

**No Permission Needed:**
- Archive old emails
- Update local memory
- Download updates
- Organize files
- Schedule non-conflicting meetings
- Prepare briefings
- Research topics

**Needs Permission:**
- Sending emails
- Scheduling meetings that might conflict
- Installing software
- Changing settings
- Deleting files
- Accessing credentials

**Needs Verification:**
- Large financial decisions
- System changes
- Security settings
- Modifying core JARVIS

---

## Part 8: Tool Architecture

JARVIS uses tools through a standardized interface.

**Tool Interface:**
```
name: string
description: string
inputSchema: JSONSchema
outputSchema: JSONSchema
permissions: string[]
execute: (input) → output
errorHandling: (error) → recovery
audit: (input, output, result) → log
```

**Tool Categories:**

**Computer Control**
- Application management
- File operations
- Input control
- Screenshot
- Terminal
- Window management

**Communications**
- Email (Gmail)
- Calendar (Google Calendar)
- Messages
- Notifications

**External Services**
- Web search
- Weather APIs
- Maps APIs
- News APIs
- Time zones

**Local Services**
- JARVIS memory
- JARVIS settings
- JARVIS logs
- Local files

**Business Tools**
- Hartwich OS (CRM)
- Sales pipeline
- Leads database
- Metrics

**Device Services**
- Phone (future)
- Wearables (future)
- Smart home (future)

---

## Part 9: Recovery & Reliability

Every major subsystem must handle failures gracefully.

### 9.1 Failure Modes

**Timeout**
- Max wait time before error
- Retry logic
- Fallback option

**Retry**
- Exponential backoff
- Max retry count
- Circuit breaker (stop retrying after N failures)

**Cancellation**
- User says "stop"
- Timeout triggers
- Resource limit hit
- Priority interrupt

**Fallback**
- Primary service unavailable?
- Use backup service
- Degrade gracefully

**Graceful Degradation**
```
Cloud LLM unavailable
    ↓
Use local model (slower)
    ↓
Only basic capabilities
    ↓
Limited reasoning depth
    ↓
Continue operating
```

### 9.2 Error States

**Recoverable:**
- Temporary network error → Retry
- Tool timeout → Retry with fallback
- Model rate limit → Wait and retry
- Missing file → Ask user

**Unrecoverable:**
- User cancels → Stop gracefully
- Permission denied → Explain and stop
- Invalid input → Clarify and ask again
- System resource exhausted → Defer task

---

## Part 10: Implementation Phases

### Phase 0: Foundation (Current)

**Status:** ✅ Complete

**Capabilities:**
- Core orchestration ✅
- Multi-agent reasoning ✅
- Verification (6 agent roles) ✅
- PostgreSQL + Drizzle ✅
- Provider abstraction ✅
- Memory system ✅
- Audit trail ✅
- Testing infrastructure ✅

**Success Criteria:** JARVIS can decompose tasks, delegate to agents, verify work, store memories, remain auditable.

### Phase 1: JARVIS Developer

**Status:** ❌ Scaffolded only, not real. Agent roles/pipeline/git tools exist as code but the pipeline never calls an LLM provider — it's simulated. `bun run dev phase1` prints a status message instead of running it. Needs: wire each pipeline step to a real provider call, then wire `phase1` command in cli.ts to actually invoke `JARVISDeveloper`.

**Capabilities (claimed, not proven):**
- Repository understanding (tools exist, unused by pipeline)
- Code modification (not implemented)
- Git integration (tools exist, unused by pipeline)
- Automated testing (not implemented)
- Debugging (not implemented)
- Code review (not implemented)
- Self-improvement loop (not implemented — never executed once)

**Success Criteria:** JARVIS can meaningfully build, test, debug, and improve software. **Not yet met.**

### Phase 1.5: Conversational Intelligence

**Status:** ✅ Real. Imported and actively called from `orchestrator.ts`.

**Capabilities:**
- Conversation state machine ✅
- Working memory ✅
- Streaming support ✅
- Interruption handling ✅
- Personality layer ✅
- Model routing ✅
- Proactive monitoring ✅

**Success Criteria:** Conversation feels natural and continuous. Context carries across turns. Personality is consistent.

**Dependencies:**
- Phase 0 ✅
- Phase 1 ✅
- Presence & Device Awareness (start parallel)
- Authorization Engine (start parallel)

### Phase 2: Natural Voice Interface

**Status:** ⚠️ TTS, STT, wake word, and now real LLM-backed response generation are all real and verified (see 2026-08-26 updates above), reachable via `bun run dev voice-reply "<text>"`. Interruption and full-duplex audio are not built, and neither can be — along with true real-time mic-driven use — without an actual microphone, which needs Gavin's PC, not this Linux sandbox.

**Capabilities:**
- Wake word detection
- Speech recognition
- Natural conversation
- Interruption
- Text-to-speech
- Full-duplex audio
- Streaming TTS

**Success Criteria:** Natural voice conversation. Can interrupt. Responses stream.

**Dependencies:**
- Phase 1.5

### Phase 3: Perception

**Status:** ⚠️ Mixed, and this line was stale as of 2026-08-26 — the "screen-control.ts calls simulateAction()" claim is factually wrong against the current code: `screen-control.ts` shells out to real PowerShell via `windows-control.ts` (open/close/type/key/wait; click/focus/scroll still unexercised), reachable via `bun run dev control-test`. That's real, written-for-real automation code, but it has never been confirmed to actually work by running it on a real Windows machine — this Linux sandbox cannot run PowerShell or drive a real screen, so it's unverified in the same category as Phase 2's microphone gap, not "fake." `GeminiVisionProvider` genuinely does still throw "not yet implemented" on every method — that part of the stale line was accurate.

**Capabilities:**
- Screen awareness
- Vision (if camera available)
- Object recognition
- Visual context routing

**Success Criteria:** JARVIS can see and understand environment.

**Dependencies:**
- Phase 1.5
- Phase 2 (optional, can run parallel)

### Phase 4: Proactive Intelligence

**Status:** Planned

**Capabilities:**
- Event monitoring
- Proactivity engine
- Smart notifications
- Autonomous actions
- Permission-aware autonomy

**Success Criteria:** JARVIS notices important things without being asked.

**Dependencies:**
- Phase 0
- Phase 1
- Phase 1.5

### Phase 5: Digital Ecosystem

**Status:** Planned

**Capabilities:**
- Calendar integration
- Email integration
- File management
- Hartwich OS integration
- Computer control
- Web search
- External APIs

**Success Criteria:** JARVIS operates across digital tools seamlessly.

**Dependencies:**
- Phase 0
- Phase 1-4

### Phase 6: Unified Mobile Interface

**Status:** Planned

**Architecture:**
- Android JARVIS interface
- Shared memory backend (PC is primary, phone syncs)
- Unified conversation
- Device presence awareness
- Communication routing

**Note:** Phone is NOT separate assistant. Same JARVIS runs both PC and phone.

**Success Criteria:** Conversation started on PC continues on phone. Same identity, memory, capabilities.

**Dependencies:**
- Phase 1.5
- Phase 2
- Presence & Device Awareness

### Phase 7-10: Advanced (Long-term)

- Phase 7: Health & Wearables
- Phase 8: Physical Ecosystem
- Phase 9: Spatial Interface
- Phase 10: Controlled Self-Improvement

---

## Part 11: Pre-Phase Work (Start ASAP)

Must be started before Phase 2 but can run parallel with Phase 1.5:

### Presence & Device Awareness

Build infrastructure for:
- Knowing where Gavin is
- Knowing which devices available
- Routing notifications to correct device
- Understanding device capabilities

### Authorization Engine

Build infrastructure for:
- Identifying users
- Assigning permission levels
- Checking permissions before actions
- Recording access attempts

### Computer Control API

Formalize existing implicit tool layer:
- Application control
- File operations
- Input control
- System commands

### Recovery Patterns

Add to existing subsystems:
- Timeouts
- Retries
- Fallbacks
- Graceful degradation

---

## Part 12: Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Runtime | Node.js / Bun | Portable, reliable |
| Language | TypeScript | Type safety, maintainability |
| Database | PostgreSQL | Powerful, local capable |
| ORM | Drizzle | Type-safe, lightweight |
| STT | Whisper / faster-whisper | Local, accurate, free |
| TTS | Piper | Local, natural, free |
| Wake word | openWakeWord | Local, efficient, free |
| LLM (primary) | Gemini (Google, free tier) | Standalone — zero Claude/Zo dependency |
| LLM (local) | Ollama (`qwen2.5-coder:1.5b` default) | $0 fallback path — built and gateway-wired 2026-08-26 |
| Vision | Local model | When needed |
| GUI | Tauri (future) | Native + web for desktop |

---

## Part 13: Non-Negotiable Invariants

**These cannot be violated:**

1. **IDENTITY ≠ AUTHORIZATION**
   - Recognizing someone ≠ granting access

2. **LLM DECISION ≠ PERMISSION**
   - Model deciding what to do ≠ permission to do it

3. **JARVIS ≠ ONE LLM**
   - Must work with any provider

4. **JARVIS ≠ ONE DEVICE**
   - Must work across PC, phone, wearables

5. **MEMORY ≠ CONVERSATION HISTORY**
   - Extract signal, not store noise

6. **TOOL EXECUTION ≠ LLM OUTPUT**
   - Model suggestion → authorization check → execution

7. **SELF-IMPROVEMENT ≠ UNCONTROLLED SELF-MODIFICATION**
   - Only through approved, tested, verified changes

8. **PRESENCE INFLUENCES COMMUNICATION**
   - Don't interrupt someone in meeting

9. **RISK INFLUENCES AUTHORIZATION**
   - High-risk actions need extra verification

10. **URGENCY INFLUENCES NOTIFICATION**
    - Critical alerts override quiet hours

11. **PERSONALITY IS MODEL-INDEPENDENT**
    - Changing LLMs doesn't change JARVIS

12. **EVERY ACTION IS AUDITABLE**
    - Know what JARVIS did, why, and when

---

## Part 14: Success Metrics

### Phase 0
- [ ] Can reason through multi-agent pipeline
- [ ] Verification catches 80%+ of errors
- [ ] Memory persists and is retrievable
- [ ] Audit trail is complete
- [ ] Works without paid services

### Phase 1
- [ ] Can autonomously code simple features
- [ ] Can debug and fix errors
- [ ] Code quality is acceptable
- [ ] Self-improvement loop works
- [ ] Builds itself faster each iteration

### Phase 1.5
- [ ] Conversation feels natural
- [ ] Context carries across turns
- [ ] Personality is consistent
- [ ] Streaming works smoothly
- [ ] Interruption is seamless

### Phase 2
- [ ] Can have natural voice conversation
- [ ] Can be interrupted mid-sentence
- [ ] Responds within <1 second (streaming)
- [ ] Handles noise/echo
- [ ] Works in realistic environments

### Phase 3
- [ ] Understands screen content
- [ ] Understands visual context
- [ ] Routes correctly (needs screen? skip)
- [ ] Answers visual questions accurately

### Phase 4
- [ ] Proactively identifies opportunities
- [ ] Respects interruption/attention
- [ ] Doesn't become annoying
- [ ] Takes autonomous actions correctly

### Phase 5
- [ ] Integrates with 5+ tools/services
- [ ] Operates seamlessly across digital tools
- [ ] Remembers integrations and context
- [ ] Reduces manual data entry

### Phase 6
- [ ] Unified JARVIS on PC and phone
- [ ] Conversation continues across devices
- [ ] Memory syncs properly
- [ ] Permissions carry over

---

## Part 15: What JARVIS Is Not (Yet)

These are intentionally future capabilities:

- Movie-level robotics
- Iron Man suit integration
- Drones
- Fully autonomous decision-making
- Unlimited intelligence
- Uncontrolled self-modification
- Fully distributed cloud reasoning
- Multi-user architecture

---

## Part 16: Build Strategy

### Don't Do:
- Start with fancy UI (use CLI)
- Build everything at once
- Introduce unnecessary complexity
- Create perfect abstractions prematurely
- Assume you know future needs

### Do:
- Build end-to-end vertical slices
- Test against real scenarios
- Iterate based on what breaks
- Keep architecture explicit
- Document decisions
- Build the boring stuff first

### Timeline Principles:
- Phase 0: Weeks (foundation)
- Phase 1: Weeks-months (developer)
- Phase 1.5: Weeks (conversational intelligence)
- Phase 2: Weeks (voice)
- Phase 3+: Ongoing

Don't rush. Each phase earns the right to the next.

---

## Final Statement

JARVIS is a **persistent, multi-faceted intelligence** that lives on Gavin's computer and can be accessed through multiple interfaces.

It begins as a reasoning engine with memory and verification.

It gains the ability to engineer software.

It gains voice and perception.

It gains proactive intelligence.

It gains mobile access.

Throughout, it remains **one intelligence with consistent identity, memory, and personality** — regardless of which device you're using or which LLM provider is running the reasoning.

**The objective is not to recreate movie JARVIS immediately.**

**The objective is to build the foundation so well that adding new capabilities becomes an integration problem, not another reinvention.**

---

**Build the brain.** (Phase 0) ✅
**Build the developer.** (Phase 1) ✅  
**Build the conversation.** (Phase 1.5) ⏳  
**Then give it voice.** (Phase 2)
**Then let it see.** (Phase 3)
**Then let it think ahead.** (Phase 4)
**Then connect everything.** (Phase 5+)
