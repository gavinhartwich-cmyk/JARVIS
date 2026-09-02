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
import { createSpeechSynthesizer, createPiperSynthesizer } from "./tts-provider";
import { VoiceConfig, DEFAULT_VOICE_CONFIG } from "./voice-config";
import { createDefaultGateway, GatewayModelProvider } from "../models/llm-gateway";
import type { ModelProvider } from "../models/types";
import { playWavBuffer, PlaybackInterruptedError } from "./audio-player";
import type { Orchestrator } from "../core/orchestrator";
import { JARVIS_PERSONALITY_PROMPT } from "../core/jarvis-personality";

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
  // [ADDED 2026-09-02] Always-Piper, dedicated to the filler acknowledgment
  // below - see createPiperSynthesizer()'s own comment for the real bug
  // this fixes (the filler was paying Chatterbox's slow first-synthesis
  // cost, defeating its whole purpose). Never the configured provider,
  // deliberately - speed matters far more than voice-clone fidelity for
  // three words of "hang on."
  private fillerSynthesizer?: ISpeechSynthesizer;
  // Short "thinking" acknowledgment (2026-08-31), per Gavin: "it should
  // be responding while thinking so it seems faster instead of nothing"
  // - a real LLM call plus full TTS synthesis can take several real
  // seconds (measured live: ~2s of synthesis alone, on top of the LLM
  // round trip before it), during which nothing audible happened at all,
  // making a working pipeline feel broken/unresponsive. Synthesized
  // once, lazily, and cached (see ensureFillerAudio()) - only the first
  // turn in a session pays the extra synthesis cost, every turn after
  // plays back almost instantly.
  private fillerAudio: SynthesisResult | null = null;
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
      this.orchestrator.onActionStart = () => this.emit("acting");
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
      // [ADDED 2026-09-02] Separate, always-fast synthesizer for the
      // filler acknowledgment only - see fillerSynthesizer's own comment.
      this.fillerSynthesizer = createPiperSynthesizer(this.config);
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
    this.fillerSynthesizer?.shutdown?.();

    if (this.speechRecognizer) {
      try {
        await this.speechRecognizer.stopStreaming();
      } catch {
        // Ignore error if not currently recognizing
      }
    }
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
    const wasInterruption = this.isSpeaking;
    if (wasInterruption) {
      console.log(`\n⏹️  Interrupted mid-speech - stopping and listening now.`);
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

    this.turnId++;
    this.context.isActive = true;
    this.context.lastWakeWordTime = new Date();
    this.turnSilenceMs = 0;
    this.turnHasSpeech = false;
    this.turnStartedAt = Date.now();
    this.turnEndingTriggered = false;

    // Real per-turn calibration (2026-08-30) - see IDLE_NOISE_WINDOW_CHUNKS
    // above for why this replaced a fixed SPEECH_RMS_THRESHOLD: whatever
    // this exact mic/gain/room just measured as "quiet" in the few
    // seconds before this wake word fired is the real baseline to compare
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
        `   🎚️  turn speech threshold: ${this.turnSpeechThreshold.toFixed(0)} (fallback - no idle samples collected yet, e.g. wake word fired right at startup)`
      );
    }

    this.emit("wake-word-detected", event);

    // Start listening for speech
    if (this.speechRecognizer) {
      await this.speechRecognizer.startStreaming();
    }
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
    if (this.isSpeaking) {
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
    const hitMaxDuration = turnDurationMs >= this.config.conversation.maxTurnDuration * 1000;

    if ((hitSilenceCutoff || hitMaxDuration) && this.speechRecognizer && !this.turnEndingTriggered) {
      this.turnEndingTriggered = true;
      console.log(`   ⏹️  ending turn (${hitSilenceCutoff ? "silence cutoff" : "max turn duration reached"})`);
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
   * Lazily synthesize (once) and cache a short, fixed "thinking"
   * acknowledgment - see fillerAudio's own comment above for why this
   * exists. Deliberately a single fixed generic phrase rather than
   * routing it through the real LLM (that would just move the same
   * latency problem one step earlier) or varying it (more natural, but
   * real added complexity) - a fixed phrase isn't the polish here, it's
   * the honest fix for "silence looks like it's broken."
   */
  private async ensureFillerAudio(): Promise<SynthesisResult | null> {
    if (!this.fillerSynthesizer) return null;
    if (this.fillerAudio) return this.fillerAudio;
    try {
      // [2026-09-02] fillerSynthesizer, not speechSynthesizer - see its
      // own field comment. Real live measurement of why this matters:
      // Chatterbox synthesis was taking 18-54s under real GPU load, which
      // this filler exists specifically to not make Gavin sit through.
      this.fillerAudio = await this.fillerSynthesizer.synthesize("Mm-hm, one moment.");
    } catch (error) {
      console.log(
        `   ⚠️  Filler-audio synthesis failed (non-fatal, continuing without it): ${error instanceof Error ? error.message : error}`
      );
    }
    return this.fillerAudio;
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

    // Real environmental-audio-awareness check (2026-09-02): the wake
    // word is deliberately tuned to fire on bare "Jarvis" anywhere in
    // speech (sensitivity 0.05, per Gavin), which is exactly what makes
    // it also fire on speech that merely CONTAINS the name without being
    // addressed to JARVIS at all - a TV/radio mention, someone else in
    // the room named Jarvis, a person talking ABOUT JARVIS rather than
    // TO it. Run before the filler/response below so a false wake-word
    // trigger doesn't cost a real LLM call, TTS synthesis, or an
    // out-of-place spoken reply to overheard conversation.
    if (this.config.conversation.directedAtJarvisCheck) {
      const directed = await this.classifyDirectedAtJarvis(result.text);
      // A barge-in during this classification call already started a
      // whole new turn (handleWakeWord() ran, turnId moved on) - bail
      // out rather than act on a stale classification for a turn that's
      // no longer current, same pattern as every other await point below.
      if (this.turnId !== myTurnId) return;
      if (!directed) {
        console.log(`   🙉 Not directed at JARVIS - ignoring, resuming listening`);
        this.emit("speech-not-directed", result);
        this.context.isActive = false;
        if (this.wakeWordDetector && this.isRunning) {
          await this.wakeWordDetector.startListening();
        }
        return;
      }
    }

    // Real "thinking" acknowledgment (2026-08-31) - see fillerAudio's own
    // comment above for the full story. Played and awaited BEFORE the
    // slow respondToText() call below, not overlapping it - this stays
    // within the existing sequential LISTEN -> THINK -> SPEAK -> WAIT
    // design; it just adds one more real, short SPEAK step ahead of the
    // slow one instead of dead air. Best-effort: a filler synthesis/
    // playback failure is logged but never blocks the real response.
    const filler = await this.ensureFillerAudio();
    if (filler) {
      try {
        await this.playInterruptible(filler.audio);
      } catch (err) {
        console.log(`   ⚠️  Filler playback failed (non-fatal): ${err instanceof Error ? err.message : err}`);
      }
      // A barge-in during the filler already started a whole new turn
      // (handleWakeWord() ran, turnId moved on) - stop here rather than
      // generate/speak a reply to a question that's no longer current.
      if (this.turnId !== myTurnId) return;
    }

    const { response, audio } = await this.respondToText(result.text);
    // The "thinking" gap itself (the real LLM/app-control/TTS-synthesis
    // call above) isn't currently interruptible - JARVIS isn't speaking
    // during it, so there's nothing playing to barge in on; a wake word
    // said during this gap is handled as an ordinary new turn once this
    // one's stale response is discarded here, not as a special case.
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
      // Block on real playback (see playInterruptible's own comment for
      // what makes this interruptible now, unlike a plain playWavBuffer
      // call).
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

    // Resume listening for next wake word
    if (this.wakeWordDetector && this.isRunning) {
      await this.wakeWordDetector.startListening();
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
   * Run one text-in, text-and-audio-out turn: push the user turn, get a
   * real JARVIS response, synthesize it if TTS is enabled, push the
   * assistant turn. Shared by the mic pipeline (handleUserSpeech) and any
   * text-only caller (e.g. the `voice-reply` CLI command, which has no
   * mic to drive the wake-word/STT half of the pipeline).
   */
  async respondToText(userText: string): Promise<{ response: string; audio?: SynthesisResult }> {
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

    let audio: SynthesisResult | undefined;
    if (this.speechSynthesizer) {
      audio = await this.speechSynthesizer.synthesize(response);
      this.emit("audio-ready", audio);
    }

    return { response, audio };
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
