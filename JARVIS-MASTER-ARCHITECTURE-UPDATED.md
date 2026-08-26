# JARVIS — Comprehensive Master Architecture

**Updated:** August 26, 2026  
**Status:** Phase 0 verified real. Everything else below was previously marked "complete" without ever being executed — corrected here after actually reading the source, not the prior status reports.  
**Core Principle:** One persistent intelligence with multiple interfaces, devices, memories, and capabilities

**Ground-truth status (verified by reading code — last updated 2026-08-26, after building Part 3):**
- ✅ **Phase 0** — real. 5-agent orchestrator, memory, verification, audit trail. Proven end-to-end against live Postgres + Claude.
- ✅ **Phase 1.5 (Conversational Intelligence)** — real. Actually imported and called from `orchestrator.ts` (`processWithStreaming`, `completeTurn`, memory methods), not just sitting unused.
- ✅ **Part 3 Foundational Subsystems** — real, built 2026-08-26. Presence & Device Awareness (`core/presence.ts`), Identity Recognition (`core/identity.ts`), Authorization Engine (`core/authorization.ts`, 4 levels), and Security Layer are wired into actual tool execution (`tools/manager.ts`, `phase3/screen-control.ts`) — not documentation, actually enforced: `bun run dev whoami` exercises the full chain. Computer Control (`phase3/windows-control.ts`) is real PowerShell/Win32 automation, but **unverified** — written and typechecked on a Linux sandbox that cannot run it; must be confirmed with `bun run dev control-test` on the actual Windows PC before it's trusted.
- ✅ **Second LLM provider (Gemini)** — real (`models/gemini-provider.ts`), direct REST call to Google's API, no Zo dependency. Select with `JARVIS_PROVIDER=gemini`. Also unverified against a live key — needs `GEMINI_API_KEY` and a real run to confirm the model name/response shape still match Google's API.
- ❌ **Phase 1 (JARVIS Developer)** — NOT real. `developer.ts`'s 10-agent pipeline has zero calls to any LLM provider; it's console.log simulation. `bun run dev phase1` doesn't even invoke it — prints a static status message and exits.
- ❌ **Phase 2 (Voice)** — NOT real. `speech-recognizer.ts`, `speech-synthesizer.ts`, `wake-word-detector.ts` have zero external imports (no Whisper, no Piper, no wake-word library). No CLI command reaches any of it.
- ⚠️ **Phase 3 (Vision/Screen)** — screen control is now real (see above); `GeminiVisionProvider` still throws "not yet implemented" on every method — vision itself (not control) remains unbuilt. No CLI command reaches vision or the rest of Perception.
- ❌ **Phase 5 (Visual HUD)** — doesn't exist. No `desktop/` folder. Never got past a chat message.
- ⚠️ **Provider-agnostic / $0-first** — closer to true. Claude via Zo (`ZO_API_KEY`) still works and is the default; Gemini (`GEMINI_API_KEY`, free tier) is now a real second path with zero Zo dependency. No Ollama/local model yet — that piece of "$0 without any API key at all" is still not built.

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

Claude, Gemini, local models, or future models are **providers** that JARVIS can use through a standardized interface.

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

**Status:** ❌ Not real. Files exist (`speech-recognizer.ts`, `speech-synthesizer.ts`, `wake-word-detector.ts`) but have zero external library imports — no Whisper, no Piper, no wake-word engine. Pure stubs. No CLI command reaches them. Needs actual libraries and hardware testing on the PC — cannot be built or verified from Zo's Linux sandbox alone.

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

**Status:** ❌ Not real. `screen-control.ts` exists but `executeSequence()` only calls `simulateAction()` — no real OS input control. `GeminiVisionProvider` throws "not yet implemented" on every method. No CLI command reaches any of it.

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
| LLM (primary) | Claude (Anthropic) | During development |
| LLM (local) | Llama 2 or similar | $0 fallback path |
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
