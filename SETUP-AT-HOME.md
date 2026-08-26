# JARVIS Setup - Step-by-Step for Home

**Target:** Complete setup so JARVIS can run with full Phase 0 + Phase 1 + Phase 1.5 integration

**Estimated Time:** 2-3 hours first time (mostly waiting for installs)

**Difficulty:** Moderate (mostly copying configs and running commands)

---

## SECTION A: Pre-Setup Verification (15 minutes)

### Step A.1: Verify You Have Everything

Before starting, check you have:

```
✓ Windows PC with 16GB RAM (you mentioned this)
✓ Git installed locally (check: git --version)
✓ Bun installed locally (check: bun --version)
✓ 16GB microcontroller (for clap detection)
```

If any missing, install now before continuing.

### Step A.2: Verify Git Config

Open PowerShell and run:

```powershell
git config --global user.name
git config --global user.email
```

If either is empty, set them:

```powershell
git config --global user.name "Gavin Hartwich"
git config --global user.email "gavinhartwich@gmail.com"
```

---

## SECTION B: Hardware Setup (30 minutes)

### Step B.1: Microphone Setup

**Required for Phase 2 (Voice Interface)**

- [ ] Plug in USB microphone (or verify builtin if decent quality)
- [ ] Test microphone:
  - Windows Settings → Sound → Input devices
  - Verify microphone is recognized
  - Test recording (should see levels when you speak)
- [ ] Note the device name for later config

### Step B.2: Camera Setup (Optional but Recommended for Phase 3)

**Needed for Phase 3 (Vision/Perception)**

- [ ] Plug in USB webcam (or verify builtin)
- [ ] Test camera:
  - Windows Settings → Camera
  - Test with Camera app
  - Verify picture quality
- [ ] Note the device name for later config

### Step B.3: Speaker Setup

**Required for Phase 2 (Voice Responses)**

- [ ] Verify audio output device (speakers or headphones)
- [ ] Test audio:
  - Windows Settings → Sound → Output devices
  - Play test sound
  - Verify volume levels

---

## SECTION C: Software Environment (45 minutes)

### Step C.1: Verify Bun & Node

PowerShell:

```powershell
bun --version
bun run --version
```

Both should show versions. If not, install Bun first.

### Step C.2: Navigate to JARVIS Folder

```powershell
cd C:\Users\YourName\Desktop  # Or wherever you cloned it
cd JARVIS
```

Verify you see:
- `src/` folder
- `package.json`
- `.git` folder
- `tsconfig.json`

### Step C.3: Install Dependencies

```powershell
bun install
```

Wait for it to complete (2-5 minutes). You should see:

```
✓ Installed 4 packages
```

### Step C.4: Verify TypeScript Compilation

```powershell
bun run typecheck
```

Should output nothing if clean, or list TypeScript errors if any exist.

**If errors exist:** Let them be for now. We'll fix them in Phase 1.5 integration.

---

## SECTION D: Database Setup (30 minutes)

### Step D.1: PostgreSQL Installation

PostgreSQL must be installed locally on your PC.

**If you don't have PostgreSQL:**

1. Download: https://www.postgresql.org/download/windows/
2. Install PostgreSQL 16 (latest)
3. During install:
   - Default port: `5432`
   - Password for `postgres` user: Set a strong password and **remember it**
   - Accept other defaults
4. Verify installation:
   ```powershell
   psql --version
   ```

**If you already have PostgreSQL:**

Just verify:
```powershell
psql --version
```

### Step D.2: Create JARVIS Database

Open PowerShell:

```powershell
psql -U postgres -c "CREATE DATABASE jarvis;"
```

It will prompt for the postgres password. Enter it.

Verify:
```powershell
psql -U postgres -c "\l" | findstr jarvis
```

Should show `jarvis` database listed.

### Step D.3: Create Environment File

In the JARVIS folder, create `.env` file:

```bash
# Database
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/jarvis"

# LLM Provider — Gemini is the only one JARVIS uses. Standalone project:
# no Claude, no Anthropic key, no Zo account, ever.
GEMINI_API_KEY="your-google-key-here"

# Hardware
MICROPHONE_DEVICE="default"
CAMERA_DEVICE="default"
SPEAKER_DEVICE="default"

# Settings
LOG_LEVEL="info"
```

**Replace:**
- `YOUR_PASSWORD` = postgres password you set
- Leave `GEMINI_API_KEY` empty for now (Section I covers getting it — free, from aistudio.google.com, no account beyond a Google login)
- Hardware devices can stay "default" for now

### Step D.4: Initialize Database Schema

```powershell
bun run db:push
```

