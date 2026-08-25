# JARVIS Setup - Quick Checklist

**Print this and check off as you go**

---

## QUICK REFERENCE COMMANDS

Copy-paste these in order:

```powershell
# A. Verify tools
git --version
bun --version

# B. Navigate
cd path\to\JARVIS

# C. Install dependencies
bun install

# D. Create database
psql -U postgres -c "CREATE DATABASE jarvis;"

# E. Create .env file (see template below)

# F. Push database schema
bun run db:push

# G. Verify everything works
bun run typecheck
bun run test
bun run dev phase0:test
bun run dev phase1:test
bun run dev phase1.5:test
bun run dev full-test
```

---

## .ENV TEMPLATE

Save as `.env` in JARVIS root folder:

```
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/jarvis"
CLAUDE_API_KEY="sk-ant-..."
GEMINI_API_KEY="AIzaSy..."
GITHUB_TOKEN="ghp_..."
JARVIS_PROVIDER="auto"
LOG_LEVEL="info"
MICROPHONE_DEVICE="default"
CAMERA_DEVICE="default"
SPEAKER_DEVICE="default"
```

---

## CONFIG FILES TO CREATE

### config/hardware.json
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
  }
}
```

### config/providers.json
```json
{
  "defaultProvider": "auto",
  "providers": {
    "claude": {
      "enabled": true,
      "model": "claude-opus-5"
    },
    "gemini": {
      "enabled": false
    },
    "ollama": {
      "enabled": false,
      "baseUrl": "http://localhost:11434"
    }
  }
}
```

### config/identity.json
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

## SETUP CHECKLIST

### ✓ Section A: Pre-Setup
- [ ] Verify Git installed
- [ ] Verify Bun installed
- [ ] Verify Git configured with name and email
- [ ] Have 16GB+ free space

### ✓ Section B: Hardware
- [ ] Plug in microphone (or verify builtin)
- [ ] Test microphone in Windows Settings
- [ ] Plug in camera if available (optional)
- [ ] Verify speaker works

### ✓ Section C: Software
- [ ] Navigate to JARVIS folder
- [ ] Run `bun install`
- [ ] Run `bun run typecheck` (should be clean)

### ✓ Section D: Database
- [ ] PostgreSQL 16 installed
- [ ] Created `jarvis` database
- [ ] Created `.env` with DATABASE_URL
- [ ] Run `bun run db:push`

### ✓ Section E: Configuration
- [ ] Created `config/hardware.json`
- [ ] Created `config/providers.json`
- [ ] Created `config/identity.json`

### ✓ Section F: Phase 0 Test
- [ ] Run `bun run test`
- [ ] Run `bun run dev phase0:test`
- [ ] Phase 0 shows as working

### ✓ Section G: Phase 1 Test
- [ ] Run `bun run dev phase1:test`
- [ ] Run `bun run dev phase1:demo`
- [ ] Phase 1 shows as working

### ✓ Section H: Phase 1.5 Integration
- [ ] Checked Phase 1.5 files exist
- [ ] Checked orchestrator for "conversational"
- [ ] If not present: added Phase 1.5 integration
- [ ] Run `bun run typecheck` (should be clean)
- [ ] Run `bun run dev phase1.5:test`
- [ ] Phase 1.5 shows as working

### ✓ Section I: API Keys
- [ ] Added CLAUDE_API_KEY to `.env`
- [ ] Optionally added GEMINI_API_KEY
- [ ] Added GITHUB_TOKEN for Phase 1 features
- [ ] Run `bun run dev test:providers`
- [ ] Claude shows as OK

### ✓ Section J: Full Integration Test
- [ ] Run `bun run dev full-test`
- [ ] All phases show as OK
- [ ] Run `bun run dev task "..."`
- [ ] Task execution works
- [ ] Test conversation mode with context

### ✓ Section K: Phase 2 (Optional)
- [ ] Verified Phase 2 files exist (if doing this)
- [ ] Test STT: `bun run dev phase2:test-stt`
- [ ] Test TTS: `bun run dev phase2:test-tts "..."`

---

## FINAL VERIFICATION

After ALL checkboxes above are checked:

```powershell
# 1. Verify no TypeScript errors
bun run typecheck

# 2. Verify database is healthy
bun run dev test:db

# 3. Run full integration test one more time
bun run dev full-test

# 4. Test conversation with context
bun run dev conversation
# Type: "What is my name?" → Should respond with "Gavin"
# Type: "Tell me something about me" → Should have context

# 5. Commit your setup
git add config/ .env.example (NOT .env itself)
git commit -m "chore: local setup complete and verified"
git push origin main
```

---

## TROUBLESHOOTING QUICK FIXES

| Error | Quick Fix |
|-------|-----------|
| `ECONNREFUSED 5432` | PostgreSQL not running - start it |
| `relation does not exist` | Run `bun run db:reset && bun run db:push` |
| `401 Unauthorized` | Check API key is correct in `.env` |
| `tsc` errors | Check imports, run `bun install`, then `bun run typecheck` |
| `Phase X test fails` | Read error message carefully, check that section |

---

## YOU'RE DONE WHEN:

✅ All checklist items are checked  
✅ `bun run typecheck` is clean  
✅ `bun run dev full-test` passes  
✅ Conversation maintains context across turns  
✅ API providers are configured  
✅ Database is initialized  

**Then you can:**
- Start Phase 2 (Voice) work
- Integrate Obsidian vault
- Add more capabilities
- Let JARVIS start building itself

---

## IMPORTANT REMINDERS

🔴 **DO NOT:**
- Skip database setup
- Ignore TypeScript errors
- Commit `.env` file (has secrets)
- Modify Phase 0 code without understanding it
- Try to run Phase 2 before Phase 1.5 is working

🟢 **DO:**
- Take time on each section
- Verify each step works before moving on
- Read error messages carefully
- Ask questions if stuck
- Document any issues you find

---

**Total Time: 2-3 hours**

**You've got this. Build the brain. 🚀**
