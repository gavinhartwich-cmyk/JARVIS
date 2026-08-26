# JARVIS — Personal AI Operating System

**Phase 0: Foundation Build**

A local Windows desktop application with an intelligent core capable of:

- Multi-agent orchestration with isolated agent contexts
- Persistent structured memory (PostgreSQL)
- Explicit confidence & verification tracking
- Model-agnostic provider abstraction
- Complete audit trail of all reasoning

## Architecture Overview

```
                    JARVIS Core
                       │
        ┌──────────────┼──────────────┐
        │              │              │
    ORCHESTRATOR   MODEL PROVIDER   AGENTS
        │              │              │
        └──────────────┼──────────────┘
                       │
              ┌────────┼────────┐
              │        │        │
          MEMORY    AUDIT   VERIFICATION
              │        │        │
              └────────┼────────┘
                       │
                  PostgreSQL
```

## Setup Instructions

### Prerequisites

- Windows 10/11
- Bun (https://bun.sh)
- PostgreSQL 16+ (https://www.postgresql.org/download/windows/)

### 1. Install PostgreSQL on Windows

1. **Download PostgreSQL 16+**
   - Go to https://www.postgresql.org/download/windows/
   - Download the Windows installer

2. **Run the installer**
   - Accept defaults
   - When prompted for a password for the `postgres` user, **remember this password**
   - Keep the port as 5432

3. **Create the JARVIS user and database**

   Open Command Prompt or PowerShell and run:

   ```bash
   psql -U postgres
   ```

   Enter the postgres password when prompted, then:

   ```sql
   CREATE ROLE jarvis WITH LOGIN PASSWORD 'jarvis';
   CREATE DATABASE jarvis OWNER jarvis;
   ```

   Then type `\q` to exit.

4. **Verify the connection**

   ```bash
   psql -U jarvis -d jarvis
   ```

   You should see the `jarvis=#` prompt. Type `\q` to exit.

### 2. Set Environment Variables

Create a `.env` file in the JARVIS root directory:

```
DATABASE_URL=postgresql://jarvis:jarvis@localhost:5432/jarvis
GEMINI_API_KEY=your_gemini_api_key_here
```

**To get your Gemini API key (free, no Zo/Claude/Anthropic account needed):**

1. Go to https://aistudio.google.com/apikey
2. Sign in with any Google account
3. Click "Create API key"
4. Copy the key and paste it into `.env` as `GEMINI_API_KEY`

**Provider fallback (no `.env` changes needed to benefit from it):** JARVIS
now routes every LLM call through a gateway (`src/models/llm-gateway.ts`)
that tries Gemini first and automatically falls back to a local Ollama
server if Gemini fails or its free daily quota runs out — no more "pipeline
dead for the day" on a 429. To turn the fallback on:

```bash
# Windows: https://ollama.com/download
ollama pull qwen2.5-coder:1.5b   # small enough for a 4GB-VRAM card; override with OLLAMA_MODEL
ollama serve
```

Nothing else to configure — the gateway detects Ollama automatically when
it's running. A third optional provider, OpenRouter, joins the rotation
only if you set `OPENROUTER_API_KEY` in `.env` (get one free at
https://openrouter.ai/keys).

### 3. Install Dependencies & Create the Schema

```bash
cd JARVIS
bun install
bun run db:push
```

`db:push` creates the six tables (`tasks`, `memories`, `agent_runs`, `audit_events`,
`verification_runs`, `user_context`) that the app expects to already exist —
skipping this step means `bun run dev` will fail with "relation does not
exist" errors as soon as an agent tries to write anything.

### 4. Run Phase 0 Vertical Slice

```bash
bun run dev
```

This will:
- Connect to PostgreSQL
- Initialize the model provider
- Register all agents
- Run a test task through the full pipeline
- Store results and memory

You should see output like:

```
🤖 JARVIS Phase 0 - Initialization

📦 Initializing database...
✓ Connected to PostgreSQL

🧠 Initializing model provider...
🎼 Initializing orchestrator...
👥 Registering agents...
   ✓ Researcher
   ✓ Reasoner
   ✓ Critic
   ✓ Fact Checker
   ✓ Synthesizer

🚀 RUNNING VERTICAL SLICE TEST
...
✅ VERTICAL SLICE TEST PASSED
```

## Architecture Details

### Layer 1: Brain (Model Abstraction)

JARVIS is model-agnostic, standalone, and never depends on Claude or Zo in any form. Currently using Gemini (Google's free tier, direct REST call), with room to swap in:
- Local models (Ollama, llama.cpp) — planned, not yet built
- Other providers, if ever wanted — but never as a required dependency

### Layer 2: Verification & Multi-Agent

Each major task runs through specialized agents:

- **Researcher** — Gather information
- **Reasoner** — Solve the problem
- **Critic** — Find flaws
- **Fact Checker** — Verify claims
- **Synthesizer** — Combine results

Each agent:
- Has isolated context
- Produces confidence scores
- Contributes to verification status

### Layer 3: Memory

Persistent PostgreSQL database with:

- **Fact memories** — Important information
- **Episode memories** — What happened
- **Semantic memories** — What JARVIS knows
- **Preferences** — User preferences
- **Projects/Goals** — Active objectives

Retention strategy: ACTIVE → DORMANT → ARCHIVED

### Layer 4: Agent System

Central orchestrator manages:
- Agent sequencing
- Information flow
- Conflict detection
- Resource allocation

### Layer 5: Tools & World Interface

Phase 0: Minimal tool support
Phase 1+: File system, APIs, external services

## File Structure

```
JARVIS/
├── src/
│   ├── cli.ts                 # Entry point
│   ├── core/
│   │   ├── orchestrator.ts    # Central coordinator
│   │   ├── audit.ts           # Audit trail
│   │   └── memory.ts          # Memory layer
│   ├── agents/
│   │   ├── types.ts           # Agent interface
│   │   └── agent.ts           # Base agent
│   ├── models/
│   │   ├── types.ts           # Model provider interface
│   │   └── gemini-provider.ts # Gemini implementation (sole active provider)
│   ├── db/
│   │   ├── schema.ts          # Drizzle schema
│   │   └── client.ts          # Database connection
│   └── tests/                 # Unit/integration tests
├── package.json
├── tsconfig.json
└── README.md
```

## Next Steps (Phase 1+)

1. **More specialized agents** (Tester, Debugger, etc)
2. **Task persistence** (resume interrupted tasks)
3. **Tool execution support** (files, APIs, commands)
4. **Richer context management**
5. **Local model support** (Ollama integration)

## Troubleshooting

### PostgreSQL connection fails

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Solution:**
- Is PostgreSQL running? Start it from Services (Windows)
- Is the connection string correct? Check `.env` and the error message
- Try: `psql -U jarvis -d jarvis` to test manually

### Database doesn't exist

```
Error: database "jarvis" does not exist
```

**Solution:**
- Run the PostgreSQL setup commands in "Install PostgreSQL" section above
- Verify: `psql -U postgres -l` should list "jarvis"

### Gemini API key not working

```
⚠ Gemini provider not available. Check its API key env var is set.
```

**Solution:**
- Verify your `GEMINI_API_KEY` is set in `.env`
- Get a new key (free) from https://aistudio.google.com/apikey
- Ensure `DATABASE_URL` is correct — the vertical slice test needs a working Postgres connection independent of the model provider

## Development

```bash
# Run the CLI
bun run dev

# Build for production
bun run build

# Run tests
bun test

# Run tests with live AI calls (use sparingly)
bun run test:live
```

## Cost & Dependencies

**Phase 0 guarantees:**
- ✅ $0 additional cost (PostgreSQL is free)
- ✅ No paid cloud hosting required
- ✅ No subscription dependencies
- ✅ Runs entirely locally on Windows PC
- ✅ Standalone — zero Claude, Anthropic, or Zo dependency anywhere in the codebase; Gemini's free tier is the only active cloud path, and local models (Ollama) are the planned $0-with-no-API-key path

## Project log

- **2026-08-25 — Phase 1 integration complete: Dynamic task routing + 13 specialized agents**
  Integrated TaskDecomposer into Orchestrator to replace fixed pipeline with dynamic routing.
  System now analyzes task type and selects appropriate agent sequence:
  - **Code writing** → architect → coder → tester → code-reviewer → security-reviewer → synthesizer
  - **Debugging** → error-analyzer → debugger → tester → code-reviewer → synthesizer
  - **Explanation** → researcher → explainer → simplifier → synthesizer
  - **Planning** → architect → planner → critic → verifier → synthesizer
  - **Research** → researcher → synthesizer
  - Plus 5 more task types handled intelligently.
  
  All 18 agents now registered (5 Phase 0 core + 13 Phase 1 specialized). Type checking passes.
  TaskDecomposer routing verified working correctly for all task types. Ready for Zo API integration
  when ZO_API_KEY is set. Files: task-decomposer.ts, specialized-agents.ts, orchestrator.ts, cli.ts

- **2026-08-25 — vertical slice actually run and verified, one real bug found and fixed.**
  `schema.ts` imported a symbol named `enum` from `drizzle-orm/pg-core` — that
  export doesn't exist (the real name is `pgEnum`); this crashed on the very
  first line of the very first run with `SyntaxError: Export named 'enum' not
  found`, despite the repo being marked "production-ready" and "everything is
  checked into GitHub." Fixed the import, and separately discovered `bun run
  dev` also needs the schema pushed to Postgres first (`bun run db:push`) —
  the original `db:push` script pointed at a migration file that was never
  created, so it's now wired directly to `drizzle-kit push` instead (added
  `drizzle.config.ts`; also bumped `drizzle-orm`/`drizzle-kit` to matching
  current versions, since the originally pinned ones were incompatible with
  each other). README's setup steps updated to include the schema-push step.
  With both fixed, the full 5-agent vertical slice was run for real —
  Postgres tables created, all 6 agent stages executed against live Zo/Claude
  calls, task/memory/audit rows confirmed persisted in the database, task
  completed with `partially_verified` status at 70% confidence. Phase 0 is
  now proven working, not just claimed working.
- **Postgres now runs persistently in Zo itself**, not only "when Gavin sets
  it up on his Windows PC" — registered as an internal Zo service
  (`jarvis-postgres`, process-mode, not publicly exposed) with the `jarvis`
  role/database already created. This is what makes the twice-daily
  `JARVIS Phase 0 Vertical Slice Test Report` automation able to actually
  succeed instead of failing on a missing database every run — it only
  still needs `DATABASE_URL` and `ZO_API_KEY` added as Zo secrets (Settings
  > Advanced). Running it on an actual Windows PC instead/as well still
  works exactly as documented above if that's ever wanted.

- **2026-08-26 — All Claude/Zo dependencies removed; project is now genuinely standalone.**
  `src/models/claude-provider.ts` deleted outright (it made `ZO_API_KEY`
  calls to `api.zo.computer/zo/ask`). `cli.ts` no longer imports or can
  fall back to it — Gemini is the only provider, unconditionally.
  `core/model-router.ts` had "claude"/`claude-haiku-4-5`/`claude-opus-5`
  hardcoded into every routing tier even though nothing ever selected
  Claude at runtime — replaced with Gemini throughout. `phase3/vision-system.ts`
  had two near-duplicate vision-provider stubs, one named `ClaudeVisionProvider`
  — merged into a single `GeminiVisionProvider` stub. Full-source grep for
  `zo|claude|anthropic` now returns zero dependency references (only
  explanatory comments stating the *absence* of a dependency). Confirmed
  `bun run typecheck` and `bun run dev test` both still run clean afterward.
  This README, the master architecture doc, and the active home-setup guides
  were corrected to match — `ZO_API_KEY`/Anthropic-key setup steps replaced
  with `GEMINI_API_KEY` (free at aistudio.google.com/apikey, no Zo or
  Anthropic account needed).

---

**Built to last. Built to think. Built to improve itself.**
