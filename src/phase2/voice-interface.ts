/**
 * Phase 2: Natural Voice Interface
 *
 * Complete voice interaction pipeline:
 * Microphone → Wake Word → Speech Recognition → JARVIS Core →
 * Response Generation → Text-to-Speech → Speaker
 */

import { WakeWordDetector, WakeWordEvent } from "./wake-word-detector";
import { SpeechRecognizer, RecognitionResult } from "./speech-recognizer";
import type { SynthesisResult, ISpeechSynthesizer } from "./speech-synthesizer";
import { createSpeechSynthesizer } from "./tts-provider";
import { VoiceConfig, DEFAULT_VOICE_CONFIG } from "./voice-config";
import { createDefaultGateway, GatewayModelProvider } from "../models/llm-gateway";
import type { ModelProvider } from "../models/types";
import { playWavBuffer, PlaybackInterruptedError } from "./audio-player";
import type { Orchestrator } from "../core/orchestrator";
import { JARVIS_PERSONALITY_PROMPT } from "../core/jarvis-personality";
import { normalizeNumbersForSpeech, splitIntoSentences } from "./text-normalizer";
import { spotifyWarmUp, spotifyShutdown } from "../core/spotify";

// Real end-of-turn detection (2026-08-30): nothing previously ever called
// speechRecognizer.stopStreaming() except VoiceInterface.stop() shutting
// the whole thing down - meaning a real mic feed would start a turn on
// wake word and then never finish it. Implements the master architecture
// doc's Part 5.3 "Silence Duration Rules": <500ms is never end-of-turn,
// 1000-2000ms is "likely end-of-sentence" (not acted on yet - true
// low-latency early response prep is a real future optimization, not
// built here), 3000ms+ is "definitely end of turn, respond" - this uses
// that top tier as the actual cutoff, since anything looser risks cutting
// the user off mid-sentence with no way yet to tell a thinking pause from
// a finished thought. maxTurnDuration (config.conversation.maxTurnDuration,
// default 300s) is a separate hard backstop against a stuck-open mic if
// the silence detector itself misses something (e.g. sustained background
// noise never reads as "silent").
const END_OF_TURN_SILENCE_MS = 3000;

// [ADDED 2026-09-02] Real, live-discovered bug, found while testing
// background/auto-run mode (start-jarvis.ps1): hitSilenceCutoff above
// requires turnHasSpeech to be true FIRST - correct for a normal turn,
// but if the wake word fires and NOTHING crosses the speech-energy
// threshold afterward (a false trigger on ambient noise, or Gavin just
// says "Jarvis" with no follow-up), turnHasSpeech never flips true and
// turnSilenceMs climbs forever with no cutoff, all the way to the full
// maxTurnDuration backstop (5 minutes by default) - confirmed live in a
// real background run's log, silence counting past 20+ seconds with
// "speech detected this turn: false" the whole way. That's a real problem
// specifically for the new pop-up-on-activity HUD behavior: the HUD would
// stay popped up (and the mic pipeline stuck mid-turn) for up to 5 real
// minutes after a single false wake-word trigger, not a quick recovery.
// A much shorter, separate timeout for this specific "never actually
// heard anything" case - handleUserSpeech() checks turnEndedWithNoSpeech
// (set when this fires) and skips generating a spoken reply entirely,
// since there's nothing real to respond to.
const NO_SPEECH_TIMEOUT_MS = 8000;

// [UPDATE 2026-08-30] A fixed RMS number here turned out not to
// survive contact with a real mic gain change: mic_capture.py's
// wake-word-triggered gain fix (audio.micGain) pushed real ambient
// background energy up to 2600-4000 in Gavin's actual room, well above
// the 500 this constant used to be - so every chunk read as "still
// speaking" and a turn could never end on silence (confirmed live:
// "silence: 0ms/3000ms" for over a minute straight). A fixed number
// can't work here at all, because it has no way to know what gain or
// room it's being compared against. Replaced with a threshold computed
// fresh per turn, in handleWakeWord(), from the real ambient energy
// actually measured during the idle listening window right before the
// wake word fired (see idleEnergyWindow below) - whatever the gain or
// room happens to be, "someone is talking" is now defined relative to
// what this exact mic just measured as quiet, not against a number
// tuned once and never revisited. FALLBACK_SPEECH_THRESHOLD is only
// used on the rare case a turn starts before any idle samples exist
// yet (e.g. the wake word fires within the first couple seconds of
// `listen` starting, before a full idle window has been collected).
const IDLE_NOISE_WINDOW_CHUNKS = 20; // ~5s of 250ms mic chunks - long enough to smooth over one loud blip, short enough to reflect the room right now
const SPEECH_ABOVE_FLOOR_MULTIPLIER = 2.5; // "speech" = at least this many times louder than the measured quiet floor, not a fixed absolute number
const MIN_SPEECH_THRESHOLD = 150; // absolute backstop under the floor - guards a near-dead-silent room from producing an unrealistically tiny threshold that any faint sound would cross
const FALLBACK_SPEECH_THRESHOLD = 500; // only used if a turn starts with zero idle samples collected yet - the old static guess, now a safety net instead of the primary mechanism

// [ADDED 2026-09-04] Real, live-found bug, per Gavin: "had to stop
// because im leaving but it took very long and didnt ge to play
// anything." Confirmed from his own log - NOT a repeat of the Spotify
// daemon slowness (that path actually responded fast and correctly:
// intent detected, "no active device" honestly reported almost
// immediately). The real holdup: after that spoken reply,
// startFollowUpListening() called beginActiveTurn() (which computes
// turnSpeechThreshold fresh from idleEnergyWindow) immediately - but
// idleEnergyWindow is ONLY ever refreshed while genuinely idle
// (processMicChunk()'s `!context.isActive` branch), and a follow-up turn
// skips that idle phase entirely (isSpeaking -> immediately active
// again, no real gap). Confirmed live in the log: one follow-up turn ran
// 129+ real seconds with "speech threshold: 1420" frozen the whole time
// while real measured energy climbed from ~1200 to ~4800 (the room's
// real ambient noise rising over the session) - meaning every follow-up
// turn all session long was reusing whatever idleEnergyWindow happened
// to hold from the very first wake-word trigger, never the room as it
// actually is now, so the 3s silence cutoff could never fire. Real fix:
// give the mic an explicit, bounded real window of genuinely current
// idle audio to refill idleEnergyWindow before recomputing the
// threshold - see startFollowUpListening(). Same ~5s duration as
// IDLE_NOISE_WINDOW_CHUNKS's own framing, kept consistent rather than
// inventing a shorter/weaker one. Disclosed, deliberate cost: every
// follow-up turn now waits this long after JARVIS stops speaking before
// it's really listening again, in exchange for silence detection
// actually working instead of a multi-minute stuck turn.
const FOLLOWUP_RECALIBRATION_MS = 5000;

/** Root-mean-square energy of a 16-bit PCM buffer - simple, real, cheap voice-activity signal (not a trained VAD model). */
function computeRmsEnergy(pcm16: Buffer): number {
  if (pcm16.length < 2) return 0;
  let sumSquares = 0;
  const sampleCount = Math.floor(pcm16.length / 2);
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcm16.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

// Real diagnostic (2026-08-31), per Gavin: "it also only wrote its
// response out... instead of saying it outloud" - playWavBuffer()'s
// PowerShell PlaySync() call completed with no error, so the failure
// (if it is one) isn't a crash - it's either a genuinely near-silent
// synthesized clip (a real Piper bug/config problem) or the audio
// playing out loud on a Windows output device Gavin isn't listening on
// (nothing wrong with the code, a Windows sound-settings issue). No way
// to tell those apart from here without hearing it, so this logs the
// real peak amplitude of what's about to be played - a healthy peak
// means look at Windows' default playback device; a near-zero peak
// means the synthesis step itself produced dead audio.
function computeWavPeakAmplitude(wav: Buffer): number {
  // Real RIFF chunk walk, not a hardcoded 44-byte header offset - Piper
  // writes a standard WAV file but this is cheap to do properly.
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    return -1; // not a WAV file we recognize - caller should treat this as "unknown," not "silent"
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      const dataStart = offset + 8;
      const dataEnd = Math.min(dataStart + chunkSize, wav.length);
      let peak = 0;
      for (let i = dataStart; i + 1 < dataEnd; i += 2) {
        const sample = Math.abs(wav.readInt16LE(i));
        if (sample > peak) peak = sample;
      }
      return peak / 32768;
    }
    offset += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  return -1; // no data chunk found
}

// [UPDATE 2026-08-31] Was a generic "helpful voice assistant" one-liner
// with zero real personality direction. Now uses the same shared
// movie-JARVIS spec every other system prompt in this codebase uses
// (see jarvis-personality.ts) - this is the direct/no-orchestrator
// fallback path (see generateResponse() below), so it matters just as
// much as the primary Orchestrator path that conversation-intelligence.ts
// handles.
const JARVIS_SYSTEM_PROMPT = JARVIS_PERSONALITY_PROMPT;

export interface VoiceInteractionContext {
  conversationId: string;
  messageHistory: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: Date;
  }>;
  lastWakeWordTime: Date;
  isActive: boolean;
}

export interface VoiceInteractionResult {
  userInput: string;
  jarvisResponse: string;
  audioOutput: Buffer;
  duration: number;
  timestamp: Date;
}

/**
 * Natural Voice Interface
 *
 * Orchestrates the complete voice interaction pipeline
 */
