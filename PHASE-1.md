# JARVIS Phase 1 — Core + Verification (In Development)

**Status:** Architecture in development, implementation in progress  
**Target:** Ready for review when you return from work

---

## Overview

Phase 1 builds on Phase 0's foundation with:

1. **Dynamic Task Decomposition** — Route tasks intelligently instead of fixed pipeline
2. **Specialized Agent Set** — 15+ agent types for different problem domains
3. **Tool Execution Framework** — File access, APIs, command execution
4. **Task Routing System** — Route "write code" vs "debug" vs "explain" appropriately
5. **Enhanced Memory** — Extract and learn from tasks automatically

---

## What's Being Built Now

### 1. Dynamic Task Decomposer (`src/core/task-decomposer.ts`)

**Problem:** Phase 0 uses a fixed 5-agent pipeline for everything.  
**Solution:** Analyze task and choose appropriate agent sequence.

**How it works:**

```
User Task
    ↓
TaskDecomposer.analyzeTask()
    ↓
Determine: type, complexity, tools needed
    ↓
TaskDecomposer.getAgentPipeline()
    ↓
Return appropriate agent sequence
```

**Task Types Recognized:**

- `research` → Researcher + Synthesizer
- `reasoning` → Researcher → Reasoner → Critic → Fact-Checker → Synthesizer
- `code_write` → Architect → Coder → Tester → CodeReviewer → SecurityReviewer → Synthesizer
- `code_debug` → ErrorAnalyzer → Debugger → Tester → CodeReviewer → Synthesizer
- `code_review` → CodeReviewer → SecurityReviewer → PerformanceAnalyzer → Synthesizer
- `explanation` → Researcher → Explainer → Simplifier → Synthesizer
- `planning` → Architect → Planner → Critic → Verifier → Synthesizer
- `analysis` → Researcher → Analyzer → Critic → Synthesizer
- `verification` → FactChecker → Verifier → Synthesizer
- `synthesis` → Synthesizer

**Example:**

```typescript
const decomposer = new TaskDecomposer();
const task = "Write a TypeScript function to validate email addresses";

const analysis = decomposer.analyzeTask(task);
// → { type: "code_write", complexity: "moderate", requiresExternalTools: true, ... }

const pipeline = decomposer.decompose(task);
// → { agentSequence: ["architect", "coder", "tester", "code-reviewer", ...] }
```

### 2. Specialized Agents (`src/agents/specialized-agents.ts`)

**Phase 0 had:** 5 core agents (Researcher, Reasoner, Critic, FactChecker, Synthesizer)

**Phase 1 adds:**

**Code Domain:**
- `architect` — Design code structure and APIs
- `coder` — Write actual code
- `tester` — Create and run tests
- `debugger` — Fix bugs and errors
- `code-reviewer` — Code quality and best practices
- `security-reviewer` — Security vulnerabilities
- `performance-analyzer` — Optimization and efficiency
- `error-analyzer` — Analyze error messages and traces

**Explanation & Analysis:**
- `explainer` — Explain concepts clearly
- `simplifier` — Simplify complex explanations
- `analyzer` — Break down topics

**Planning & Verification:**
- `planner` — Break goals into steps
- `verifier` — Final validation

Each agent has:
- Specific role and responsibilities
- Specialized instructions
- Capability metadata (category, cost, duration, required context)

### 3. Tool Execution Framework (`src/tools/`)

**Phase 0 had:** Agents could only reason, not act.  
**Phase 1 adds:** Agents can execute tools.

**Tool Architecture:**

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: ParameterDefinition[];
  requiresApproval?: boolean;
  execute(params): Promise<ToolResult>;
}
```

**Initial Tools:**

**File System:**
- `read_file` — Read file contents
- `write_file` — Write/create files
- `list_files` — List directory
- `delete_file` — Delete files

**Planned Tools:**

**API:**
- `http_get` — Fetch from URL
- `http_post` — POST to URL
- `api_call` — Generic API calls

**Command Execution:**
- `bash_run` — Execute shell commands
- `node_run` — Run Node.js code

**Code:**
- `run_tests` — Execute test suite
- `run_linter` — Check code style
- `run_formatter` — Format code

**Memory:**
- `store_memory` — Save to memory
- `retrieve_memory` — Query memory

**Safety:** Tools can mark themselves as `requiresApproval = true` for dangerous operations (write, delete, execute). Later: implement approval workflow.

---

## Architecture Changes

### Updated Orchestrator

**Phase 0:**
```
Task → Decompose (fixed pipeline) → Agent Pipeline → Result
```

**Phase 1:**
```
Task → Decompose (smart routing) → Agent Pipeline → Result
      ↑                          ↑
      └─ TaskDecomposer ────────┘
