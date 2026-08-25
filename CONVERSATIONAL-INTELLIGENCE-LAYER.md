# Conversational Intelligence & Natural Interaction Layer

## Overview

The **Conversational Intelligence & Natural Interaction Layer** is the core architectural component that makes JARVIS feel like a persistent, intelligent assistant rather than an isolated request handler.

This is foundational—not cosmetic—and completely independent of the underlying LLM provider, voice system, or storage backend.

---

## Core Architecture

```
User Input (Text/Voice)
         ↓
┌─────────────────────────────────────────────┐
│   Conversation Engine                       │
│  - State management                         │
│  - Turn tracking                            │
│  - Reference resolution                     │
│  - Intention detection                      │
│  - Natural turn detection                   │
└──────────────┬──────────────────────────────┘
               ↓
┌─────────────────────────────────────────────┐
│   Conversational Intelligence               │
│  - Long-term memory integration             │
│  - Proactive monitoring                     │
│  - Streaming coordination                   │
│  - Interruption handling                    │
│  - Personality layer                        │
└──────────────┬──────────────────────────────┘
               ↓
┌─────────────────────────────────────────────┐
│   Intelligent Model Router                  │
│  - Model selection                          │
│  - Reasoning path determination             │
│  - Streaming vs. buffered                   │
│  - Cache decisions                          │
│  - Cost/latency tradeoffs                   │
└──────────────┬──────────────────────────────┘
               ↓
┌─────────────────────────────────────────────┐
│   LLM Provider (Swappable)                  │
│  - Claude / Gemini / OpenAI / Local        │
│  - Streaming support                        │
└──────────────┬──────────────────────────────┘
               ↓
Output (TTS/Display)
```

---

## Key Components

### 1. Conversation Engine (`phase2/conversation-engine.ts`)

**What it does:**
- Manages conversational state across all interactions
- Resolves pronouns and references ("that", "it", "there")
- Detects user intention (question, command, request, conversational)
- Tracks entities and recent decisions
- Detects natural turn ends (silence duration, sentence breaks)
- Handles interruptions gracefully

**Data Structures:**
```typescript
ConversationState: "idle" | "listening" | "thinking" | "speaking" | 
                   "interrupted" | "executing" | "waiting_for_user" | "error"

WorkingMemory: {
  recentTurns: ConversationTurn[]
  currentTopic: string
  currentTask?: string
  recentEntities: Map<string, unknown>
  pronounReferents: Map<string, string>
  pendingActions: string[]
  recentDecisions: Array<{decision: string, timestamp: Date}>
}

ReasoningPath: {
  type: "fast" | "main" | "deep" | "deterministic"
  costEstimate: "low" | "medium" | "high"
  latency: "immediate" | "fast" | "moderate" | "variable"
}
```

**Example Usage:**
```typescript
const engine = new ConversationEngine();

// Process user utterance
const { intention, reasoningPath } = 
  await engine.processUserUtterance("Move that to Thursday");
// Resolves "that" → what was most recently mentioned
// Detects intention: "command"
// Selects path: fast (low cost)

// Start speaking (with interruption support)
const speaker = await engine.startSpeaking(response);

// User interrupts
await engine.handleInterruption(newUtterance);
speaker.cancel(); // Stop current speech

// Detect natural turn end
const isTurnEnd = await engine.detectTurnEnd({
  isSilent: true,
  silenceDurationMs: 1200
}); // Returns: true (1-2 seconds of silence = end of sentence)

// Record turn for memory
engine.recordTurn(userUtterance, jarvisResponse, actionsTaken);
```

---

### 2. Conversational Intelligence (`core/conversation-intelligence.ts`)

**What it does:**
- Orchestrates conversation with full context
- Manages long-term memory (episodes, facts, procedures)
- Handles streaming responses (token-by-token)
- Proactively monitors for things to bring up
- Learns user preferences over time
- Integrates short-term + long-term memory

**Key Features:**