export class VoiceInterface {
  private config: VoiceConfig;
  private wakeWordDetector?: WakeWordDetector;
  private speechRecognizer?: SpeechRecognizer;
  private speechSynthesizer?: ISpeechSynthesizer;
  // [REMOVED 2026-09-02] Used to be a dedicated always-Piper synthesizer
  // for the filler acknowledgment, specifically so "one moment" stayed
  // fast even when the real reply used slow Chatterbox. Real, direct
  // feedback from Gavin after this caused genuine confusion in live
  // testing (a Piper-voiced filler being mistaken for "the whole reply
  // used the wrong voice", when Chatterbox had actually worked correctly
  // for the real reply moments later): "the piper voice isnt even a
  // voice and should not be an option." Per his explicit choice ("make
  // the filler the clone which then means its all the clone and theres
  // no difference"), the filler now just uses this.speechSynthesizer -
  // whatever's actually configured (Chatterbox by default) - see
  // ensureFillerAudio() below. Real, accepted trade-off: the filler is
  // no longer guaranteed-instant on a cold Chatterbox daemon, but the
  // TTS warm-up fix (this same session) means that's the rare case now,
  // not the common one, and Gavin explicitly prioritized voice
  // consistency over that.
  // Short "thinking" acknowledgment (2026-08-31), per Gavin: "it should
  // be responding while thinking so it seems faster instead of nothing"
  // - a real LLM call plus full TTS synthesis can take several real
  // seconds (measured live: ~2s of synthesis alone, on top of the LLM
  // round trip before it), during which nothing audible happened at all,
  // making a working pipeline feel broken/unresponsive. Synthesized
  // once per variant, lazily, and cached (see ensureFillerAudio()) -
  // only the first turn of each KIND pays the extra synthesis cost,
  // every turn after plays back almost instantly.
  //
  // [UPDATE 2026-09-03] Two real cached variants, not one - per Gavin:
  // "make it proportional to what it's actually doing." A quick plain
  // question and a request that's actually about to open an app/search
  // the web/click something real shouldn't get the same generic filler -
  // see ensureFillerAudio()'s own comment for how orchestrator.ts's new
  // guessIfRealActionNeeded() (free, instant, no LLM call) picks between
  // them before either is played.
  private fillerAudioQuick: SynthesisResult | null = null;
  private fillerAudioAction: SynthesisResult | null = null;
  private modelProvider: ModelProvider;

  private context: VoiceInteractionContext;
  private isRunning: boolean = false;
  // True while JARVIS's own reply is playing through the speakers - real
  // mic chunks are dropped entirely during this window (see
  // processMicChunk()) so JARVIS doesn't hear its own voice and either
  // re-trigger the wake word or feed itself into the speech recognizer.
  // Real acoustic echo cancellation would let listening continue safely
  // even during playback (the master doc's Part 5.1 full-duplex goal);
  // this half-duplex guard is the honest interim substitute, not a stand-in
  // that pretends to be that.
  //
  // [UPDATE 2026-09-02] Real, scoped barge-in support added - see
  // playInterruptible()/handleWakeWord() below. Mic chunks during
  // isSpeaking are no longer dropped entirely: they're routed
  // specifically to the wake-word detector (processMicChunk()), so
  // saying "Jarvis" again can interrupt JARVIS mid-speech. This is
  // deliberately NOT full arbitrary-speech interruption - that still
  // needs real acoustic echo cancellation (a genuinely harder problem,
  // still not attempted) to tell real user speech apart from JARVIS's
  // own voice bleeding into the mic. Reusing the wake-word detector
  // sidesteps that: it's already tuned to reject non-wake-word audio,
  // and JARVIS's own scripted replies don't say "Jarvis" as part of
  // normal conversation, so this is a real, working, honestly-scoped
  // interim step toward the master doc's full-duplex goal, not the
  // whole thing.
  private isSpeaking: boolean = false;
  // [ADDED 2026-09-03] Real feature, per Gavin: "i also want the ability
  // to aks him soemting mid thinking if i dont want the last response
  // anymore." Real gap found while building this: barge-in only ever
  // covered isSpeaking (real audio actually playing) - mic chunks during
  // the "thinking" gap itself (the LLM/app-control call in
  // handleUserSpeech(), after the filler finishes and before the real
  // reply starts playing) went to the ALREADY-STOPPED speech recognizer
  // and were silently discarded; the wake-word detector was never even
  // listening during that window, so there was no way to say "Jarvis"
  // and have it register at all. True the same way isSpeaking is true -
  // set right before the real generateAndRecordResponse() call starts,
  // cleared once it resolves (or a barge-in supersedes it) - see
  // processMicChunk() and handleWakeWord()'s own wasInterruption check,
  // both now treat isThinking exactly like isSpeaking.
  private isThinking: boolean = false;
  // Bumped every time a new turn starts (handleWakeWord()) - lets
  // handleUserSpeech() tell whether a barge-in started a NEW turn while
  // it was still mid-flight (playing a filler, waiting on the real
  // reply, or playing the real reply) so it can bail out cleanly instead
  // of racing the new turn with a stale one.
  private turnId: number = 0;
  // Set right before each interruptible playback call, cleared right
  // after - handleWakeWord() calls .abort() on this when a wake word
  // fires mid-playback, which is what actually stops the audio (see
  // playWavBuffer's AbortSignal support).
  private currentPlaybackAbort: AbortController | null = null;
  // Per-turn VAD state (see END_OF_TURN_SILENCE_MS / computeRmsEnergy
  // above) - reset in handleWakeWord() at the start of each turn.
  private turnSilenceMs: number = 0;
  private turnHasSpeech: boolean = false;
  private turnStartedAt: number = 0;
  // [ADDED 2026-09-02] Real live bug found running 'listen' end to end
  // with Chatterbox as the TTS provider: context.isActive only flips back
  // to false once handleUserSpeech() finishes ENTIRELY (filler synthesis
  // + the real LLM/app-control/Chatterbox-synthesis call), which - now
  // that Chatterbox genuinely takes 30-100+s (see the master doc's
  // 2026-09-01 thirteenth-pass entry) - is a long window during which
  // mic chunks keep arriving. Without this flag, processMicChunk()'s
  // hitSilenceCutoff check (turnHasSpeech stays true, turnSilenceMs only
  // grows) re-evaluated to true on EVERY subsequent chunk for that whole
  // window, logging "ending turn" and calling stopStreaming() again every
  // ~250ms - confirmed live: over 100 repeats in a single turn, all
  // harmlessly caught (stopStreaming() throws when nothing's streaming),
  // but alarming log spam that looked like a stuck/broken pipeline when
  // it was actually just working slowly. Set true the first time the
  // cutoff fires, reset alongside the rest of the per-turn VAD state in
  // handleWakeWord() - so the log/stop only fires once per turn, exactly
  // as intended, regardless of how long the reply takes to generate.
  private turnEndingTriggered: boolean = false;
  // Set alongside turnEndingTriggered when the turn ends via
  // NO_SPEECH_TIMEOUT_MS (see its own comment above) rather than a normal
  // post-speech silence cutoff - handleUserSpeech() reads this to skip
  // generating a spoken reply to what was never real speech in the first
  // place. Reset in handleWakeWord() with the rest of the per-turn state.
  private turnEndedWithNoSpeech: boolean = false;
  // [ADDED 2026-09-03] Real, live-found fix - see handleUserSpeech()'s
  // directedAtJarvisCheck gate for the full story: a follow-up utterance
  // (startFollowUpListening() - no fresh wake word) has no "was the wake
  // word spurious/ambient" question to answer in the first place, so
  // running that classifier on it is pure risk with no real benefit -
  // confirmed live to wrongly reject a genuine command ("Dervis, open
  // spotify" - STT's own garbling of "Jarvis" apparently read to the
  // classifier as addressing a different, unrecognized person, not "did
  // the wake word actually mean this instance of speech"). Defaults
  // false (a real wake-word-triggered turn, including a mid-reply
  // interruption via handleWakeWord() - both genuinely warrant the
  // check), set true only by startFollowUpListening().
  private isFollowUpTurn: boolean = false;
  // Rolling window of real energy readings taken while idle (see
  // IDLE_NOISE_WINDOW_CHUNKS above) - this is what handleWakeWord() reads
  // from to compute turnSpeechThreshold fresh for each turn, instead of
  // comparing against a fixed guessed number.
  private idleEnergyWindow: number[] = [];
  // This turn's real speech-vs-silence cutoff, computed once in
  // handleWakeWord() from idleEnergyWindow - see FALLBACK_SPEECH_THRESHOLD
  // above for why it starts there before any turn has happened.
  private turnSpeechThreshold: number = FALLBACK_SPEECH_THRESHOLD;
  // Throttles the VAD debug log below to ~2x/sec instead of once per
  // 250ms mic chunk (4x/sec) - enough to see real energy levels/timing
  // live without flooding the console during a real turn.
  private lastVadLogAt: number = 0;

  // Event listeners
  private listeners: Map<string, Function[]> = new Map();

  // Real app-control execution (2026-08-31) - see generateResponse()'s own
  // comment for the full story: without this, "open Notepad"/"open
  // Spotify" spoken through the mic just got a conversational reply
  // asking for clarification, because nothing in this class's own
  // generateResponse() ever executed anything. Optional and not
  // constructed internally (unlike modelProvider above) because
  // Orchestrator does its own heavy one-time setup (agent registration,
  // its own gateway) that a caller may already have done once and wants
  // reused, not duplicated per VoiceInterface instance - see cli.ts's
  // `listen`/`voice-reply` commands, which now pass their own already-
  // constructed Orchestrator in.
  private orchestrator?: Orchestrator;

