# JARVIS Phase 2 & 3 — When You're Home

**Target:** Get these done today, in sequence

---

## Phase 2: Voice Interface & Smart Routing (2-3 hours)

**Goal:** Make JARVIS talk. Whisper for input, Piper for output, wake word detection.

### 2.1: Speech-to-Text (Whisper)
```typescript
// src/voice/speech-to-text.ts
- Integrate OpenAI Whisper (via Zo API or local ollama)
- Listen for audio input
- Transcribe to text
- Pass to orchestrator
```

**What you'll do:**
1. Add Whisper to package.json (via Zo API)
2. Create speech-to-text module
3. Wire into CLI: listen → transcribe → orchestrate

**Duration:** 45 min

### 2.2: Text-to-Speech (Piper)
```typescript
// src/voice/text-to-speech.ts
- Use Piper TTS for natural voice output
- Generate audio from JARVIS responses
- Play through speakers
```

**What you'll do:**
1. Set up Piper (it's free, local, runs on GPU)
2. Create TTS module
3. Wire synthesizer output to TTS

**Duration:** 45 min

### 2.3: Wake Word Detection
```typescript
// src/voice/wake-word.ts
- Detect "Hey JARVIS" or custom wake word
- Use Picovoice Porcupine (free tier) or local model
- Only listen when triggered
```

**What you'll do:**
1. Set up wake word detection library
2. Create listener that waits for wake word
3. Trigger orchestration when heard

**Duration:** 30 min

**Result:** Speak naturally to JARVIS, hear it respond ✅

---

## Phase 3: Environment Awareness (1-2 hours)

**Goal:** JARVIS knows what's around you. Cameras, location, smart home.

### 3.1: Camera / Screen Awareness
```typescript
// src/vision/camera.ts
// src/vision/screen-capture.ts
- Webcam input for object recognition
- Screen capture for context understanding
- Show JARVIS what you're looking at
```

**Hardware you'll need:**
- Webcam (USB, or built-in laptop camera)

**What you'll do:**
1. Set up camera input (webcam)
2. Create vision module
3. Let agents see what you see before giving advice

**Duration:** 45 min

### 3.2: Location Tracking
```typescript
// src/location/tracker.ts
- Know which room you're in
- Use BLE beacons, WiFi triangulation, or manual location
- Adapt responses based on location ("You're in the workshop")
```

**Hardware you'll need:**
- BLE beacons (optional, or use phone location)

**What you'll do:**
1. Implement location detection (phone location via Zo API)
2. Store location in context
3. Agents reference location in responses

**Duration:** 30 min

### 3.3: Smart Home Integration (Future)
- Control lights, speakers, thermostats
- (Can be tackled after everything else works)

**Result:** JARVIS is aware of its environment ✅

---

## Implementation Order (Today)

1. **Phase 2.1:** Whisper (listen)
2. **Phase 2.2:** Piper (speak)
3. **Phase 2.3:** Wake word (smart listening)
4. **Phase 3.1:** Camera (see)
5. **Phase 3.2:** Location (know where)

**Estimated total time:** 3-4 hours

---

## What's Already Done

✅ Phase 0: Multi-agent orchestration
✅ Phase 1: Dynamic task routing + 13 specialized agents
✅ Phase 1.5: Tool execution (read files, write files, run commands)

**You have the brain. Now add the ears, mouth, and eyes.**

---

## Quick Setup Checklist

When you get home, you'll need:

**Software:**
- [ ] Whisper API key (from Zo or local Ollama)
- [ ] Piper installed (`pip install piper-tts`)
- [ ] Wake word detection library

**Hardware:**
- [ ] Microphone (USB or built-in)
- [ ] Speaker system (or headphones)
- [ ] Webcam (USB or built-in laptop camera)
- [ ] Optional: BLE beacons for room detection

**GPU:** Your 1650 Super will handle:
- Whisper transcription ✅
- Piper TTS ✅
- Vision models ✅
- All happening simultaneously ✅

---

## Architecture After Phase 3

```
                      YOU
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
     Microphone     Webcam        Location
        │              │             │
        ▼              ▼             ▼
   Whisper → Orchestrator → Piper
(transcript)   (reasoning)  (speech)
        │
        └─→ Context: [location, what you see, what you're doing]
        
   JARVIS now has: EARS, BRAIN, MOUTH, EYES, LOCATION
```

---

## After Phase 3: Clapping Detection

Once voice works, you wanted clap detection to wake JARVIS (Iron Man style).

```typescript
// src/voice/clap-detection.ts
- Listen for acoustic signature of clapping
- Trigger "Hey JARVIS" → wake system
- Make it feel cinematic
```

**This is the cherry on top.** Can be Phase 4.

---

## Notes

- Keep the $0 cost guarantee (use free/open-source tools only)
- All new code runs on your Windows PC (Zo is just backup)
- Type checking must pass before committing
- Test each piece before moving to the next
- Commit after each phase completes

**By the end of today, JARVIS speaks, listens, and sees.**

Go build something awesome. 🚀