```

The Orchestrator will:
1. Call `TaskDecomposer.analyzeTask()`
2. Get the agent sequence
3. Execute agents in sequence (same as Phase 0)
4. But now the pipeline is customized per task

### Agent Execution with Tools

**Phase 0:**
```
Task → Agent → Model Call → Output
```

**Phase 1:**
```
Task → Agent → Model Call → Parse Tools?
                    ↓
                Tool Call
                    ↓
              Tool Execution
                    ↓
              Use Results → Final Output
```

Agents can request tool calls in their output, which the orchestrator executes.

---

## Integration Plan

**Step 1: TaskDecomposer Integration**
- Update `Orchestrator.orchestrate()` to use `TaskDecomposer`
- Replace fixed decomposition with dynamic routing
- Validate that it correctly routes different task types

**Step 2: Register Specialized Agents**
- Add specialized agents to orchestrator
- Register with model provider
- Test each agent individually

**Step 3: Tool Framework Integration**
- Add tool execution to agent pipeline
- Implement approval workflow for dangerous tools
- Test file operations first

**Step 4: End-to-End Testing**
- Test "write code" task → full pipeline
- Test "debug this" task → error-focused pipeline
- Test "explain this" task → explanation pipeline

---

## Why This Matters

**Task Routing:** Instead of running the same pipeline for everything:
- Research task gets a lightweight 2-agent pipeline
- Code writing gets a specialized 6-agent pipeline
- Debugging gets a focused error-handling pipeline

This means:
- ✅ Faster for simple tasks
- ✅ More capable for complex tasks
- ✅ Better agents for specific domains
- ✅ More efficient token usage

**Tool Execution:** Now JARVIS can:
- Read existing code before writing new code
- Run tests to validate output
- Fix errors by analyzing actual error messages
- Save important findings to memory

This is the transition from "advisor" to "builder."

---

## Testing Strategy

**Unit Tests:**
- TaskDecomposer correctly routes task types
- Each specialized agent works independently
- Tool framework executes safely

**Integration Tests:**
- Full pipeline for different task types
- Tool integration with agents
- Memory integration

**End-to-End Tests:**
- "Write a function" → produces working code
- "Debug this error" → identifies and fixes root cause
- "Explain this" → clear explanation

---

## Timeline

**When you test Phase 0 on your PC:**
1. Phase 0 vertical slice should work ✅
2. Phase 1 code will be complete and ready for integration
3. We'll discuss which task type to tackle first

**Next conversation:** "JARVIS Phase 0 works, here's the confidence score. Want to start integrating Phase 1?"

---

## Files in Development

```
JARVIS/
├── src/
│   ├── core/
│   │   ├── task-decomposer.ts    ✅ COMPLETE
│   │   └── (existing files)
│   ├── agents/
│   │   ├── specialized-agents.ts ✅ COMPLETE
│   │   └── (existing files)
│   └── tools/
│       ├── types.ts              ✅ COMPLETE
│       └── file-tools.ts         ✅ COMPLETE
└── PHASE-1.md                    ✅ THIS FILE
```

---

## What Stays the Same

- Database schema (Drizzle ORM)
- Model provider abstraction
- Agent interface and base implementation
- Memory layer
- Audit trail
- $0 cost guarantee
- TypeScript/Bun stack

Everything in Phase 0 is still valid. Phase 1 builds on it, not replaces it.

---

## Next Steps (After Phase 1)

**Phase 2: JARVIS Developer**
- Codebase understanding agent
- Repository navigation
- Test runner
- Debugger integration
- **Milestone:** JARVIS can meaningfully contribute to building itself

**Phase 3: Natural Interface**
- Voice input (Whisper)
- Voice output (Piper)
- Wake word detection
- **Milestone:** Talk naturally to JARVIS

**Phase 4: Perception**
- Vision/camera support
- Screen awareness
- Location tracking
- **Milestone:** JARVIS knows what's around you

---

**Phase 1 will be ready for review and integration when you get home.**