  constructor(config: VoiceConfig = DEFAULT_VOICE_CONFIG, modelProvider?: ModelProvider, orchestrator?: Orchestrator) {
    this.config = config;
    // Same Gemini -> Ollama -> OpenRouter gateway Phase 1 uses, so a voice
    // reply degrades to the local model instead of dying on a 429 too.
    this.modelProvider = modelProvider || new GatewayModelProvider(createDefaultGateway());
    this.orchestrator = orchestrator;

    // [ADDED 2026-09-01] Wire the Orchestrator's real-action hooks (see
    // orchestrator.ts) to our own "acting"/"acting-done" events, so
    // cli.ts can drive a distinct HUD animation while JARVIS is actually
    // executing a task (opening an app, etc.) instead of showing the same
    // "thinking" animation for both LLM latency and real OS actions -
    // per Gavin: "we also need an animation for when JARVIS is doing the
    // task that's asked of him."
    if (this.orchestrator) {
      this.orchestrator.onActionStart = (description) => this.emit("acting", description);
      this.orchestrator.onActionEnd = () => this.emit("acting-done");
    }

    this.context = {
      conversationId: `conversation-${Date.now()}`,
      messageHistory: [],
      lastWakeWordTime: new Date(),
      isActive: false,
    };

    this.initializeListeners();
    this.initializeComponents();
  }

  /**
   * Initialize event listeners
   */
  private initializeListeners() {
    this.listeners.set("listening", []);
    this.listeners.set("wake-word-detected", []);
    this.listeners.set("user-speech-recognized", []);
    this.listeners.set("turn-ending", []);
    this.listeners.set("jarvis-responding", []);
    this.listeners.set("speech-not-directed", []);
    this.listeners.set("acting", []);
    this.listeners.set("acting-done", []);
    this.listeners.set("audio-ready", []);
    this.listeners.set("interaction-complete", []);
    this.listeners.set("error", []);
  }

