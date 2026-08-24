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
ZO_API_KEY=your_zo_api_key_here
```

**To get your Zo API key:**

1. Sign in at https://ev0.zo.computer
2. Go to Settings > Advanced
3. Create an Access Token in the "Access Tokens" section
4. Copy the token and paste it into `.env` as `ZO_API_KEY`

### 3. Install Dependencies & Initialize

```bash
cd JARVIS
bun install
```

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

JARVIS is model-agnostic. Currently using Claude via Zo API, but can swap in:
- Local models (Ollama, llama.cpp)
- Other providers (OpenAI, Anthropic direct, etc)

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
│   │   └── claude-provider.ts # Claude implementation
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

### Zo API key not working

```
⚠ Claude provider not available
```

**Solution:**
- Verify your `ZO_API_KEY` is set in `.env`
- Get a new token from https://ev0.zo.computer > Settings > Advanced > Access Tokens
- Ensure `DATABASE_URL` is correct (Zo API requires valid DB connection for Zo agent context)

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
- ✅ Claude/Zo is optional — can be replaced with local models

---

**Built to last. Built to think. Built to improve itself.**
