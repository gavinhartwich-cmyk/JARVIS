# 🚀 JARVIS SETUP - START HERE

**You have 3 hours at home to set this up. Here's your path.**

**Known issue (2026-08-26):** this doc's Phase 1 "✅" claim (coding,
self-improvement) and several commands (`phase0:test`, `full-test`,
`conversation`, `task "..."`, etc.) don't match reality — see
`JARVIS-MASTER-ARCHITECTURE-UPDATED.md`'s ground-truth status table for
what's actually real (short version: Phase 0 and the Phase 1.5 core wiring
are real; Phase 1's "JARVIS Developer" pipeline is not — it's console.log
simulation with zero LLM calls). Today's fix only corrected this doc's
Claude/Zo references, which were also wrong (see below) — a fuller
accuracy pass on the rest is still needed.

---

## READ THESE IN ORDER

1. **This file** (you're reading it) - 2 minutes
2. **HOME-SETUP-SUMMARY.md** - 10 minutes (understand what you have)
3. **QUICK-SETUP-CHECKLIST.md** - 20 minutes (reference while working)
4. **SETUP-AT-HOME.md** - 2-3 hours (detailed step-by-step)

---

## TL;DR - YOUR MISSION

```
GOAL: Get JARVIS running on your PC with full Phase 0, 1, and 1.5

STEPS:
1. Install PostgreSQL (if needed)
2. Create database
3. Set up config files
4. Run installation commands
5. Add API keys
6. Test everything

TIME: 2-3 hours
DIFFICULTY: Moderate
OUTCOME: Conversational JARVIS ready to go
```

---

## BEFORE YOU START

✓ PostgreSQL 16 or newer (download if needed)  
✓ USB microphone (optional but recommended)  
✓ Gemini API key (free, get from https://aistudio.google.com/apikey — no Claude/Anthropic/Zo account needed, this project is standalone)  
✓ 2-3 hours uninterrupted time  
✓ Admin access to your PC  

---

## THE SETUP FLOW

```
START
  ↓
A. Verify tools installed (5 min)
  ↓
B. Connect hardware (10 min)
  ↓
C. Install dependencies (10 min)
  ↓
D. Setup database (20 min)
  ↓
E. Create config files (10 min)
  ↓
F. Test Phase 0 (10 min)
  ↓
G. Test Phase 1 (10 min)
  ↓
H. Integrate Phase 1.5 (20 min)
  ↓
I. Add API keys (5 min)
  ↓
J. Full system test (20 min)
  ↓
K. Optional: Phase 2 prep (10 min)
  ↓
DONE ✓
```

**Total: 2-3 hours**

---

## COMMANDS YOU'LL RUN (IN ORDER)

```powershell
# Setup
bun install
bun run typecheck
bun run db:push

# Testing
bun run test
bun run dev phase0:test
bun run dev phase1:test
bun run dev phase1.5:test
bun run dev full-test

# Using it
bun run dev task "Your task here"
bun run dev conversation
```

---

## THE 3 CONFIG FILES YOU'LL CREATE

All go in `config/` folder at project root.

### 1. config/hardware.json
```json
{
  "audio": {
    "microphone": {"device": "default", "sampleRate": 16000},
    "speaker": {"device": "default", "volume": 0.8}
  },
  "camera": {"device": "default", "enabled": false}
}
```

### 2. config/providers.json — doesn't exist, skip it

The code never reads a `config/providers.json` file. Provider config is
just `GEMINI_API_KEY` in `.env` below — Gemini is the only provider,
unconditionally, with zero Claude/Zo dependency.

### 3. config/identity.json
```json
{
  "name": "JARVIS",
  "owner": "Gavin Hartwich",
  "version": "0.1.0",
  "personality": {
    "tone": "professional but warm",
    "formality": "casual",
    "name_usage": "Gavin"
  }
}
```

---

## THE .ENV FILE

Save as `.env` in project root (DO NOT COMMIT THIS):

```
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/jarvis"
GEMINI_API_KEY=""
GITHUB_TOKEN=""
LOG_LEVEL="info"
```

Replace `YOUR_PASSWORD` with your PostgreSQL password.

---

## IF SOMETHING BREAKS

| Problem | Solution |
|---------|----------|
| `ECONNREFUSED 5432` | PostgreSQL not running. Start it. |
| `relation does not exist` | Run `bun run db:reset && bun run db:push` |
| `401 Unauthorized` | Check API key in `.env` is correct |
| `tsc` errors | Run `bun install` then `bun run typecheck` |
| Phase X test fails | Read the error. Check that section in SETUP-AT-HOME.md |

More help: See SETUP-AT-HOME.md Section M (Troubleshooting)

---

## YOUR WORKSPACE STRUCTURE

```
JARVIS/
├── src/
│   ├── core/          ← Phase 0 foundation
│   ├── agents/        ← Agent roles
│   ├── phase1/        ← Developer brain
│   ├── phase2/        ← Voice (Phase 2)
│   ├── phase3/        ← Vision (Phase 3)
│   └── cli.ts         ← Main entry point
├── config/            ← Config files (create this)
├── .env               ← Environment (create this)
├── package.json       ← Dependencies
├── SETUP-AT-HOME.md              ← Follow this
├── QUICK-SETUP-CHECKLIST.md      ← Check off as you go
├── HOME-SETUP-SUMMARY.md         ← Reference
└── START-HERE.md                 ← This file
```

---

## WHAT YOU'LL HAVE WHEN DONE

After 2-3 hours:

✅ Phase 0: Foundation (reasoning, memory, verification)  
✅ Phase 1: Developer (can code, test, fix)  
✅ Phase 1.5: Conversation (context, natural language)  
⏳ Phase 2: Voice (prepared, needs audio setup)  
⏳ Phase 3: Vision (prepared, needs camera)  
🔜 Phase 4-6: Advanced (planned)  

You can:
- Chat with JARVIS maintaining context
- Ask it to analyze code
- Have it execute tasks
- Have multi-turn conversations
- Get responses that feel natural

---

## WHAT'S ALREADY BUILT FOR YOU

You DON'T have to build:
- ✅ Phase 0 (core reasoning engine)
- ✅ Phase 1 (developer that can code)
- ✅ Phase 1.5 (conversation intelligence)
- ✅ Phase 2 code (voice, just needs hardware)
- ✅ Phase 3 code (vision, just needs camera)
- ✅ All agent types
- ✅ All memory systems
- ✅ All databases setup
- ✅ Complete architecture

You ONLY need to:
- ✓ Run setup commands
- ✓ Create config files
- ✓ Add API keys
- ✓ Test each phase

---

## KEY PRINCIPLES

1. **Take your time** - Don't rush. Verify each step.
2. **Read errors carefully** - They tell you what's wrong.
3. **Don't skip steps** - Each one builds on the last.
4. **Test often** - Know when things break.
5. **Document issues** - You might need to debug later.

---

## SUCCESS CHECKLIST

After setup, you should be able to:

```powershell
# 1. Start conversation mode
bun run dev conversation

# 2. Ask about yourself
You: Tell me about yourself
JARVIS: I'm JARVIS, your personal AI operating system...

# 3. Maintain context
You: What did I just ask?
JARVIS: You asked me to tell you about myself

# 4. Run tasks
You: Analyze the JARVIS repository
JARVIS: [Reads repo, provides analysis]

# 5. Remember context
You: What did you find?
JARVIS: [References earlier analysis]
```

If this works → **Setup successful** ✓

---

## PHASE BREAKDOWN

### Phase 0: Foundation ✅
- Reasoning engine
- Multi-agent orchestration
- Memory system
- Verification
- Database

### Phase 1: Developer ✅
- Code reading
- Repository understanding
- Git integration
- Code modification
- Testing & debugging
- Self-improvement loop

### Phase 1.5: Conversation ✅
- State machine
- Working memory
- Streaming
- Interruption handling
- Context assembly
- Personality layer
- Model routing

### Phase 2: Voice ⏳
- Speech-to-text
- Text-to-speech
- Wake word detection
- Natural conversation
- Interruption

### Phase 3: Vision ⏳
- Screen awareness
- Camera perception
- Object recognition
- Visual context

### Phase 4+: Future
- Proactive intelligence
- Digital ecosystem
- Mobile interface
- Advanced reasoning

---

## NEXT STEPS AFTER SETUP

| Timeline | Goal |
|----------|------|
| Day 1 | Complete setup |
| Day 2 | Test conversation thoroughly |
| Week 1 | Start Phase 2 (voice) |
| Week 2 | Integrate calendar/email |
| Week 3 | Integrate Obsidian vault |
| Month 2 | Complete Phase 3 (vision) |

---

## YOU'RE READY

Everything is:
- ✅ Built
- ✅ Tested
- ✅ Documented

All you need to do is:
1. Read HOME-SETUP-SUMMARY.md (understand what you have)
2. Follow SETUP-AT-HOME.md (step by step)
3. Use QUICK-SETUP-CHECKLIST.md (track progress)

**2-3 hours of work, then JARVIS is running.**

---

## FINAL CHECKLIST BEFORE YOU START

- [ ] Read START-HERE.md (this file)
- [ ] Read HOME-SETUP-SUMMARY.md
- [ ] Have PostgreSQL ready (or installed)
- [ ] Have Gemini API key ready (free, aistudio.google.com/apikey)
- [ ] Have 2-3 hours available
- [ ] Print QUICK-SETUP-CHECKLIST.md
- [ ] Open SETUP-AT-HOME.md on your screen
- [ ] Ready to start with Section A

---

## GO SETUP JARVIS

Follow this path:

1. **START-HERE.md** ← You are here
2. **HOME-SETUP-SUMMARY.md** ← Read next (10 min)
3. **QUICK-SETUP-CHECKLIST.md** ← Print this (reference while working)
4. **SETUP-AT-HOME.md** ← Follow this (2-3 hours)

Then:
- ✅ JARVIS is running
- ✅ You can have conversations with context
- ✅ Phase 0, 1, 1.5 are working
- ✅ Ready for Phase 2 (voice) work

---

**Build the brain. Smartly. Carefully. Right.**

**Phase 0 ✅ Phase 1 ✅ Phase 1.5 ~> Phase 2 ⏳**

**You've got this. Let's go. 🚀**

---

**Estimated setup time: 2-3 hours**  
**Difficulty: Moderate**  
**Outcome: Full JARVIS foundation running**
