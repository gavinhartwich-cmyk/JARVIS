# PHASE 1: LLM STRATEGY - PROVIDER-AGNOSTIC & $0-FIRST

**Date:** August 25, 2026  
**Correction:** Reworked to align with $0-first principle  
**Status:** Foundation rework in progress

---

## THE PROBLEM I MADE

I was planning to integrate Claude API exclusively. That violates the core principle:
- ❌ Would make JARVIS dependent on paid subscription
- ❌ Would violate $0-first requirement
- ❌ Would violate provider-agnostic principle
- ❌ Would break if Anthropic API changes

**This was wrong. Fixing it now.**

---

## THE RIGHT APPROACH

JARVIS needs:
1. ✅ Provider abstraction (multiple LLMs supported)
2. ✅ Free tier support (Gemini API free tier)
3. ✅ Local-only option (Ollama - completely free)
4. ✅ Optional paid providers (Claude, etc.)
5. ✅ Easy switching between providers

---

## PHASE 1 LLM ARCHITECTURE (CORRECTED)

```
JARVIS Core (Phase 1 Agent System)
            ↓
     Provider Abstraction
            ↓
    ┌───────┼───────┬─────────┐
    ▼       ▼       ▼         ▼
  Ollama  Gemini  Claude   Future
  (Free)  (Free)  (Paid)   Providers
  Local   API     API
```

**How it works:**
1. All agents call through provider abstraction
2. Abstraction routes to configured provider
3. Can switch providers by changing config
4. All providers return same interface

---

## RECOMMENDED: GEMINI API (Free Tier)

For Phase 1, use **Google Gemini API** (free tier):

**Why Gemini:**
- ✅ Free tier available (generous limits)
- ✅ Good reasoning capability
- ✅ Google's commitment to free tier
- ✅ No subscription required
- ✅ Easy to upgrade if needed

**Free tier limits:**
- 60 requests/minute
- Can use for entire Phase 1 development
- Upgradable if hitting limits

**Setup:**
```bash
# 1. Get free API key from Google AI Studio
# https://makersuite.google.com/app/apikey

# 2. Save in environment
export GEMINI_API_KEY="your-key-here"

# 3. JARVIS automatically uses it
```

---

## ALSO SUPPORT: OLLAMA (Completely Free, Local)

**Ollama** - Run LLMs on your PC (zero cost):

**Why Ollama:**
- ✅ Completely free (open source)
- ✅ Runs locally on your PC
- ✅ No internet required
- ✅ No subscriptions
- ✅ No external dependencies
- ✅ Your data stays on your machine
- ✅ Models: Llama 2, Mistral, etc.

**Setup:**
```bash
# 1. Download from https://ollama.ai
# 2. Install on Windows
# 3. Pull a model: ollama pull llama2
# 4. Run: ollama serve
# 5. JARVIS connects to local http://localhost:11434

# Done. Zero cost. Completely local.
```

**Trade-off:** Slower than cloud APIs, but completely free and local.

---

## PROVIDER ABSTRACTION DESIGN

```typescript
// Abstract provider interface
interface LLMProvider {
  name: string
  available(): Promise<boolean>
  
  // All agents use this
  call(prompt: string, options?: Options): Promise<string>
  
  // Streaming for long responses
  stream(prompt: string): AsyncIterator<string>
  
  // Model info
  getModels(): Promise<ModelInfo[]>
}

// Implementations
class GeminiProvider implements LLMProvider { }
class OllamaProvider implements LLMProvider { }
class ClaudeProvider implements LLMProvider { } // optional paid
class LocalModelProvider implements LLMProvider { } // future

// Selector
class ProviderSelector {
  // Tries providers in order until one works
  // Priority: ENV var → local Ollama → Gemini → Claude → Error
  
  static async getProvider(): Promise<LLMProvider>
}
```

---

## PRIORITY ORDER (Week 1 Rework)

1. **Build Provider Abstraction** (NEW)
   - Common interface for all LLMs
   - Provider selector
   - Error handling

2. **Implement Gemini Provider** (NEW)
   - Connect to free tier
   - Use for Phase 1 agents
   - Minimal cost
   - Easy fallback to Ollama

3. **Implement Ollama Provider** (NEW)
   - Local-only support
   - Zero cost alternative
   - For users without Gemini key

4. **Keep Claude Provider** (existing)
   - Optional for users with API key
   - Not required for core system
   - Upgradeable later

5. **Connect All Agents** (same as before)
   - Use abstraction
   - Not provider-specific
   - Can switch anytime

---

## FILES TO BUILD (Corrected Week 1)

### NEW: Provider Abstraction
```typescript
// src/phase1/providers/base.ts
export interface LLMProvider {
  call(prompt, options): Promise<string>
  stream(prompt): AsyncIterator<string>
}

// src/phase1/providers/selector.ts
export class ProviderSelector {
  static async getProvider(): Promise<LLMProvider>
}
```

### NEW: Gemini Implementation
```typescript
// src/phase1/providers/gemini.ts
export class GeminiProvider implements LLMProvider {
  // Use @google/generative-ai package (free)
  // Free API key from makersuite.google.com
}
```

### NEW: Ollama Implementation
```typescript
// src/phase1/providers/ollama.ts
export class OllamaProvider implements LLMProvider {
  // Connect to local http://localhost:11434
  // Zero cost, completely local
  // Supports Llama 2, Mistral, etc.
}
```

