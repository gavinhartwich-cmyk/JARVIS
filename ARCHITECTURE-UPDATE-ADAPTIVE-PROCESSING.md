# JARVIS — Architecture Update

**Changes to Existing Architecture**

Date: September 4, 2026
Purpose: Update the existing JARVIS architecture based on new findings from Mark LII and the Gemini Live approach.

> **IMPORTANT: This is an architecture UPDATE, not a rebuild.**
> Preserve all existing verified architecture and work unless explicitly changed below.

---

## 1. PRIMARY CHANGE — Introduce Adaptive Processing

### Current problem

JARVIS currently routes too much work through the multi-agent intelligence pipeline.

This creates unacceptable latency for simple conversational requests.

A simple question should not take minutes because JARVIS activates:

- multiple agents
- verification
- memory processing
- orchestration
- multiple model calls

### Change

Add an Intent / Complexity Router before expensive orchestration.

```
User
 ↓
Input / Realtime Layer
 ↓
Intent Router
 │
 ├── FAST → direct conversational response
 │
 ├── TOOL → direct deterministic tool execution
 │
 ├── REASONING → limited reasoning pipeline
 │
 └── DEEP → existing multi-agent architecture
```

The existing multi-agent architecture becomes the deep reasoning mode, rather than the default path for every interaction.

---

## 2. NEW FAST PATH

Create a low-latency execution path for simple requests.

Examples:

- greetings
- basic questions
- calculations
- short explanations
- simple conversation
- basic contextual responses

Target:

```
User
 ↓
Realtime model
 ↓
Streaming response
```

No unnecessary Researcher / Reasoner / Critic / Verifier / Auditor for trivial requests.

### Design requirement

The fast path must be capable of responding without invoking the deep orchestration system.

---

## 3. NEW REALTIME VOICE LAYER

### Change

Investigate and prototype Gemini Live API as the realtime conversational transport.

This is specifically being considered because Mark LII demonstrates significantly lower perceived conversational latency than the current JARVIS implementation.

Gemini Live should **NOT** replace the JARVIS intelligence architecture.

It should act as the realtime conversational interface/model layer.

Target:

```
Microphone
 ↓
Realtime Session
 ↓
JARVIS Core
 ↓
Streaming Audio
 ↓
Speaker
```

The implementation must remain provider-independent.

Gemini Live is the first realtime provider to prototype, not a permanent hard dependency.

---

## 4. STREAMING IS REQUIRED

JARVIS should not wait for an entire response before beginning playback.

Current undesirable behavior:

```
Generate entire response
 ↓
Wait
 ↓
TTS entire response
 ↓
Play
```

Target:

```
Model begins response
 ↓
First audio generated
 ↓
Playback begins
 ↓
Remaining response streams
```

Measure time-to-first-audio, not merely total response time.

---

## 5. BARGE-IN / INTERRUPTION

Add proper conversational interruption.

Required behavior:

```
JARVIS speaking
       ↓
User starts speaking
       ↓
JARVIS immediately stops audio
       ↓
JARVIS listens
       ↓
New request begins
```

The user must not have to wait for JARVIS to finish speaking.

This is a major requirement for the intended movie-style conversational experience.

---

## 6. SESSION MANAGEMENT

Introduce a provider-independent session manager.

Conversation state must belong to JARVIS rather than Gemini/Claude/another provider.

```
JARVIS SESSION
      │
      ├── Gemini Live
      ├── Claude
      ├── Other provider
      └── Future local models
```

The session manager must preserve:

- conversation state
- current task
- memory references
- active tools
- identity/context
- provider session information

Provider reconnection must not destroy the user's JARVIS session.

---

## 7. LATENCY TELEMETRY

Add instrumentation before optimizing further.

Every request should record:

```
Input received
↓
STT / audio processing
↓
Intent routing
↓
Provider connection
↓
First token
↓
First audio
↓
Tool execution
↓
Agent execution
↓
Verification
↓
Total completion
```

Minimum metrics:

- routing latency
- model latency
- time to first token
- time to first audio
- tool latency
- agent latency
- verification latency
- total latency

### Development target

For normal conversational requests, aim for sub-2-second perceived response initiation, with the long-term target being substantially faster where the provider permits.

**Do not assume the bottleneck. Measure it.**

---

## 8. CHANGE — LLMs SHOULD NOT TRANSLATE KNOWN ACTIONS

Adopt the pattern demonstrated by Mark LII.

If JARVIS already knows how to perform an action, do not use an additional model call to translate the action into another representation.

Bad:

```
User
 ↓
LLM
 ↓
Action interpretation LLM
 ↓
Executor
```

Target:

```
User
 ↓
LLM / realtime model
 ↓
Structured tool call
 ↓
Validated deterministic executor
```

Example: "Open Spotify." should become a structured tool call such as `open_application("Spotify")` and then execute directly.

---

## 9. CHANGE — MULTI-AGENT ORCHESTRATION BECOMES CONDITIONAL

Do not remove the existing multi-agent system. Change when it is activated.

- **Fast** — One model
- **Tool** — Model → tool
- **Moderate reasoning** — Model → retrieval/tool → response
- **Complex task** — Planner → Researcher → Reasoner → Critic → Verifier → Synthesizer

The existing multi-agent architecture remains the high-intelligence mode.

---

## 10. NEW ACTION JOURNAL

Introduce a universal action journal integrated with the existing audit system.

Every executable action should record:

- action ID
- timestamp
- tool
- parameters
- result
- risk level
- reversible status
- inverse action

This becomes the foundation for reliable undo and action history.

---

## 11. NEW UNIVERSAL UNDO SYSTEM

Adopt Mark LII's inverse-action concept.

Where possible, every action should define its inverse.