#### Streaming Support
```typescript
// Process with streaming (start TTS immediately)
const stream = await convIntel.processWithStreaming(utterance);

// Tokens arrive one at a time
stream.tokens; // ["Let", "me", "help", "..."]
stream.isComplete; // false until all tokens arrive

// Can cancel mid-stream
stream.cancel(); // Stops current response
```

#### Memory Integration
```typescript
// Long-term memory
convIntel.recordSemanticFact("gavin_prefers", "brief and direct", 0.95);
convIntel.recordProcedure("morning_routine", [
  "check calendar",
  "read emails",
  "review tasks"
]);

// Episodes (what happened)
convIntel.recordEpisode(
  "User asked about HVAC lead scoring",
  ["HVAC", "lead", "scoring"],
  ["explained approach", "offered to build system"],
  0.8 // importance
);
```

#### Proactive Monitoring
```typescript
// Register monitors that check conditions periodically
convIntel.registerProactiveMonitor("meeting-soon", async () => {
  const calendar = await getCalendar();
  if (calendar.nextMeeting < 10 minutes) {
    return "You have a meeting in 10 minutes";
  }
  return null;
});

// Or: unfinished tasks, deadline approaching, context switch detected, etc.
```

#### Interruption Handling
```typescript
// User speaks while JARVIS is speaking
await convIntel.handleInterruption(
  "wait, actually no",
  isStreaming = true,
  isSpeaking = true
);
// Cancels current response, processes new utterance
```

---

### 3. Intelligent Model Router (`core/model-router.ts`)

**What it does:**
- Selects optimal LLM based on reasoning complexity
- Routes requests to appropriate model (fast/main/deep)
- Makes streaming vs. buffered decisions
- Manages caching
- Applies user preferences

**Model Selection Logic:**
```
Reasoning Path → Model Choice

"fast" (simple Q&A)
  └─→ claude-haiku (fastest, cheapest)

"main" (normal conversation)
  └─→ claude-opus (balanced)

"deep" (complex reasoning)
  └─→ claude-opus with extended thinking

"deterministic" (system operations)
  └─→ claude-haiku (temperature: 0.0)
```

**Example:**
```typescript
const router = new IntelligentModelRouter();

// Select model for this request
const choice = router.selectModel(
  intention = "question",
  reasoning = { type: "fast", costEstimate: "low", ... },
  context = conversationContext
);
// Returns: claude-haiku with streaming enabled

// User has limited budget? Adjust:
router.setPreference("budget", "free");
// Now always uses cheapest models

// Analyze patterns
const patterns = router.analyzePatterns();
// { mostCommonIntention: "conversational", averageResponseTime: 800ms, ... }
```

---

### 4. Orchestrator Integration (`core/orchestrator.ts`)

**What it does:**
- Integrates conversation intelligence with multi-agent reasoning
- Provides unified interface for task execution + conversation
- Manages proactive monitors
- Records learnings from interactions

**New Methods:**
```typescript
// Process conversation with full context awareness
const { response, context } = 
  await orchestrator.processConversation(userUtterance);

// Record learnings
orchestrator.recordSemanticFact("gavin_timezone", "America/Winnipeg", 0.95);
orchestrator.recordProcedure("lead_follow_up", [
  "check last contact",
  "research company changes",
  "personalize message",
  "schedule follow-up"
]);

// Get full status
const status = orchestrator.getOrchestratorStatus();
// { agents, conversation, memory, modelRouter }
```

---

## How It Works: A Complete Example

**User says:** "Move that to Thursday"

### Step 1: Conversation Engine
```
Input: "Move that to Thursday"
  ↓
Reference Resolution:
  "that" → looks at recent turns
  finds: "quarterly planning meeting"
  Resolved: "Move quarterly planning meeting to Thursday"
  ↓
Intention Detection:
  Contains "move" (action verb)
  Intent: "command"
  ↓
Turn Detection:
  Listening...
  2.3 seconds of silence
  Turn is complete!
```

### Step 2: Model Router
```
Intention: "command"
Reasoning Path: deterministic (direct system operation)
  → Cost: "low"
  → Latency: "fast"
  → Model: claude-haiku
  → Temperature: 0.0 (deterministic)
  → Streaming: false
```