### KEEP: Agent Integration
```typescript
// src/phase1/llm-integration.ts
// Agents use ProviderSelector
// Not provider-specific
// Works with any LLM
```

---

## CONFIGURATION (User Flexibility)

```bash
# User can choose provider via environment

# Option 1: Use Gemini (free tier)
export JARVIS_PROVIDER=gemini
export GEMINI_API_KEY=your-key

# Option 2: Use local Ollama (zero cost)
export JARVIS_PROVIDER=ollama
# (Make sure ollama serve is running)

# Option 3: Use Claude (paid, optional)
export JARVIS_PROVIDER=claude
export ZO_API_KEY=your-key

# Option 4: Auto-detect (tries local first)
export JARVIS_PROVIDER=auto
# Priority: Ollama (local) → Gemini (free) → Claude (paid)
```

---

## GEMINI VS OLLAMA COMPARISON

| Aspect | Gemini (Free) | Ollama (Local) |
|--------|---------------|---|
| **Cost** | $0 (free tier) | $0 (open source) |
| **Setup** | Get API key | Download + install |
| **Speed** | Fast (cloud) | Slower (local) |
| **Privacy** | Data to Google | Data stays local |
| **Internet** | Required | Not required |
| **Quality** | Good | Good (Llama 2) |
| **Best for** | Production | Development/local |
| **Scaling** | Easy (paid) | Limited by PC |

**Recommendation:**
- **Phase 1 development:** Use Ollama (free, local, no limits)
- **When ready:** Switch to Gemini (fast, slightly better)
- **If needed:** Claude as premium option

---

## IMPLEMENTATION STEPS (Corrected Week 1)

### Step 1: Build Provider Abstraction
```bash
# Create abstract interface
src/phase1/providers/
├── base.ts          # LLMProvider interface
├── selector.ts      # ProviderSelector class
├── gemini.ts        # Gemini implementation
├── ollama.ts        # Ollama implementation
├── claude.ts        # Claude (keep existing)
└── index.ts         # Exports
```

### Step 2: Make Agents Provider-Agnostic
```typescript
// Instead of:
const provider = new ClaudeProvider()

// Do:
const provider = await ProviderSelector.getProvider()

// Now works with any LLM
```

### Step 3: Test Each Provider
```bash
# Test Gemini (if API key available)
JARVIS_PROVIDER=gemini bun run dev phase1

# Test Ollama (if local instance running)
JARVIS_PROVIDER=ollama bun run dev phase1

# Test auto-detection
JARVIS_PROVIDER=auto bun run dev phase1
```

### Step 4: Verify System Works
```bash
# Run full agent pipeline
# Should work with any configured provider
bun run dev phase1
```

---

## PACKAGES NEEDED

```json
{
  "dependencies": {
    "@google/generative-ai": "latest",  // Gemini (free)
    // Ollama: use fetch (built-in)
    // Claude: already installed
  }
}
```

**Cost:** $0 (all packages free/open source)

---

## SUCCESS CRITERIA (Corrected)

✅ Provider abstraction works  
✅ Gemini provider implemented  
✅ Ollama provider implemented  
✅ All agents use abstraction  
✅ Can switch providers via config  
✅ $0 cost for basic operation  
✅ Works locally and in cloud  
✅ Provider-agnostic architecture  

---

## WHAT THIS ENABLES

Once provider abstraction is built:

✅ Users can run JARVIS with zero cost (Ollama locally)
✅ Or use free tier (Gemini API)
✅ Or upgrade to paid (Claude) if they want
✅ Easy to add future providers
✅ Core system doesn't depend on any one LLM
✅ True $0-first, provider-agnostic system

---

## ALIGNMENT WITH MASTER PLAN

**Master Plan Requirements:**
- ✅ $0-first: Gemini free tier + Ollama local
- ✅ Provider-agnostic: Abstract interface supports any LLM
- ✅ Local-capable: Ollama runs completely on PC
- ✅ Human-controlled: Users choose which provider
- ✅ No external dependency: Works without Claude

**Master Plan Quote:**
> "Every important capability should have a free/local path."

✅ This design ensures that.

---

## NEXT STEPS (CORRECTED)

### This Week:
1. ❌ Remove Claude-only plan
2. ✅ Build provider abstraction
3. ✅ Implement Gemini provider (free)
4. ✅ Implement Ollama provider (local)
5. ✅ Connect all 6 agents to abstraction
6. ✅ Test with both providers

### User Choice:
- Run locally with Ollama: Cost = $0
- Run with Gemini free tier: Cost = $0
- Run with Claude: Cost = paid (optional)

---

## CRITICAL CORRECTION

**What I got wrong:** Planning Claude-only integration  
**Why it was wrong:** Violates $0-first principle  
**What's right:** Provider-agnostic with free options  
**What this means:** JARVIS is truly independent

---

## VISION (Corrected)

With this architecture:

**JARVIS is not dependent on any LLM provider.**

- Works with Gemini ✅
- Works with Ollama ✅
- Works with Claude ✅
- Works with future LLMs ✅
- Works completely locally ✅
- Works with zero cost ✅

**This is the $0-first, provider-agnostic JARVIS.**

---

**Status:** Phase 1 architecture corrected  
**Timeline:** Same (4 weeks, but right approach)  
**Principle:** $0-first, provider-agnostic, local-capable  
**Next:** Build provider abstraction framework

🚀 **Back on the right track**