Example: `MOVE A → B` stores `MOVE B → A`.

JARVIS should eventually support:

- "Undo that."
- "Undo the last action."
- "Undo the last three actions."

Undo should be implemented at the execution layer rather than separately inside the conversational layer.

---

## 12. CHANGE — CONFIRMATION MUST COME FROM THE USER INTERFACE

Never allow the model to self-authorize dangerous operations by generating `confirmed: true`.

Instead:

```
JARVIS requests confirmation
 ↓
UI displays confirmation
 ↓
User physically confirms
 ↓
UI generates authorization token
 ↓
Executor validates token
 ↓
Action executes
```

This should integrate with the existing authorization/security architecture.

---

## 13. MEMORY UPDATE

Adopt the useful principle from Mark LII:

**Do not inject the entire memory store into every prompt.**

Separate core / always-available memory from retrievable memory.

The model should have a way to know what categories of information are available and retrieve specific memories when necessary.

This is especially important for reducing unnecessary context and latency.

The existing JARVIS memory system should be preserved and evolved rather than replaced.

---

## 14. CAPABILITY / PLUGIN DIRECTION

Formalize capabilities so new functionality does not require modifying the JARVIS core.

Target:

```
JARVIS
 ↓
Capability Registry
 ↓
Tools / Plugins / MCP
 ↓
Executors
```

Examples: Computer, Browser, Files, Calendar, Email, Research, Vision, Devices.

MCP may be used as a standardized capability interface where appropriate.

**Do not make MCP the intelligence layer.**

---

## 15. AUDIO DEVICE ROBUSTNESS

Adopt the engineering philosophy demonstrated by Mark LII around audio device management.

The audio system should:

- discover available devices
- filter irrelevant/duplicate devices
- identify devices by stable name/identity rather than volatile indexes
- remember preferred devices
- gracefully recover when a device disappears
- fall back to another valid device

This is a reliability improvement, not a core architecture rewrite.

---

## 16. PROACTIVE INTELLIGENCE — KEEP AS FUTURE DIRECTION

Mark LII reinforces the importance of proactive behavior.

**Do NOT prioritize this over latency.**

Eventually JARVIS should be able to evaluate:

```
Current world state
 ↓
Does something require attention?
 ↓
Priority
 ↓
Should JARVIS interrupt?
```

This should remain downstream of the core realtime and context architecture.

---

## 17. HUD UPDATE

The HUD should reflect actual system state.

Minimum states: `IDLE`, `LISTENING`, `THINKING`, `SPEAKING`, `EXECUTING`, `CONFIRMATION REQUIRED`, `INTERRUPTED`, `ERROR`.

Audio visualization should correspond to actual microphone/JARVIS audio activity.

The HUD should communicate state rather than simply be decorative.

**Do not prioritize visual polish ahead of realtime performance.**

---

## 18. FUTURE SELF-EXTENSION

Keep the existing self-improvement direction, but adopt a controlled capability-installation model:

```
Capability gap detected
 ↓
Proposal
 ↓
Developer agent
 ↓
Build
 ↓
Sandbox
 ↓
Tests
 ↓
Security verification
 ↓
Human approval
 ↓
Install
```

**Do not provide unrestricted self-modification.**

---

## 19. WHAT DOES NOT CHANGE

The following existing JARVIS architecture remains intact:

- existing core intelligence architecture
- existing multi-agent orchestration
- existing researcher/reasoner/critic concepts
- existing verification system
- existing audit trail
- existing memory foundation
- existing computer-control work
- existing identity/security direction
- existing Windows-first approach
- existing provider abstraction
- existing OmniRoute experimentation
- existing PC application direction

These changes are extensions and optimizations, not replacements.

---

## 20. IMMEDIATE IMPLEMENTATION ORDER

Do not attempt all changes simultaneously.

**Step 1 — Measure.** Instrument the current system and determine why simple requests currently take minutes.

**Step 2 — Fast Path.** Implement the intent/complexity router.

**Step 3 — Deterministic Tools.** Remove unnecessary model calls from computer/tool execution.

**Step 4 — Gemini Live Prototype.** Build a small isolated realtime prototype. It should test: microphone streaming, realtime response, streaming audio, interruption, session persistence, one JARVIS tool.

**Step 5 — Compare.** Measure CURRENT JARVIS vs GEMINI LIVE PROTOTYPE: time to first response, time to first audio, total response time, interruption latency, CPU/RAM, reliability.

**Step 6 — Integrate.** If Gemini Live materially improves latency, integrate the realtime layer into JARVIS while preserving the existing intelligence core.

**Step 7 — Action Journal + Undo.** Add universal action tracking and inverse actions.

**Step 8 — Capability Registry.** Formalize tools/plugins/MCP.

**Step 9 — Continue Existing Roadmap.** Only after the realtime foundation is stable should additional advanced capabilities be prioritized.

---

## FINAL ARCHITECTURAL DIRECTION

The central change is:

**JARVIS should no longer equate intelligence with computational depth.**

The system should be capable of being extremely fast when the task is simple and extremely thorough when the task is difficult.

```
                    USER
                     │
                     ▼
              REALTIME INPUT
                     │
                     ▼
                INTENT ROUTER
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
        FAST        TOOL       DEEP
        PATH        PATH       PATH
          │          │          │
          │          │       Existing
          │          │       multi-agent
          │          │       architecture
          │          │          │
          └──────────┼──────────┘
                     ▼
               JARVIS CORE
                     │
               MEMORY / STATE
                     │
              CAPABILITY LAYER
                     │
              EXECUTION LAYER
                     │
            SAFETY / VERIFICATION
```

The goal is not to make JARVIS do less thinking.

The goal is to make JARVIS know when thinking is necessary.