### Step 3: Conversational Intelligence
```
Assemble Prompt:
  - Personality rules
  - Current task context
  - Relevant procedures ("move items to dates")
  - Known facts ("user prefers Thursdays for planning")
  - Recent conversation: "We discussed quarterly planning earlier"
  ↓
Check Cache:
  "Move to Thursday" similar to previous?
  No cached response found
  ↓
Stream Response:
  Model: "I'll move the quarterly planning meeting to Thursday"
  Confidence: 0.95
```

### Step 4: Execution
```
Action: Move meeting
  ↓
Record Turn:
  User: "Move that to Thursday"
  JARVIS: "I'll move the quarterly planning meeting to Thursday"
  Actions: ["update_calendar"]
  ↓
Learn Fact:
  "user_mentions_thursday_for_planning" → high importance
  ↓
Update Preferences:
  User seems to prefer Thursday for planning work
```

---

## Memory System

### Short-Term (Working Memory)
- Last 10 conversation turns
- Current task
- Pending actions
- Recent entities mentioned
- Pronunciation referents

**Lifetime:** Duration of conversation

### Long-Term (Episodic Memory)
- Complete conversation episodes
- Key entities
- Outcomes
- Importance rating

**Lifetime:** Indefinite (can be pruned)

### Semantic Facts
```typescript
recordSemanticFact("gavin_timezone", "America/Winnipeg", 0.95)
recordSemanticFact("gavin_business", "HVAC sales + review automation", 0.9)
recordSemanticFact("gavin_preferred_response_style", "brief", 0.8)
```

**Used for:** Context assembly, proactive monitoring

### Procedures
```typescript
recordProcedure("morning_briefing", [
  "check calendar",
  "summarize top 3 priorities",
  "mention key emails",
  "note any blockers"
], {
  "quick": ["check calendar", "top priority only"],
  "detailed": ["everything + market news"]
})
```

**Used for:** Understanding how user does things, suggesting automation

---

## Streaming & Natural Response

### Streaming Flow
```
User says something
         ↓
Model starts generating tokens
         ↓
First token arrives (8-15ms)
         ↓
TTS starts speaking
  "I"... (waits for next token)
         ↓
Second token: "understand"
  "I understand"...
         ↓
Response feels instantaneous even though model is still thinking
```

### Interruption During Speech
```
JARVIS: "I'll move the quarterly planning meeting to..."
User: "Actually, move it to Friday instead"
         ↓
Speech stops immediately
TTS cleared
Previous reasoning cancelled
New utterance processed
```

---

## Proactive Intelligence

Instead of just reacting, JARVIS notices things:

```typescript
// Monitor 1: Pending actions
"You have 3 actions still pending from this morning"

// Monitor 2: Schedule conflicts
"Your 2 PM meeting overlaps with the call you scheduled"

// Monitor 3: Forgotten follow-ups
"You mentioned following up with John yesterday but haven't yet"

// Monitor 4: Pattern breaks
"This is unusual—you normally call prospects in the morning, not afternoon"

// Monitor 5: Contextual hints
"You said you preferred brief responses, but that last answer was very detailed"
```

---

## Personality Layer

JARVIS's behavioral identity is consistent regardless of model:

```typescript
// Personality is applied to ALL responses, from any model
const personality = {
  tone: "professional but warm",
  formality: "casual (use contractions)",
  conciseness: "moderate (detail only when asked)",
  humor: true,
  proactivity: "balanced (suggest, don't override)"
};

// Example application:
rawResponse = "It is possible that the customer requires..."
afterPersonality = "The customer might need..."
// Same content, more human tone
```

---

## Integration Points

### With Voice Interface (Phase 2)
```typescript
// Voice comes in
const utterance = await speechRecognizer.recognize();

// Process through conversation intelligence
const { response } = await orchestrator.processConversation(utterance);

// Speak response
await speechSynthesizer.speak(response);
```