Wait for completion. Should show:

```
✓ Pushed database successfully
```

**If it fails:** Check DATABASE_URL in `.env` is correct.

---

## SECTION E: Core Configuration (20 minutes)

### Step E.1: Create Config Files

Create `config/` folder in JARVIS root:

```powershell
mkdir config
```

### Step E.2: Hardware Config

Create `config/hardware.json`:

```json
{
  "audio": {
    "microphone": {
      "device": "default",
      "sampleRate": 16000,
      "channels": 1
    },
    "speaker": {
      "device": "default",
      "volume": 0.8
    }
  },
  "camera": {
    "device": "default",
    "enabled": false
  },
  "wakeWord": {
    "enabled": false,
    "model": "jarvis"
  }
}
```

### Step E.3: Provider Config

**Correction:** there is no `config/providers.json` — the code never reads
one. Provider selection is entirely env-driven: `GEMINI_API_KEY` (and
optionally `GEMINI_MODEL`, default `gemini-2.5-flash`) in `.env`, set in
Step D.3. Gemini is the only provider JARVIS uses; there's nothing to
configure here beyond that key. (Ollama/local is planned but has no
provider implementation yet — nothing to enable today.)

**2026-08-26 correction:** the default was originally `gemini-3.6-flash`
(Google's newest Flash model at the time this was written) — it turned
out to carry a free-tier quota of only 20 requests/day on a real project,
discovered by actually running the Phase 1 pipeline and hitting a 429.
Google doesn't publish exact free-tier daily quotas per model (they're
account-specific, viewable at https://aistudio.google.com/rate-limit) —
`gemini-2.5-flash` is the new default because older, non-preview Flash
models have historically carried much larger free daily allowances, but
check your own project's actual number at that URL rather than trusting
any fixed figure here or elsewhere.

### Step E.4: JARVIS Identity Config

Create `config/identity.json`:

```json
{
  "name": "JARVIS",
  "owner": "Gavin Hartwich",
  "version": "0.1.0",
  "personality": {
    "tone": "professional but warm",
    "formality": "casual",
    "name_usage": "Gavin",
    "proactivity": "balanced"
  },
  "security": {
    "identityThreshold": 0.95,
    "adminVerificationRequired": true,
    "auditAllActions": true
  }
}
```

---

## SECTION F: Phase 0 Verification (20 minutes)

### Step F.1: Run Phase 0 Tests

```powershell
bun run test
```

Wait for tests to complete. You should see:

```
✓ X tests passed
```

If any fail, note which ones but don't worry yet.

### Step F.2: Run Phase 0 Manually

```powershell
bun run dev phase0:test
```

You should see output like:

```
JARVIS initialized
Phase 0 core loaded
Orchestrator active
Database connected
All systems nominal
```

If you see this, Phase 0 is working ✓

---

## SECTION G: Phase 1 Verification (20 minutes)

### Step G.1: Verify Phase 1 Files Exist

Check that these files exist:

```
src/phase1/agents.ts ✓
src/phase1/developer.ts ✓
src/phase1/git.ts ✓
src/phase1/repository.ts ✓
src/phase1/index.ts ✓
```

All should be present.

### Step G.2: Run Phase 1 Test

```powershell
bun run dev phase1:test
```

You should see output showing:

```
Phase 1 Architect Agent loaded
Phase 1 Developer Orchestrator ready
Git integration active
Repository tools initialized
```

If you see this, Phase 1 is working ✓

### Step G.3: Simple Integration Test

```powershell
bun run dev phase1:demo
```

This will run a demo task (reading a repo). Should complete without errors.

---

## SECTION H: Phase 1.5 Integration (Start of Real Work - 45 minutes)

**IMPORTANT:** Phase 1.5 code exists but needs to be wired into the orchestrator.

### Step H.1: Verify Phase 1.5 Files Exist

Check these files exist:

```
src/core/conversation-intelligence.ts ✓
src/core/model-router.ts ✓
src/agents/types.ts ✓ (should have Conversational types)
```

All should exist.

### Step H.2: Check Orchestrator Current State

Open `src/core/orchestrator.ts` and search for "conversational" (case-insensitive).

**If NOT present:**
- Phase 1.5 is built but not wired in yet
- You need to integrate it (Step H.3-H.5)

**If present:**
- Phase 1.5 is already integrated
- Skip to Step H.6

### Step H.3: Add Phase 1.5 Import

In `src/core/orchestrator.ts`, near the top of imports, add:

```typescript
import { ConversationIntelligence } from "./conversation-intelligence";
import { ModelRouter } from "./model-router";
```

### Step H.4: Initialize Phase 1.5 in Orchestrator Constructor

Find the constructor section. Add this after other initializations:

```typescript
// Initialize Phase 1.5: Conversational Intelligence
this.conversationEngine = new ConversationIntelligence();
this.modelRouter = new ModelRouter();
this.conversationState = "IDLE";
this.conversationMemory = [];
```

Add these to the class properties at the top:

```typescript
conversationEngine: ConversationIntelligence;
modelRouter: ModelRouter;
conversationState: "IDLE" | "LISTENING" | "THINKING" | "SPEAKING" | "ERROR";
conversationMemory: any[];
```

### Step H.5: Wire Phase 1.5 into reasonAboutTask

Find the `reasonAboutTask` method. Before calling the LLM, add context assembly:

```typescript
// Assemble conversation context
const context = {
  workingMemory: this.conversationMemory.slice(-3),
  state: this.conversationState,
  environment: {
    timestamp: new Date(),
    userPresence: "at_pc"
  }
};

// Route to appropriate model based on task complexity
const modelChoice = await this.modelRouter.selectModel(task);

// Include context in prompt
const enrichedTask = {
  ...task,
  context,
  modelPreference: modelChoice
};
```

Then pass `enrichedTask` to the LLM instead of `task`.

### Step H.6: TypeScript Compilation Check

```powershell
bun run typecheck
```

If errors, you likely have a syntax issue. Fix it based on error message.

### Step H.7: Test Phase 1.5 Integration

```powershell
bun run dev phase1.5:test
```

Should output:

```
Phase 1.5: Conversational Intelligence loaded
Conversation engine initialized
Model router active
State machine ready
Streaming support active
```

If you see this, Phase 1.5 is working ✓

---

## SECTION I: API Keys Setup (20 minutes)

### Step I.1: (Removed) — this project never uses Claude or an Anthropic key

An earlier version of this guide told you to sign up at
console.anthropic.com for a `CLAUDE_API_KEY`. That was wrong — JARVIS is
standalone and has never depended on Claude, Anthropic, or Zo in any form.
There's nothing to do here; go straight to Step I.2.

### Step I.2: Get Gemini API Key (Required — this is the only provider)

1. Go to: https://makersuite.google.com/app/apikey
2. Create new API key (free)
3. Copy it
4. In `.env` file, set:
   ```
   GEMINI_API_KEY="AIzaSy..."
   ```

### Step I.3: Get GitHub Token (For Phase 1 - Developer Features)

1. Go to: https://github.com/settings/tokens
2. Create new token (classic or fine-grained)
3. Select `repo` scope
4. Copy token
5. In `.env` file, add:
   ```
   GITHUB_TOKEN="ghp_..."
   ```

### Step I.4: Verify API Keys Work

```powershell
bun run dev test
```

Look for this line near the top:

```
🧠 Initializing model provider (gemini)...
```

If it's followed by a warning (`Gemini provider initialized without API
key`), the key isn't picked up — double check `GEMINI_API_KEY` in `.env`.
If there's no warning, the key is loaded correctly.

---

## SECTION J: Full Integration Test (30 minutes)

### Step J.1: Run Full Pipeline Test

```powershell
bun run dev full-test
```

This runs a complete test that:
- Initializes Phase 0
- Tests Phase 1 (repository reading)
- Tests Phase 1.5 (conversation)
- Verifies all integrations

Wait for completion. Should see:

```
✓ Phase 0: Foundation OK
✓ Phase 1: Developer OK
✓ Phase 1.5: Conversation OK
✓ All integrations verified
```

### Step J.2: Test a Real Task

```powershell
bun run dev task "Analyze the JARVIS repository structure and tell me about the architecture"
```

JARVIS should:
1. Read the repository
2. Analyze the structure
3. Understand the architecture
4. Respond with analysis
5. Store memory of the analysis

This tests the full Phase 0 → Phase 1 → Phase 1.5 pipeline.

### Step J.3: Test Conversation Continuity

```powershell
bun run dev conversation
```

This starts an interactive conversation mode. Try:

```
You: Tell me about the JARVIS architecture
JARVIS: [responds]

You: What did I just ask?
JARVIS: [should reference previous turn]

You: What's the difference between Phase 0 and Phase 1?
JARVIS: [should maintain context]
```

If context carries between turns, Phase 1.5 is working ✓

---

## SECTION K: Phase 2 Preparation (Optional - 20 minutes)

**Only do this if Phase 0-1.5 are fully working**

### Step K.1: Verify Phase 2 Files

Check these files exist:

```
src/phase2/voice-interface.ts ✓
src/phase2/speech-recognizer.ts ✓
src/phase2/speech-synthesizer.ts ✓
src/phase2/voice-config.ts ✓
src/phase2/wake-word-detector.ts ✓
```

### Step K.2: Test Speech Recognition (if you have microphone connected)

```powershell
bun run dev phase2:test-stt
```

Speak into your microphone. Should transcribe what you said.

### Step K.3: Test Text-to-Speech

```powershell
bun run dev phase2:test-tts "Hello, I am JARVIS"
```

You should hear audio output.

**Note:** If Phase 2 tests fail, that's OK. You'll finish Phase 0-1.5 first.

---

## SECTION L: Final Checklist

After completing all sections, verify:

### Core Systems
- [ ] PostgreSQL is running and `jarvis` database exists
- [ ] `.env` file has DATABASE_URL and GEMINI_API_KEY set
- [ ] `config/` folder has hardware.json, identity.json (no providers.json — provider config is env-only, see Section E.3)
- [ ] `bun run typecheck` shows no errors

### Phase 0
- [ ] `bun run dev phase0:test` completes successfully
- [ ] Database is initialized with schema
- [ ] Audit logging works
- [ ] Memory system persists data

### Phase 1
- [ ] `bun run dev phase1:test` completes successfully
- [ ] Repository reading works
- [ ] Code analysis works
- [ ] Phase 1 agents initialize

### Phase 1.5
- [ ] `bun run dev phase1.5:test` completes successfully
- [ ] Conversation state machine works
- [ ] Context carries between turns
- [ ] Model routing works
- [ ] Streaming support is active

### Integration
- [ ] Full pipeline test passes
- [ ] Real task execution works
- [ ] Conversation mode maintains context

---

## SECTION M: Troubleshooting

### PostgreSQL Not Connecting

**Error:** `connect ECONNREFUSED 127.0.0.1:5432`

**Fix:**
```powershell
# Check if PostgreSQL is running
pg_isready

# If not running, start it:
"C:\Program Files\PostgreSQL\16\bin\pg_ctl.exe" -D "C:\Program Files\PostgreSQL\16\data" start
```

### API Key Issues

**Error:** `401 Unauthorized`

**Fix:**
1. Verify API key is correct in `.env`
2. No extra spaces or quotes
3. Restart terminal after changing `.env`
4. Verify the key has correct permissions at provider

### TypeScript Errors

**Error:** Various `tsc` errors

**Fix:**
1. Check which file is causing error
2. Verify imports are correct
3. Check for missing dependencies: `bun install`
4. Clear build artifacts: `rm -r dist/`

### Database Schema Issues

**Error:** `relation "table_name" does not exist`

**Fix:**
```powershell
bun run db:reset
bun run db:push
```

This will reset and recreate schema.

---

## SECTION N: Next Steps After Setup

Once everything passes:

### Immediate (Day 1-2)
- [ ] Finish Phase 1.5 integration if not done
- [ ] Test conversation in multiple scenarios
- [ ] Verify memory persistence works
- [ ] Run full pipeline test 3+ times

### Short Term (Week 1)
- [ ] Set up Obsidian vault integration (per earlier conversation)
- [ ] Begin Phase 2 (Voice Interface) implementation
- [ ] Test microphone quality
- [ ] Implement wake-word detection

### Medium Term (Weeks 2-4)
- [ ] Complete Phase 2 (Full voice interface)
- [ ] Integrate with Hartwich OS (your CRM)
- [ ] Add calendar/email integration
- [ ] Build Presence & Device Awareness layer

### Long Term (Months 2+)
- [ ] Phase 3: Vision & Perception
- [ ] Phase 4: Proactive Intelligence
- [ ] Phase 5: Digital Ecosystem
- [ ] Phase 6: Mobile Interface

---

## FINAL NOTES

**This is NOT a simple chatbot.**

By the end of this setup, you'll have:
- ✅ A reasoning engine (Phase 0)
- ✅ A developer that can code (Phase 1)
- ✅ Natural conversational intelligence (Phase 1.5)
- ⏳ Voice interface (Phase 2 - in progress)
- ⏳ Vision & perception (Phase 3 - planned)
- ⏳ Proactive autonomy (Phase 4 - planned)

Each phase builds on previous ones. Don't skip setup steps. When something fails, understand why before moving on.

**You're building JARVIS. Take your time. Build it right.**

---

**Status After Setup:** Phase 1.5 conversational intelligence ready to use  
**Next Phase:** Phase 2 (Voice Interface) when ready  
**Total Estimated Time:** 2-3 hours setup, then ongoing development

Let's go. 🚀