  /**
   * Subscribe to voice interface events
   */
  on(event: string, callback: Function) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  /**
   * Emit event
   */
  private emit(event: string, data?: any) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach((callback) => callback(data));
  }

  /**
   * Initialize voice components
   */
  private initializeComponents() {
    if (this.config.wakeWord.enabled) {
      this.wakeWordDetector = new WakeWordDetector({
        keyword: this.config.wakeWord.keyword,
        sensitivity: this.config.wakeWord.sensitivity,
        modelPath: this.config.wakeWord.modelPath,
        sampleRate: this.config.audio.sampleRate,
      });

      // Listen for wake word
      this.wakeWordDetector.on("wake-word-detected", (event: WakeWordEvent) => {
        this.handleWakeWord(event);
      });
    }

    if (this.config.speechRecognition.enabled) {
      this.speechRecognizer = new SpeechRecognizer({
        model: this.config.speechRecognition.model,
        language: this.config.speechRecognition.language,
        streaming: this.config.speechRecognition.streaming,
        responseFormat: this.config.speechRecognition.responseFormat,
        sampleRate: this.config.audio.sampleRate,
      });

      // Listen for recognition results
      this.speechRecognizer.on("final-result", (result: RecognitionResult) => {
        this.handleUserSpeech(result);
      });
    }

    if (this.config.textToSpeech.enabled) {
      // [UPDATE 2026-08-31] Provider selection (Piper vs. Fish Audio,
      // with automatic Piper fallback) now lives in tts-provider.ts -
      // see createSpeechSynthesizer for the real logic.
      this.speechSynthesizer = createSpeechSynthesizer(this.config);
      // [REMOVED 2026-09-02] A separate always-Piper filler synthesizer
      // used to be constructed here - see speechSynthesizer's own field
      // comment for why it's gone (Gavin's explicit choice: the filler
      // now shares this exact same synthesizer, so there's genuinely one
      // consistent voice, not two).
    }
  }

  /**
   * Start voice interface
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    console.log("\n" + "=".repeat(70));
    console.log("🚀 JARVIS Voice Interface Starting");
    console.log("=".repeat(70));

    this.isRunning = true;

    // [ADDED 2026-09-02] Real fix for a real, live-found problem: kick off
    // TTS warm-up now, NOT awaited - see ISpeechSynthesizer.warmUp?()'s
    // own comment for the full story (Chatterbox's real one-time model-
    // load/voice-conditioning cost, confirmed live at ~65s, was
    // previously paid silently in the middle of the first real reply).
    // Deliberately fire-and-forget: wake-word listening below starts
    // immediately regardless, so this doesn't delay JARVIS being ready to
    // hear "Jarvis" - it just means the voice model is very likely warm
    // by the time a real reply actually needs it, instead of guaranteed
    // cold.
    this.speechSynthesizer?.warmUp?.().catch((err) => {
      console.log(`   ⚠️  TTS warm-up failed (non-fatal, will retry lazily on first real use): ${err instanceof Error ? err.message : err}`);
    });
    // [ADDED 2026-09-03] Same real fix, same reasoning, for STT: the
    // Whisper daemon's own one-time model-load cost (~1s, measured live)
    // is now paid here instead of silently during the first real
    // utterance - see speech-recognizer.ts's warmUp().
    this.speechRecognizer?.warmUp?.().catch((err) => {
      console.log(`   ⚠️  STT warm-up failed (non-fatal, will retry lazily on first real use): ${err instanceof Error ? err.message : err}`);
    });
    // [ADDED 2026-09-03] Same real fix/reasoning, for Spotify: the daemon's
    // own one-time process-start + first-auth-call cost (measured live at
    // ~900ms-1s combined) is now paid here instead of silently during
    // Gavin's first real "play X" request - see core/spotify.ts's
    // SpotifyController.warmUp(). A no-op wait if Spotify credentials
    // aren't set up yet - the daemon fails fast and this just logs it,
    // same as the other two warm-ups; the real error still surfaces
    // normally on the first actual Spotify request.
    spotifyWarmUp().catch((err) => {
      console.log(`   ⚠️  Spotify warm-up failed (non-fatal, will retry lazily on first real use): ${err instanceof Error ? err.message : err}`);
    });

    if (this.wakeWordDetector) {
      console.log(`\n🎤 Waiting for wake word: "${this.config.wakeWord.keyword}"`);
      await this.wakeWordDetector.startListening();
    }

    this.emit("listening", { wake_word: this.config.wakeWord.keyword });
  }

  /**
   * Stop voice interface
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    console.log("\n🛑 Stopping Voice Interface");
    this.isRunning = false;
    this.context.isActive = false;

    if (this.wakeWordDetector) {
      await this.wakeWordDetector.stopListening();
      // Real process teardown (2026-08-31) - stopListening() alone no
      // longer kills the persistent wake-word daemon (see its own
      // comment for why), so the whole `listen` session ending is what
      // actually needs to end that process, or it would leak past this
      // VoiceInterface's own lifetime.
      this.wakeWordDetector.shutdown();
    }

    // Same real-process-teardown reasoning as above, for Chatterbox's
    // persistent synthesis daemon (added 2026-08-31) - a no-op for
    // Piper/Fish Audio, which don't implement shutdown() at all.
    this.speechSynthesizer?.shutdown?.();

    if (this.speechRecognizer) {
      try {
        await this.speechRecognizer.stopStreaming();
      } catch {
        // Ignore error if not currently recognizing
      }
      // Same real-process-teardown reasoning as the wake-word detector
      // and Chatterbox above (added 2026-09-03) - the Whisper daemon is
      // now a persistent process too and needs the same explicit cleanup
      // at full session end, or it would leak past this VoiceInterface's
      // own lifetime.
      this.speechRecognizer.shutdown();
    }

    // Same real-process-teardown reasoning as the wake-word detector,
    // Chatterbox, and Whisper above (added 2026-09-03) - the Spotify
    // daemon is a persistent process too and needs the same explicit
    // cleanup at full session end, or it would leak past this
    // VoiceInterface's own lifetime.
    spotifyShutdown();
  }

  /**
   * Handle wake word detection
   */
  private async handleWakeWord(event: WakeWordEvent) {
    // [ADDED 2026-09-02] Real barge-in: if this fired while JARVIS was
    // mid-speech, it's an interruption, not a fresh idle-to-active
    // transition - see isSpeaking's own field comment for the full
    // design. Aborting the in-flight playback here is what makes
    // playInterruptible()'s await unblock (it rejects with
    // PlaybackInterruptedError, which handleUserSpeech() treats as
    // non-fatal) instead of this function racing it - everything below
    // this point is exactly the same "start listening for what the user
    // wants to say" logic a cold wake word already needed, so a
    // barge-in transitions straight into it, no separate code path.
    // [UPDATE 2026-09-03] Now also true during the "thinking" gap
    // (isThinking) - see that field's own comment for why "Jarvis" said
    // while JARVIS is generating a reply, not just while it's speaking
    // one, needs to count as a real interruption too.
    const wasInterruption = this.isSpeaking || this.isThinking;

    // [ADDED 2026-09-02] Real, live-found fix - see
    // config.wakeWord.interruptionConfidenceThreshold's own comment for
    // the full data: a real ambient-house-noise trigger (60.2%
    // confidence) wrongly aborted an in-progress real reply. Gavin:
    // "it could also be that it thought i was interupting when i wasnt
    // it was just the sounds of my house." Only the INTERRUPTION case
    // gets this higher bar - the initial idle->active wake word stays as
    // sensitive as Gavin wants it (sensitivity: 0.05, unchanged); this
    // only filters a candidate trigger that arrives WHILE JARVIS is
    // already speaking. A low-confidence hit here is simply ignored -
    // not logged as a real interruption, playback keeps going - rather
    // than treated as a real (but likely false) barge-in.
    if (wasInterruption && event.confidence < this.config.wakeWord.interruptionConfidenceThreshold) {
      console.log(
        `\n🙉 Wake-word trigger during playback ignored - confidence ${(event.confidence * 100).toFixed(1)}% ` +
          `is below the ${(this.config.wakeWord.interruptionConfidenceThreshold * 100).toFixed(0)}% bar for treating ` +
          `it as a real interruption (likely ambient noise, not a deliberate "Jarvis"). Reply continues.`
      );
      // Real re-arm (see wake-word-detector.ts's rearm() comment): without
      // this, the detector's own one-shot latch stays "used up" for the
      // rest of this reply's playback, silently blocking a genuine
      // follow-up interruption attempt from ever firing again.
      this.wakeWordDetector?.rearm();
      return;
    }

    if (wasInterruption) {
      // currentPlaybackAbort is only set during real playback
      // (playInterruptible) - a real no-op via optional chaining when
      // this fires mid-"thinking" instead (nothing playing yet to
      // abort; the stale in-flight response is discarded later via the
      // turnId check in handleUserSpeech() once it resolves).
      console.log(`\n⏹️  Interrupted ${this.isSpeaking ? "mid-speech" : "mid-thinking"} - stopping and listening now.`);
      this.currentPlaybackAbort?.abort();
    } else {
      console.log(`\n✨ Wake word detected! Starting conversation...`);
    }

    // 2026-08-31: explicit stop, not just relying on context.isActive to
    // gate future processMicChunk() calls - see wake-word-detector.ts's
    // stopListening() for why this matters: it also resolves any
    // already-in-flight score-count waiter left over from the idle-phase
    // audio right at this exact handoff, instead of letting it hang until
    // a confusing 5s timeout error fires mid-turn.
    if (this.wakeWordDetector) {
      await this.wakeWordDetector.stopListening();
    }

    await this.beginActiveTurn();
    this.emit("wake-word-detected", event);
  }

  /**
   * [ADDED 2026-09-03] Real shared turn-start logic, extracted from
   * handleWakeWord() unchanged - everything a new turn needs (turnId
   * bump, VAD state reset, real per-turn speech threshold calibration,
   * starting the speech recognizer) regardless of whether it was
   * triggered by a real wake word or by startFollowUpListening() below
   * (a continuing conversation, no "Jarvis" needed). handleWakeWord()
   * still owns anything wake-word-SPECIFIC (the interruption-confidence
   * gate, stopping the wake-word detector, emitting "wake-word-detected"
   * with the real event) - this only owns what both paths share.
   */
  private async beginActiveTurn(): Promise<void> {
    this.turnId++;
    this.context.isActive = true;
    // Real default for every caller (a fresh wake word or a mid-reply
    // interruption, both via handleWakeWord()) - startFollowUpListening()
    // overrides this to true right after calling beginActiveTurn(), see
    // isFollowUpTurn's own field comment.
    this.isFollowUpTurn = false;
    // Real, fresh reset for every new turn - see isThinking's own field
    // comment. Guards against a still-resolving-in-the-background stale
    // turn's own cleanup (handleUserSpeech()) clobbering THIS turn's real
    // state; this is the one place that gets to say "thinking hasn't
    // started yet for this turn."
    this.isThinking = false;
    this.context.lastWakeWordTime = new Date();
    this.turnSilenceMs = 0;
    this.turnHasSpeech = false;
    this.turnStartedAt = Date.now();
    this.turnEndingTriggered = false;
    this.turnEndedWithNoSpeech = false;

    // Real per-turn calibration (2026-08-30) - see IDLE_NOISE_WINDOW_CHUNKS
    // above for why this replaced a fixed SPEECH_RMS_THRESHOLD: whatever
    // this exact mic/gain/room just measured as "quiet" in the few
    // seconds before this turn started is the real baseline to compare
    // against, not a number picked once on different hardware.
    if (this.idleEnergyWindow.length > 0) {
      const measuredFloor = Math.min(...this.idleEnergyWindow);
      this.turnSpeechThreshold = Math.max(measuredFloor * SPEECH_ABOVE_FLOOR_MULTIPLIER, MIN_SPEECH_THRESHOLD);
      console.log(
        `   🎚️  turn speech threshold: ${this.turnSpeechThreshold.toFixed(0)} (from ${this.idleEnergyWindow.length} real pre-wake-word samples, quietest was ${measuredFloor.toFixed(0)})`
      );
    } else {
      this.turnSpeechThreshold = FALLBACK_SPEECH_THRESHOLD;
      console.log(
        `   🎚️  turn speech threshold: ${this.turnSpeechThreshold.toFixed(0)} (fallback - no idle samples collected yet, e.g. this turn started right at startup)`
      );
    }

    // Start listening for speech
    if (this.speechRecognizer) {
      await this.speechRecognizer.startStreaming();
    }
  }

  /**
   * [ADDED 2026-09-03] Real feature, per Gavin: "we need to make it that
   * he still know if im talking to him so i don thav eto say jarvis
   * evrytime if th econversation is continueing." Previously EVERY turn,
   * even an immediate follow-up question right after JARVIS finished
   * answering, required saying "Jarvis" again from scratch - a real,
   * disclosed gap, not how the master doc's own Part 5.1 conversational
   * design was meant to feel. Real mechanism: after a normal turn
   * completes (not a bailout - see the two call sites below), this opens
   * a new active turn directly via beginActiveTurn() - same real VAD/
   * speech-recognition path a wake word starts, just without requiring
   * one. If real speech arrives, it flows through the exact same
   * handleUserSpeech() pipeline as always, continuing the conversation.
   * If nothing is said, the EXISTING NO_SPEECH_TIMEOUT_MS bailout (built
   * for the "false wake-word trigger" case) already does exactly the
   * right thing here too - gives up cleanly after a real, bounded wait
   * and reverts to normal wake-word-gated idle listening, no separate
   * mechanism needed. Real, disclosed off-switch: config.conversation.
   * followUpListening, default true - JARVIS keeps LISTENING (feeding
   * real mic energy into a real VAD window) for a real few seconds after
   * every reply regardless of whether this is enabled, since idle
   * listening already does that for the wake-word detector; the only
   * thing this changes is whether real speech in that window needs
   * "Jarvis" first.
   */
  private async startFollowUpListening(): Promise<void> {
    if (!this.config.conversation.followUpListening) {
      if (this.wakeWordDetector && this.isRunning) {
        await this.wakeWordDetector.startListening();
      }
      return;
    }
    console.log(`\n💬 Still listening - no "Jarvis" needed if you're continuing the conversation.`);
    // See FOLLOWUP_RECALIBRATION_MS's own comment for the real bug this
    // fixes. context.isActive is already false here (set by the caller
    // just before this) and isSpeaking is false too (playback already
    // finished) - so real mic chunks arriving during this wait flow
    // through processMicChunk()'s existing idle branch and refill
    // idleEnergyWindow with genuinely current samples, the same real
    // mechanism pre-wake-word idle listening always used; this just
    // clears out the stale window first and gives it an explicit chance
    // to do that instead of skipping straight past it.
    this.idleEnergyWindow = [];
    if (this.isRunning) {
      await new Promise((resolve) => setTimeout(resolve, FOLLOWUP_RECALIBRATION_MS));
    }
    if (!this.isRunning) return;
    await this.beginActiveTurn();
    this.isFollowUpTurn = true;
    // Real HUD signal: the SAME event cli.ts already maps to
    // hud.setState("listening") - a follow-up window is genuinely the
    // same real state (JARVIS is actively listening for real speech) as
    // a fresh wake-word trigger, just without a real WakeWordEvent to
    // pass through (there wasn't one - that's the whole point).
    this.emit("wake-word-detected", { keyword: this.config.wakeWord.keyword, confidence: 1, timestamp: new Date() });
  }

  /**
   * Feed one chunk of real microphone PCM16 audio into whichever stage of
   * the pipeline is currently active. This is the method the `listen` CLI
   * command's mic-capture loop calls per chunk - everything else in this
   * class (wake word -> speech recognition -> response -> playback) was
   * already real and wired; real audio just never reached it. See
   * mic-capture.ts for where the chunks actually come from.
   */
  async processMicChunk(chunk: Buffer): Promise<void> {
    if (!this.isRunning) return;

    // [ADDED 2026-09-02] Real barge-in: chunks arriving while JARVIS is
    // speaking used to be dropped entirely. Now routed specifically to
    // the wake-word detector (only listening if playInterruptible()
    // re-armed it) - see isSpeaking's own field comment for why this is
    // scoped to the wake word, not general speech/VAD. A hit here fires
    // the same "wake-word-detected" event a cold wake word does,
    // handled by handleWakeWord()'s own interruption branch.
    // [UPDATE 2026-09-03] Also routed here during isThinking - see that
    // field's own comment. Before this, chunks arriving during the real
    // LLM/app-control call went to the ALREADY-STOPPED speech recognizer
    // (a silent no-op) and the wake-word detector was never listening at
    // all in that window - there was no real way to say "Jarvis" and
    // have it register until JARVIS actually started speaking.
    if (this.isSpeaking || this.isThinking) {
      if (this.wakeWordDetector) {
        await this.wakeWordDetector.processAudioChunk(chunk);
      }
      return;
    }

    const energy = computeRmsEnergy(chunk);

    if (!this.context.isActive) {
      // Idle: only the wake-word detector cares about audio right now,
      // but this is also real, live ambient-noise data - keep a rolling
      // window of it (see IDLE_NOISE_WINDOW_CHUNKS above) so the NEXT
      // turn's speech threshold is grounded in what this room/mic/gain
      // actually measured as quiet moments ago, not a stale guess.
      this.idleEnergyWindow.push(energy);
      if (this.idleEnergyWindow.length > IDLE_NOISE_WINDOW_CHUNKS) {
        this.idleEnergyWindow.shift();
      }
      if (this.wakeWordDetector) {
        await this.wakeWordDetector.processAudioChunk(chunk);
      }
      return;
    }

    // Active turn: feed the recognizer, and separately run VAD on the
    // same chunk to decide when the user has actually stopped talking.
    if (this.speechRecognizer) {
      await this.speechRecognizer.processAudioChunk(chunk);
    }

    const chunkMs = (chunk.length / 2 / this.config.audio.sampleRate) * 1000;
    const isSpeechEnergy = energy > this.turnSpeechThreshold;
    if (isSpeechEnergy) {
      this.turnHasSpeech = true;
      this.turnSilenceMs = 0;
    } else {
      this.turnSilenceMs += chunkMs;
    }

    // Real diagnostic gap found 2026-08-30, still worth keeping even
    // after the threshold itself became real/per-turn: this is what
    // showed the fixed-threshold bug in the first place (silence stuck
    // at 0ms for over a minute straight in a real live run) and is still
    // the fastest way to see the new per-turn threshold actually working
    // (or not) without guessing blind again.
    const now = Date.now();
    if (now - this.lastVadLogAt >= 500) {
      this.lastVadLogAt = now;
      console.log(
        `   🎚️  energy: ${energy.toFixed(0)} (speech threshold: ${this.turnSpeechThreshold.toFixed(0)}) | speech detected this turn: ${this.turnHasSpeech} | silence: ${this.turnSilenceMs.toFixed(0)}ms / ${END_OF_TURN_SILENCE_MS}ms`
      );
    }

    const turnDurationMs = Date.now() - this.turnStartedAt;
    const hitSilenceCutoff = this.turnHasSpeech && this.turnSilenceMs >= END_OF_TURN_SILENCE_MS;
    // See NO_SPEECH_TIMEOUT_MS's own comment above - a real, live-found
    // bug: without this, a false wake-word trigger with no follow-up
    // speech never hit hitSilenceCutoff (turnHasSpeech stays false) and
    // the turn stayed open until the full 5-minute maxTurnDuration
    // backstop instead.
    const hitNoSpeechTimeout = !this.turnHasSpeech && this.turnSilenceMs >= NO_SPEECH_TIMEOUT_MS;
    const hitMaxDuration = turnDurationMs >= this.config.conversation.maxTurnDuration * 1000;

    if ((hitSilenceCutoff || hitNoSpeechTimeout || hitMaxDuration) && this.speechRecognizer && !this.turnEndingTriggered) {
      this.turnEndingTriggered = true;
      this.turnEndedWithNoSpeech = hitNoSpeechTimeout;
      console.log(
        `   ⏹️  ending turn (${hitSilenceCutoff ? "silence cutoff" : hitNoSpeechTimeout ? "no speech detected after wake word" : "max turn duration reached"})`
      );
      // [ADDED 2026-09-03] Real, live-found gap - per Gavin: "theres like
      // a 4 second wait from when im done talking to whens its
      // thinking." The HUD only flipped to "thinking" on
      // "user-speech-recognized," which fires AFTER Whisper finishes
      // transcribing - meaning the real END_OF_TURN_SILENCE_MS (3000ms,
      // by design, needed to be confident the user actually finished)
      // PLUS real STT time both elapsed with zero feedback that JARVIS
      // had even noticed the user stopped talking. This is the earliest
      // real moment that's true - the silence cutoff (or no-speech/max-
      // duration timeout) firing - so the HUD can react here instead of
      // waiting for transcription to also finish. Doesn't touch
      // END_OF_TURN_SILENCE_MS itself (a real, separate, deliberate
      // design tradeoff - shortening it risks cutting people off
      // mid-sentence - not what was asked here).
      this.emit("turn-ending");
      try {
        await this.speechRecognizer.stopStreaming();
      } catch {
        // stopStreaming() throws if streaming wasn't actually in progress
        // (e.g. a race between two chunks both crossing the cutoff) -
        // handleUserSpeech only ever runs off the resulting "final-result"
        // event, so a redundant/failed stop here is harmless to ignore.
      }
    }
  }

  /**
   * Lazily synthesize (once per variant) and cache a short "thinking"
   * acknowledgment - see fillerAudioQuick/fillerAudioAction's own field
   * comment for why this exists.
   *
   * [UPDATE 2026-09-03] Real, proportional filler - per Gavin: "make it
   * proportional to what it's actually doing." Picks between two real
   * fixed phrases based on orchestrator.ts's new guessIfRealActionNeeded()
   * (free, instant, no LLM call - has to return before this plays, or
   * it'd reintroduce the exact "dead air before the filler" bug fixed
   * earlier this session): a plain question gets a quick, minimal
   * acknowledgment; something that's actually about to open an app,
   * search the web, click something, or look at the screen/camera gets
   * a filler that honestly signals more real work is about to happen.
   * Still a fixed phrase per variant, not routed through the real LLM
   * (that would just move the same latency problem one step earlier) -
   * two honest phrases is the real fix here, not infinite variety.
   */
  private async ensureFillerAudio(utterance: string): Promise<SynthesisResult | null> {
    if (!this.speechSynthesizer) return null;

    // Real, free (no LLM) guess at whether this looks like it needs a
    // real action - see guessIfRealActionNeeded()'s own comment for the
    // real, disclosed limitation (file operations aren't caught here,
    // no free regex tier for those - they get the quick filler anyway).
    const needsAction = this.orchestrator?.guessIfRealActionNeeded(utterance) ?? false;
    // [UPDATE 2026-09-03] "Mm-hm." replaced - per Gavin's direct live
    // report, "the mhm is glitching." Measured, not just assumed: a real
    // synthesize("Mm-hm.") call produced 199760 bytes of audio versus
    // 80720 bytes for "Right." (a genuinely SHORTER phrase) - about 2.5x
    // more audio than the text justifies, consistent with the known
    // autoregressive-TTS failure mode where a very short/unusual input
    // (an interjection Chatterbox likely saw little of in training,
    // unlike a normal word) leaves the model without a confident stop
    // point, producing trailing garbage/repeated audio instead of a
    // clean short clip. "Right." is already part of JARVIS's own
    // established vocabulary (see jarvis-personality.ts) and measured
    // proportionate (910ms model time for 80720 bytes, no anomaly).
    const text = needsAction ? "One moment, I'm on it." : "Right.";

    if (needsAction && this.fillerAudioAction) return this.fillerAudioAction;
    if (!needsAction && this.fillerAudioQuick) return this.fillerAudioQuick;

    try {
      // [UPDATE 2026-09-02] Uses speechSynthesizer (the real configured
      // provider - Chatterbox by default), not a separate always-Piper
      // instance - see speechSynthesizer's own field comment for the
      // real reasoning (Gavin's explicit choice after a Piper-voiced
      // filler caused real live confusion, being mistaken for the whole
      // reply using the wrong voice). Real, accepted trade-off: no
      // longer guaranteed near-instant on a cold Chatterbox daemon, but
      // the TTS warm-up fix (this same session) means that's now the
      // rare case, not the common one.
      const result = await this.speechSynthesizer.synthesize(text);
      if (needsAction) this.fillerAudioAction = result;
      else this.fillerAudioQuick = result;
      return result;
    } catch (error) {
      console.log(
        `   ⚠️  Filler-audio synthesis failed (non-fatal, continuing without it): ${error instanceof Error ? error.message : error}`
      );
      return null;
    }
  }

  /**
   * [ADDED 2026-09-02] Plays audio the same way playWavBuffer always did
   * (blocks until done, sets isSpeaking), but re-arms the wake-word
   * detector first so a fresh "Jarvis" during playback can interrupt it -
   * see isSpeaking's own field comment for the full design. Returns
   * normally on either a clean finish OR a real interruption (both are
   * "not an error" from the caller's point of view - handleUserSpeech()
   * tells them apart via turnId, not via this method's return value,
   * since handleWakeWord() has already fully taken over by the time this
   * returns from an interruption). A genuine playback failure (bad
   * device, crashed COM object) still throws, same as before.
   */
  private async playInterruptible(audio: Buffer): Promise<void> {
    this.isSpeaking = true;
    const controller = new AbortController();
    this.currentPlaybackAbort = controller;
    try {
      await this.wakeWordDetector?.startListening();
    } catch (err) {
      console.log(
        `   ⚠️  Could not arm barge-in listening for this reply (non-fatal, playback continues without it): ${err instanceof Error ? err.message : err}`
      );
    }
    try {
      await playWavBuffer(audio, undefined, controller.signal);
    } catch (err) {
      if (err instanceof PlaybackInterruptedError) {
        return; // real interruption - handleWakeWord() already started the new turn
      }
      throw err;
    } finally {
      this.isSpeaking = false;
      this.currentPlaybackAbort = null;
    }
  }

  /**
   * Handle user speech recognition
   */
  private async handleUserSpeech(result: RecognitionResult) {
    console.log(`\n👤 User said: "${result.text}"`);
    this.emit("user-speech-recognized", result);
    // Captured once, up front - see turnId's own field comment. Every
    // "did a barge-in happen while I was mid-flight?" check below
    // compares against this snapshot.
    const myTurnId = this.turnId;
    // Same reasoning, for isFollowUpTurn - see its own field comment.
    const myIsFollowUpTurn = this.isFollowUpTurn;

    // Real, live-found fix (2026-09-02) - see NO_SPEECH_TIMEOUT_MS's own
    // comment: the turn ended because NOTHING was ever heard after the
    // wake word (a false trigger, or Gavin just said "Jarvis" with no
    // follow-up), not because of real speech followed by silence.
    // Whatever `result.text` is here (Whisper transcribing near-silence
    // often produces empty text, or occasionally a short hallucinated
    // fragment) isn't a real utterance worth an LLM round-trip or a
    // spoken reply to - skip straight to resuming listening, same as the
    // "not directed at JARVIS" bailout below but without even running
    // that classifier, since there's no real text to classify.
    if (this.turnEndedWithNoSpeech) {
      console.log(`   🤷 No speech detected after wake word - resuming listening without a reply`);
      this.context.isActive = false;
      // Real, related bug fixed alongside this one: without this,
      // hud.setState("thinking") (fired above from "user-speech-recognized")
      // would never get followed by anything that sets it back to "idle" -
      // the HUD would stay stuck showing "thinking" indefinitely after
      // every false-trigger turn, which defeats the entire point of
      // pop-up-on-activity (see native-hud/'s own 2026-09-02 comment) -
      // it would just stay permanently popped up after the first false
      // trigger instead of hiding again. "interaction-complete" is the
      // one event cli.ts already maps to hud.setState("idle").
      this.emit("interaction-complete", { input: result.text, response: "" });
      if (this.wakeWordDetector && this.isRunning) {
        await this.wakeWordDetector.startListening();
      }
      return;
    }

    // [2026-09-02] Real, live-found bug fixed: directedAtJarvisCheck used
    // to run BEFORE the filler acknowledgment - meaning the one thing
    // built specifically to eliminate dead air (the "one moment" filler,
    // 2026-08-31) had a brand-new LLM call sitting in front of it,
    // guaranteeing real dead air before even that instant feedback could
    // play. Confirmed live in Gavin's own first real background-mode
    // test: a full session's worth of turns never produced a single
    // audible reply or visible "🤖 JARVIS processing" log line - every
    // turn stalled silently after STT, and he gave up and barged in
    // (correctly detected as a real interruption) before anything ever
    // got a chance to speak. Reordered: play the filler FIRST (same real
    // instant-feedback purpose as before), THEN run the directed-at-
    // JARVIS check while any further "thinking" latency is already
    // covered by having said *something* real to the user. Real,
    // disclosed trade-off: a rare "not directed" utterance will now have
    // already gotten a "one moment" filler spoken before JARVIS
    // recognizes it wasn't for him - a minor UX inconsistency, not a
    // dishonesty problem (classifyDirectedAtJarvis is deliberately biased
    // toward "true" already, so this case is meant to be rare).
    //
    // Real timing diagnostics added in the same pass (not just a
    // reorder) - every stage below now logs its own real elapsed time,
    // so if something IS still slow, the next live log shows exactly
    // which stage, instead of another silent multi-second gap with
    // nothing to go on.
    const fillerStart = Date.now();
    const filler = await this.ensureFillerAudio(result.text);
    if (filler) {
      try {
        await this.playInterruptible(filler.audio);
      } catch (err) {
        console.log(`   ⚠️  Filler playback failed (non-fatal): ${err instanceof Error ? err.message : err}`);
      }
      console.log(`   ⏱️  Filler ack: ${Date.now() - fillerStart}ms`);
      // A barge-in during the filler already started a whole new turn
      // (handleWakeWord() ran, turnId moved on) - stop here rather than
      // generate/speak a reply to a question that's no longer current.
      if (this.turnId !== myTurnId) return;
    }

    // Real environmental-audio-awareness check (2026-09-02): the wake
    // word is deliberately tuned to fire on bare "Jarvis" anywhere in
    // speech (sensitivity 0.05, per Gavin), which is exactly what makes
    // it also fire on speech that merely CONTAINS the name without being
    // addressed to JARVIS at all - a TV/radio mention, someone else in
    // the room named Jarvis, a person talking ABOUT JARVIS rather than
    // TO it. Now runs AFTER the filler (see the reorder comment above)
    // so a false wake-word trigger still costs a short filler synthesis,
    // but not a real LLM reply/TTS synthesis or an out-of-place spoken
    // answer to overheard conversation.
    //
    // [UPDATE 2026-09-03] Skipped entirely for a follow-up turn
    // (myIsFollowUpTurn) - real, live-found bug: this classifier exists
    // to second-guess whether the WAKE WORD DETECTION was spurious, but
    // a follow-up utterance has no wake-word event to second-guess in
    // the first place (that's the whole point of "no Jarvis needed").
    // Confirmed live to actively backfire there: "Dervis, open spotify."
    // (STT's own garbling of "Jarvis, open Spotify" - the "J" came out
    // as "D") got classified directedAtJarvis: false and silently
    // dropped, no action taken, no reply given - the filler ("Right.")
    // was the only thing Gavin ever heard. Per Gavin's own report: "it
    // go tot thinking then went back to idle and nothing happned othe
    // rhtnahim saying right." Real, disclosed root cause: with the wake
    // word itself garbled beyond recognition in the transcript, the
    // classifier had nothing left identifying "Jarvis" as the addressee
    // and read it as a command aimed at some other, unrecognized name -
    // a real, plausible LLM failure mode this prompt's own examples
    // don't cover. Skipping the check for follow-up turns removes the
    // failure mode at its root rather than trying to out-prompt it.
    if (this.config.conversation.directedAtJarvisCheck && !myIsFollowUpTurn) {
      const classifyStart = Date.now();
      const directed = await this.classifyDirectedAtJarvis(result.text);
      console.log(`   ⏱️  Directed-at-JARVIS check: ${Date.now() - classifyStart}ms (result: ${directed})`);
      // A barge-in during this classification call already started a
      // whole new turn (handleWakeWord() ran, turnId moved on) - bail
      // out rather than act on a stale classification for a turn that's
      // no longer current, same pattern as every other await point below.
      if (this.turnId !== myTurnId) return;
      if (!directed) {
        console.log(`   🙉 Not directed at JARVIS - ignoring, resuming listening`);
        this.emit("speech-not-directed", result);
        this.context.isActive = false;
        // Same real HUD-stuck-on-"thinking" bug fixed here as the
        // no-speech-timeout bailout above - see its comment for the full
        // reasoning. This bailout existed before that fix but had the
        // same gap; closing both together since they're the same root
        // cause (an early return with no event that maps back to
        // hud.setState("idle")).
        this.emit("interaction-complete", { input: result.text, response: "" });
        if (this.wakeWordDetector && this.isRunning) {
          await this.wakeWordDetector.startListening();
        }
        return;
      }
    }

    const respondStart = Date.now();
    // [UPDATE 2026-09-03] REVERTED sentence-by-sentence pipelining
    // (speakPipelined(), added earlier the same day) back to a single
    // whole-reply synthesize()+play() - per Gavin's direct live report:
    // "the speaking stringing together has long waits its faster but
    // harder to keep me engaged when its 20 sec between sentences."
    // Real root cause, not just a vibe: pipelining only actually hides
    // latency when synthesizing the NEXT sentence takes LESS time than
    // PLAYING the current one, so they overlap. On Gavin's real GPU
    // under real desktop load, Chatterbox synthesis has been measured as
    // high as 18-54s per call (2026-09-02 entries) - reliably LONGER
    // than most short sentences take to play back - so instead of one
    // combined wait, he got several separate multi-second-to-20-second
    // dead-air gaps strung between sentences, which is worse for
    // engagement than one wait, even though "time to first word" was
    // technically faster. The reply-length cap (same day, model-router.ts)
    // is kept - it's what actually bounds the total wait now. speakPipelined()
    // itself and splitIntoSentences() are left in place (see their own
    // comments) rather than deleted outright - a real, disclosed,
    // reusable idea if synthesis ever gets fast enough on this hardware
    // (or a faster/smaller model) for the overlap assumption to hold,
    // just not exercised from here anymore.
    // [ADDED 2026-09-03] Real feature, per Gavin: "i also want the
    // ability to aks him soemting mid thinking if i dont want the last
    // response anymore." See isThinking's own field comment for the
    // real gap this closes - arm the wake-word detector for the
    // duration of the real LLM/app-control call, same as
    // playInterruptible() already does for real playback.
    this.isThinking = true;
    try {
      await this.wakeWordDetector?.startListening();
    } catch (err) {
      console.log(
        `   ⚠️  Could not arm barge-in listening while thinking (non-fatal, this turn just won't be interruptible until it starts speaking): ${err instanceof Error ? err.message : err}`
      );
    }
    const response = await this.generateAndRecordResponse(result.text);
    // Only clear isThinking if this is still the current turn - if a
    // barge-in already superseded it, the NEW turn's own beginActiveTurn()
    // already reset isThinking for real; blindly clearing it here could
    // otherwise clobber that newer turn's own real thinking/speaking
    // state out from under it.
    if (this.turnId === myTurnId) this.isThinking = false;
    console.log(`   ⏱️  Real response generation (LLM + any real action): ${Date.now() - respondStart}ms`);
    // A barge-in during the call above already started a whole new turn
    // (handleWakeWord() ran, turnId moved on) - this stale response is
    // simply discarded now, not acted on.
    if (this.turnId !== myTurnId) return;

    let audio: SynthesisResult | undefined;
    if (this.speechSynthesizer) {
      const synthStart = Date.now();
      audio = await this.speechSynthesizer.synthesize(normalizeNumbersForSpeech(response));
      console.log(`   ⏱️  TTS synthesis: ${Date.now() - synthStart}ms`);
      this.emit("audio-ready", audio);
    }
    if (this.turnId !== myTurnId) return;

    if (audio) {
      const peakAmplitude = computeWavPeakAmplitude(audio.audio);
      const peakDesc =
        peakAmplitude < 0
          ? "unrecognized WAV format"
          : peakAmplitude < 0.02
            ? `${peakAmplitude.toFixed(4)} - SUSPICIOUSLY QUIET, likely a dead/near-silent synthesis, not a playback-routing issue`
            : peakAmplitude.toFixed(4);
      console.log(`\n🔊 Response ready: ${audio.duration}ms, peak amplitude: ${peakDesc}`);
      try {
        await this.playInterruptible(audio.audio);
      } catch (err) {
        console.log(`   ⚠️  Playback failed: ${err instanceof Error ? err.message : err}`);
      }
      // A barge-in mid-reply already started a whole new turn - don't
      // also run this turn's own completion/resume-listening logic
      // below, which would fight handleWakeWord()'s already-in-progress
      // state for the new turn.
      if (this.turnId !== myTurnId) return;
    }

    // Interaction complete
    this.context.isActive = false;
    this.emit("interaction-complete", {
      input: result.text,
      response,
    });

    // [UPDATE 2026-09-03] Real conversational-continuity feature - see
    // startFollowUpListening()'s own comment. Only reached here, the
    // NORMAL full-reply completion path - the two early-return bailouts
    // above (no speech detected, not directed at JARVIS) still go
    // straight back to plain wake-word-gated idle listening, correctly:
    // neither of those was a real exchange worth staying primed for a
    // follow-up to.
    if (this.isRunning) {
      await this.startFollowUpListening();
    }
  }

  /**
   * Real environmental-audio-awareness classifier: is this transcribed
   * utterance genuinely addressed to JARVIS as a command/question, or
   * incidental/ambient speech that happened to contain the wake word (or
   * got captured in the listening window alongside it)? A small, fast,
   * cheap LLM classification call - same JSON-object pattern used by
   * orchestrator.ts's classifyAppControlIntent()/classifyScreenVisionIntent(),
   * duplicated locally rather than imported (this codebase's established
   * own-helper-per-file convention - see e.g. screen-capture.ts's own
   * WIN32_WINDOW_TYPE).
   *
   * Deliberately biased toward "true" on genuine ambiguity: the cost of
   * one unwanted reply to overheard conversation is far lower than the
   * cost of silently ignoring a real request, so this only suppresses a
   * turn when the model is fairly confident it's NOT directed at JARVIS.
   * Same fail-safe shape as the other classifiers in this codebase: any
   * failure (provider error, malformed JSON) defaults to `true` (treat it
   * as directed, respond normally) rather than ever silently dropping a
   * real command because a classifier call hiccupped.
   */
  private async classifyDirectedAtJarvis(utterance: string): Promise<boolean> {
    const classifierPrompt =
      "You are a filter for JARVIS, a wake-word-activated voice assistant. The wake word (\"Jarvis\") was just " +
      "detected in the room's audio, and this is the speech that followed. JARVIS's wake-word detector is " +
      "deliberately tuned to fire on the bare word \"Jarvis\" ANYWHERE in speech, not just \"hey Jarvis\" as a " +
      "clean address - which means it can also fire on speech that merely CONTAINS the name without actually " +
      "being addressed to an AI assistant: a TV/radio mention, a different person in the room also named " +
      "Jarvis, or someone talking ABOUT JARVIS in the third person rather than TO it directly.\n\n" +
      "Decide: is this utterance genuinely a command or question directed AT the assistant, or is it " +
      "incidental/ambient speech not meant for it? Respond with ONLY a single raw JSON object, no other text, " +
      "no markdown code fences, matching exactly this shape:\n" +
      '{"directedAtJarvis": boolean}\n\n' +
      "Rules:\n" +
      "- Default to true (directedAtJarvis: true) whenever it's genuinely ambiguous - a real request wrongly " +
      "ignored is worse than one unwanted reply to overheard conversation.\n" +
      "- Only answer false when there's a real, specific signal this ISN'T addressed to the assistant: it " +
      'names/addresses a different person (e.g. "no Jarvis stop that" said to a person, a pet, a character), ' +
      'refers to JARVIS in the third person ("that new Jarvis movie", "did you see Jarvis earlier"), or is ' +
      "plainly a continuation of an unrelated human conversation with no command/question shape at all.\n" +
      "- A plain command or question with no explicit address at all (e.g. \"what's the weather\", \"open " +
      "Spotify\") is directedAtJarvis: true - the wake word already fired, so no repeated \"Jarvis\" is needed " +
      "in the utterance itself.\n\n" +
      "Examples:\n" +
      '"Jarvis, open Spotify" -> {"directedAtJarvis": true}\n' +
      '"what\'s the weather like today" -> {"directedAtJarvis": true}\n' +
      '"can you check my email" -> {"directedAtJarvis": true}\n' +
      '"no Jarvis, stop pulling on that" -> {"directedAtJarvis": false}\n' +
      '"have you seen that new Jarvis movie yet" -> {"directedAtJarvis": false}\n' +
      '"anyway, so I told her, and Jarvis just laughed" -> {"directedAtJarvis": false}';

    try {
      const response = await this.modelProvider.complete(
        [
          { role: "system", content: classifierPrompt },
          { role: "user", content: utterance },
        ],
        {
          temperature: 0,
          maxTokens: 50,
          responseFormat: { type: "json_object" },
        }
      );

      const trimmed = response.content.trim();
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const candidate = fenced ? fenced[1].trim() : trimmed;
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start === -1 || end === -1 || end < start) return true;

      const parsed = JSON.parse(candidate.slice(start, end + 1)) as { directedAtJarvis?: boolean };
      return parsed.directedAtJarvis !== false; // default true unless explicitly false
    } catch (error) {
      console.error(
        "⚠ Directed-at-JARVIS classification failed (defaulting to true - treating as a real request):",
        error instanceof Error ? error.message : error
      );
      return true;
    }
  }

  /**
   * [ADDED 2026-09-03] Shared text-generation half of a turn - push the
   * user turn, get a real JARVIS response, push the assistant turn.
   * Extracted out of respondToText() so the mic pipeline
   * (handleUserSpeech) can use the SAME real response-generation/history
   * bookkeeping while diverging on what happens to the audio
   * (speakPipelined() below, not a single whole-reply synthesize() call)
   * - see speakPipelined()'s own comment for why.
   */
  private async generateAndRecordResponse(userText: string): Promise<string> {
    this.context.messageHistory.push({
      role: "user",
      content: userText,
      timestamp: new Date(),
    });

    const response = await this.generateResponse(userText);

    this.context.messageHistory.push({
      role: "assistant",
      content: response,
      timestamp: new Date(),
    });

    return response;
  }

  /**
   * Run one text-in, text-and-audio-out turn: get a real JARVIS response,
   * synthesize the WHOLE reply as one buffer if TTS is enabled. Used by
   * any text-only caller that wants one complete `SynthesisResult` back
   * (e.g. the `voice-reply` CLI command, which saves it straight to a
   * file - there's nothing to "play sentence by sentence" for that use
   * case). The real mic pipeline (handleUserSpeech) does NOT use this -
   * see speakPipelined() below for why real-time playback pipelines
   * sentence-by-sentence instead.
   */
  async respondToText(userText: string): Promise<{ response: string; audio?: SynthesisResult }> {
    const response = await this.generateAndRecordResponse(userText);

    let audio: SynthesisResult | undefined;
    if (this.speechSynthesizer) {
      // [ADDED 2026-09-03] Real bug found live: Chatterbox mispronounced
      // a real, correct answer ("78,720") as garbled nonsense - Gavin
      // heard it as "78 7twane." Comma-formatted/large numbers are a
      // real, known TTS weakness generally, not something JARVIS's own
      // code was introducing - see text-normalizer.ts's own header
      // comment. Only the audio gets the spelled-out version
      // ("seventy-eight thousand, seven hundred twenty") - `response`
      // itself stays as real, normal text for message history/logging/
      // anything else that reads it as text, not speech.
      audio = await this.speechSynthesizer.synthesize(normalizeNumbersForSpeech(response));
      this.emit("audio-ready", audio);
    }

    return { response, audio };
  }

  /**
   * [ADDED 2026-09-03] Real speed feature, per Gavin: "do both" (reply-
   * length constraint + this). Speaks a real multi-sentence reply as a
   * PIPELINE instead of one big buffer: synthesize sentence 1 and play
   * it while sentence 2 is already being synthesized, then sentence 2
   * plays while sentence 3 synthesizes, and so on. Chatterbox's own
   * per-request synthesis time doesn't change - this doesn't make the
   * model faster - but "time until Gavin hears the FIRST word" drops
   * from "however long the whole reply takes to synthesize" down to
   * "however long just the first sentence takes," and because the
   * previous pass's maxTokens cut means most real replies are now only
   * 1-3 sentences, this and that fix compound rather than duplicate each
   * other (short replies still get whatever head start pipelining gives
   * the first sentence; a reply that does run longer no longer forces
   * total silence for its entire length).
   *
   * Deliberately NOT used by respondToText() (see its own comment) -
   * this exists specifically for handleUserSpeech()'s real-time mic
   * pipeline, where "say something as soon as possible" actually
   * matters; a caller that wants one saved WAV file has no use for
   * chunked playback.
   *
   * splitIntoSentences() runs on the RAW response text - each resulting
   * chunk is normalized (normalizeNumbersForSpeech) independently right
   * before its own synthesize() call, same as respondToText() already
   * does for the whole reply. Returns false the moment a barge-in
   * changes turnId mid-pipeline (caller should stop, same convention as
   * every other turnId check in this file) or true on a clean finish.
   */
  private async speakPipelined(text: string, myTurnId: number): Promise<boolean> {
    if (!this.speechSynthesizer) return true;

    const sentences = splitIntoSentences(text);
    if (sentences.length === 0) return true;

    const synthesizeSentence = async (sentence: string): Promise<SynthesisResult | null> => {
      try {
        return await this.speechSynthesizer!.synthesize(normalizeNumbersForSpeech(sentence));
      } catch (err) {
        console.log(`   ⚠️  Sentence synthesis failed (skipping just this sentence, continuing with the rest): ${err instanceof Error ? err.message : err}`);
        return null;
      }
    };

    // The first sentence has nothing to overlap with yet - this await IS
    // the real "time to first audio" cost pipelining is meant to shrink
    // (down from the whole reply to just this one sentence).
    let pending = synthesizeSentence(sentences[0]);

    for (let i = 0; i < sentences.length; i++) {
      if (this.turnId !== myTurnId) return false;
      const current = await pending;
      if (this.turnId !== myTurnId) return false;

      // Kick off the NEXT sentence's synthesis now, before awaiting this
      // one's playback below - it runs concurrently with playback, which
      // is the entire point of pipelining. Chatterbox's daemon only
      // handles one synthesize() at a time (by design - see
      // chatterbox-synthesizer.ts's isSynthesizing guard), but that's
      // fine here: this call happens after `current`'s own synthesis
      // already resolved, so there's never two in flight at once, just
      // this one overlapping with `current`'s playback instead of
      // waiting for it to finish first.
      if (i + 1 < sentences.length) {
        pending = synthesizeSentence(sentences[i + 1]);
      }

      if (!current) continue; // this sentence's synthesis failed - real, disclosed gap in this one reply, not fatal to the rest

      // [2026-09-03] cli.ts's ONLY hud.setState("speaking") trigger is
      // this event - respondToText() used to fire it once per whole
      // reply; fired here once, on the first real sentence, so the HUD
      // still transitions to "speaking" (and does so as soon as actual
      // audio exists, slightly earlier than before, not later).
      if (i === 0) this.emit("audio-ready", current);

      const peakAmplitude = computeWavPeakAmplitude(current.audio);
      const peakDesc =
        peakAmplitude < 0
          ? "unrecognized WAV format"
          : peakAmplitude < 0.02
            ? `${peakAmplitude.toFixed(4)} - SUSPICIOUSLY QUIET, likely a dead/near-silent synthesis, not a playback-routing issue`
            : peakAmplitude.toFixed(4);
      console.log(`\n🔊 Sentence ${i + 1}/${sentences.length} ready: ${current.duration}ms, peak amplitude: ${peakDesc}`);

      try {
        await this.playInterruptible(current.audio);
      } catch (err) {
        console.log(`   ⚠️  Sentence playback failed: ${err instanceof Error ? err.message : err}`);
      }
      if (this.turnId !== myTurnId) return false;
    }

    return true;
  }

  /**
   * Generate JARVIS response
   *
   * Real LLM call through the same Gemini/Ollama/OpenRouter gateway Phase 1
   * uses — not the old canned "I received your command..." string. Does
   * NOT go through the full Phase 0/1 agent pipeline (BaseAgent, audit
   * logging, multi-agent orchestration) — that's a much heavier flow built
   * for autonomous dev tasks, not a snappy voice reply; this is a direct,
   * single model call with just the recent conversation history as
   * context, which is the right shape for "answer what was just said."
   */
  private async generateResponse(userInput: string): Promise<string> {
    this.emit("jarvis-responding", { input: userInput });

    console.log(`\n🤖 JARVIS processing: "${userInput}"`);

    // [FIXED 2026-08-31] Real gap found live: Gavin said "open Notepad"/
    // "open Spotify" through the mic and got a conversational reply
    // asking him to clarify, instead of the app actually opening - this
    // path (unlike `Orchestrator.processConversation()` in
    // core/orchestrator.ts) never detected or executed app-control
    // intents at all. It was a deliberately lighter, identity-less call
    // with no mic input to matter before 2026-08-30, so it was left
    // unbuilt on purpose (see git history) - but real mic capture now
    // makes this the primary interactive surface, exactly the condition
    // that comment said would make it worth revisiting. Fixed by routing
    // through the same, already-real, already-tested Orchestrator
    // pipeline (`parseAppControlIntent`/`classifyAppControlIntent`/
    // `executeAppControlIntent`, same as `bun run dev conversation`)
    // instead of writing a second copy of that logic here - see
    // `orchestrator` above and cli.ts's `listen`/`voice-reply` commands
    // for where it's constructed and passed in. Honest tradeoff: the
    // orchestrator keeps its own separate conversation history
    // (ConversationEngine) rather than this class's own
    // `context.messageHistory` - fine for app-control + reply generation
    // (which is what orchestrator.processConversation() is for), but
    // means the two histories aren't merged into one transcript yet.
    if (this.orchestrator) {
      try {
        const result = await this.orchestrator.processConversation(userInput);
        console.log(`🤖 JARVIS: "${result.response}"`);
        return result.response;
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        console.error("❌ JARVIS response generation failed:", err);
        this.emit("error", { message: err });
        return "I'm afraid none of my model providers are reachable at the moment, sir.";
      }
    }

    // Fallback when no Orchestrator was provided (e.g. a caller that only
    // wants a lightweight text-in/audio-out reply with no app-control,
    // or a test using a fake ModelProvider) - the original direct,
    // single-model-call path. No app-control detection here.
    const recentHistory = this.context.messageHistory.slice(-6, -1); // exclude the just-pushed user turn
    const messages = [
      ...recentHistory.map((turn) => ({
        role: turn.role,
        content: turn.content,
      })),
      { role: "user" as const, content: userInput },
    ];

    let response: string;
    try {
      const result = await this.modelProvider.complete(messages, {
        systemPrompt: JARVIS_SYSTEM_PROMPT,
        maxTokens: 200,
      });
      response = result.content.trim();
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      console.error("❌ JARVIS response generation failed:", err);
      this.emit("error", { message: err });
      response = "I'm afraid none of my model providers are reachable at the moment, sir.";
    }

    console.log(`🤖 JARVIS: "${response}"`);
    return response;
  }

  /**
   * Get interface status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      isActive: this.context.isActive,
      conversationId: this.context.conversationId,
      messageCount: this.context.messageHistory.length,
      config: {
        wakeWord: this.config.wakeWord.keyword,
        speechModel: this.config.speechRecognition.model,
        voice: this.config.textToSpeech.voiceId,
        streaming: this.config.speechRecognition.streaming,
      },
    };
  }

  /**
   * Get conversation context
   */
  getContext(): VoiceInteractionContext {
    return { ...this.context };
  }

  /**
   * Clear conversation history
   */
  clearHistory() {
    this.context.messageHistory = [];
    console.log("📝 Conversation history cleared");
  }

  /**
   * Set sensitivity for wake word
   */
  setWakeWordSensitivity(sensitivity: number) {
    if (this.wakeWordDetector) {
      this.wakeWordDetector.setSensitivity(sensitivity);
    }
  }

  /**
   * Change speaking rate
   */
  setSpeakingRate(rate: number) {
    if (this.speechSynthesizer) {
      this.speechSynthesizer.setSpeakingRate(rate);
    }
  }

  /**
   * Change voice
   */
  setVoice(voiceId: string) {
    if (this.speechSynthesizer) {
      this.speechSynthesizer.setVoice(voiceId);
    }
  }

  /**
   * Print pipeline info
   */
  static printPipeline() {
    console.log("\n🎙️  JARVIS Voice Interface Pipeline");
    console.log("=".repeat(70));
    console.log(`
Microphone
    ↓
🎯 Wake Word Detection (openWakeWord)
    "JARVIS"
    ↓
🎤 Speech Recognition (Whisper)
    Audio → Text
    ↓
💭 JARVIS Core
    Process & Respond
    ↓
🔤 Text-to-Speech (Piper)
    Text → Audio
    ↓
🔊 Speaker
    Play Response

Key Features:
  ✓ Natural conversation (not commands)
  ✓ Context awareness (remembers message history)
  ✓ Interruption detection
  ✓ Streaming audio (low latency)
  ✓ Local processing (privacy-first)
  ✓ Background operation (always listening)

Technologies:
  • Wake Word: openWakeWord
  • STT: Whisper (${DEFAULT_VOICE_CONFIG.speechRecognition.model} model)
  • TTS: Piper (${DEFAULT_VOICE_CONFIG.textToSpeech.voiceId})
`);
    console.log("=".repeat(70));
  }
}