### With Vision System (Phase 3)
```typescript
// User points at screen: "What's that?"
const visionDescription = await visionSystem.describe(screenRegion);

// Context-aware response
await orchestrator.processConversation(
  `Based on the screen, ${visionDescription}, I see...`
);
```

### With CRM & Business Systems
```typescript
// Conversation intelligence learns facts
recordSemanticFact("gavin_target_leads", "HVAC companies 50-200 employees", 0.9);

// Passes to business tools
const leads = await crmSystem.findLeads(semanticFact);

// Proactively suggests
"You have 12 qualified leads matching your target profile"
```

---

## Configuration & Customization

### User Preferences
```typescript
// Set via update preferences
convIntel.updatePreferences({
  communicationStyle: "brief",
  responseTime: "immediate",
  formality: "casual",
  proactivity: "balanced",
  interruptionTolerance: "high"
});
```

### Model Configuration
```typescript
// Add custom model
router.addModel("local-small", {
  provider: "local",
  model: "llama2-7b",
  temperature: 0.7,
  maxTokens: 1000,
  stream: true
});

// Set budget
router.setPreference("budget", "free"); // Use cheapest models
```

### Proactive Monitors
```typescript
// Register custom monitor
convIntel.registerProactiveMonitor("business-metric", async () => {
  const revenue = await getRevenueToday();
  if (revenue > dailyTarget) {
    return `Great day! You've hit $${revenue} so far.`;
  }
  return null;
});
```

---

## TypeScript Types

```typescript
// Conversation state
type ConversationState = 
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "executing"
  | "waiting_for_user"
  | "error";

// Reasoning path
interface ReasoningPath {
  type: "fast" | "main" | "deep" | "deterministic";
  costEstimate: "low" | "medium" | "high";
  latency: "immediate" | "fast" | "moderate" | "variable";
  description: string;
}

// Streaming response
interface StreamingResponse {
  id: string;
  text: string;
  tokens: string[];
  isComplete: boolean;
  confidence: number;
  totalTokens: number;
  cancel: () => void;
}

// Memory
interface ConversationMemory {
  episodes: Array<{
    timestamp: Date;
    summary: string;
    key_entities: string[];
    outcomes: string[];
    importance: number;
  }>;
  semanticFacts: Map<string, {fact: string, confidence: number}>;
  procedures: Map<string, {steps: string[], frequency: number}>;
  preferences: {...};
}
```

---

## Phase Alignment

This layer is the **bridge between Phase 0 (core reasoning) and Phases 1-3 (capability expansion)**.

- **Phase 0:** Foundation (agents, memory, tools)
- **Phase 1:** Developer system (self-improving)
- **Phase 2:** Voice interface
- **Phase 3:** Vision + screen control

**Conversational Intelligence** enables:
- ✓ Continuous conversation across all phases
- ✓ Context carryover
- ✓ Memory integration
- ✓ Natural interaction
- ✓ Proactive assistance

Without this layer, each phase would be isolated. With it, everything feels like one coherent system.

---

## Implementation Checklist

- ✅ Conversation Engine core
- ✅ Working memory management
- ✅ Reference resolution
- ✅ Intention detection
- ✅ Turn end detection
- ✅ Interruption handling
- ✅ Conversational Intelligence layer
- ✅ Long-term memory integration
- ✅ Streaming support
- ✅ Proactive monitoring
- ✅ Intelligent Model Router
- ✅ Model selection logic
- ✅ Cache decisions
- ✅ Personality layer
- ✅ Orchestrator integration

**Ready for integration with voice/vision systems**

---

## Next: Integration with Phases 2 & 3

Once this layer is tested:

1. **Phase 2:** Wire to voice interface
   - Stream tokens → TTS
   - Interruption detection
   - Wake word tied to state

2. **Phase 3:** Wire to vision system
   - Visual context enriches conversation
   - Screen operations guided by intent
   - Gesture recognition integrates with conversation

3. **Long-term:** Proactive agents
   - Conversation intelligence spawns background tasks
   - Monitors run continuously
   - System becomes genuinely proactive
