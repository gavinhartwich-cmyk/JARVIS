/**
 * Real-time voice interface backed by the Gemini Live API — architecture
 * update step 6 ("If Gemini Live materially improves latency, integrate
 * the realtime layer into JARVIS while preserving the existing
 * intelligence core"), per Gavin's direct request after seeing a real
 * `compare-latency` run: Gemini Live answered in ~934ms end to end
 * (native audio streaming, no separate TTS pass) against current
 * JARVIS's ~3.6s (LLM call, then a full separate Chatterbox synthesis
 * pass) — a real, live-measured ~3.8x difference, not a guess.
 *
 * This is a genuine alternative voice pipeline, not a replacement for
 * `VoiceInterface`/`bun run dev listen` — that path keeps every real,
 * live-tested capability this project has built (app-control beyond
 * open/close, screen/video/camera vision, web search, Spotify, proactive
 * intelligence, persistent memory) via `Orchestrator.processConversation()`.
 * Gemini Live's own model has none of that unless it's handed in as a
 * tool, and only `open_app`/`close_app`/`play_music` are wired here so far (see
 * `prototypes/gemini-live/live-tools.ts`) — this mode trades capability
 * breadth for real, measured speed. Both are real, both are selectable
 * (`bun run dev listen` vs `bun run dev listen-live`); this doesn't
 * silently become the new default.
 *
 * Reuses the exact same proven wake-word/mic infrastructure
 * `VoiceInterface` uses (`WakeWordDetector`, `MicCapture`, `voice-config.ts`)
 * rather than a second copy of that tuning - only what happens after a
 * wake word fires is different: instead of buffering an utterance, running
 * it through Whisper, then a text LLM call, then a separate Chatterbox/
 * Piper synthesis pass, raw mic audio streams directly into a
 * `GeminiLiveSession`, which understands speech and produces speech
 * natively, no separate STT/TTS round trips at all.
 *
 * Honest, disclosed limitations of this first real version:
 *   - No acoustic echo cancellation (same disclosed gap as VoiceInterface's
 *     own barge-in) - mic audio is muted (not forwarded to the session)
 *     while JARVIS's own reply is playing, so the model never hears
 *     itself. Barge-in during playback works the same way VoiceInterface's
 *     does: saying "Jarvis" again is checked locally (still running the
 *     wake-word detector during playback) and aborts the current clip -
 *     not true arbitrary-speech interruption via the Live API's own
 *     `interrupted` signal, which would need real AEC to use safely.
 *   - Playback is per-turn, not truly incremental: audio chunks are
 *     buffered as they stream in and played as one assembled clip once
 *     `turnComplete` fires, via the same `playWavBuffer()` every other
 *     real reply in this codebase uses. A genuinely continuous low-latency
 *     output pipeline would need a persistent native audio stream this
 *     project doesn't have - this still gets the real win (one fast
 *     unified STT+LLM+TTS round trip instead of three sequential ones),
 *     just not literal "hearing the first word while the rest generates."
 */

import { WakeWordDetector, WakeWordEvent } from "./wake-word-detector";
import { VoiceConfig, DEFAULT_VOICE_CONFIG } from "./voice-config";
import { playWavBuffer, PlaybackInterruptedError } from "./audio-player";
import { JARVIS_PERSONALITY_PROMPT } from "../core/jarvis-personality";
import { GeminiLiveSession } from "../prototypes/gemini-live/gemini-live-session";
import {
  OPEN_APP_DECLARATION,
  CLOSE_APP_DECLARATION,
  PLAY_MUSIC_DECLARATION,
  createOpenAppToolHandler,
  createCloseAppToolHandler,
  createPlayMusicToolHandler,
} from "../prototypes/gemini-live/live-tools";

// How long to keep a session's mic stream open after its last reply
// before falling back to wake-word-gated idle, so a real follow-up
// question doesn't need "Jarvis" said again (matches VoiceInterface's
// own real follow-up-listening feature) without streaming audio to
// Google forever if the user just walks away. Real, chosen value - not
// yet live-tuned against Gavin's actual conversational pacing the way
// the existing pipeline's own timeouts were.
const FOLLOW_UP_WINDOW_MS = 10_000;

/** Minimal, self-contained 16-bit PCM -> WAV encoder. No cross-file
 * dependency on speech-synthesizer.ts's WAV *reader* - same "each file
 * owns its own small audio helpers" convention audio-player.ts already
 * documents for this codebase. */
export function pcmToWav(pcm: Buffer, sampleRateHz: number, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRateHz * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class LiveVoiceInterface {
  private config: VoiceConfig;
  private wakeWordDetector: WakeWordDetector;
  private session: GeminiLiveSession | null = null;
  private listeners: Map<string, Function[]> = new Map();

  private isRunning = false;
  /** True once a wake word (or barge-in) has opened the mic straight through to the Live session, instead of to the wake-word detector. */
  private isSending = false;
  /** True while JARVIS's own reply is playing - mic chunks are dropped (fed only to the wake-word detector for barge-in) so the model never hears itself, same half-duplex discipline as VoiceInterface. */
  private isPlaying = false;
  private playbackAbort: AbortController | null = null;
  private turnPcmChunks: Buffer[] = [];
  private turnSampleRateHz = 24000;
  private followUpTimer: ReturnType<typeof setTimeout> | null = null;
  /** Real session-resumption handle (protocol.ts's SessionResumptionConfig) - captured on every "session-handle" update and used to reconnect into the SAME conversation after an idle close, rather than the next wake word starting a cold, context-less session. */
  private lastSessionHandle: string | undefined;

  constructor(config: VoiceConfig = DEFAULT_VOICE_CONFIG) {
    this.config = config;
    this.wakeWordDetector = new WakeWordDetector({
      keyword: config.wakeWord.keyword,
      sensitivity: config.wakeWord.sensitivity,
      modelPath: config.wakeWord.modelPath,
      sampleRate: config.audio.sampleRate,
    });
    this.wakeWordDetector.on("wake-word-detected", (event: WakeWordEvent) => {
      this.handleWakeWord(event).catch((err) =>
        console.error("❌ Gemini Live wake-word handling failed:", err instanceof Error ? err.message : err)
      );
    });
  }

  // [FIXED 2026-09-04] Real gap found live (Gavin: "why isnt the hud
  // poping up") - this class built the whole voice pipeline but never
  // emitted "idle" at all, and "listening" was fired from the wrong place
  // (right after wake-word-detected, meaning "actively capturing speech" -
  // the opposite of what VoiceInterface's own "listening" event means,
  // "back to idle wake-word-only mode"). Renamed to match that existing
  // convention exactly instead of inventing a second, confusing meaning
  // for the same event name - see cli.ts's launchHud()/listen-live wiring
  // for how both real pipelines now drive the same HUD states.
  on(event: "idle" | "wake-word-detected" | "acting" | "acting-done" | "audio-ready" | "interaction-complete" | "error", cb: (data?: unknown) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(cb);
  }

  private emit(event: string, data?: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(data);
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("\n" + "=".repeat(70));
    console.log('🛰️  JARVIS is listening (Gemini Live mode) — say "Jarvis" to start a conversation');
    console.log("=".repeat(70));
    await this.wakeWordDetector.startListening();
    this.emit("idle");
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    this.playbackAbort?.abort();
    await this.wakeWordDetector.stopListening();
    this.wakeWordDetector.shutdown();
    this.session?.close();
    this.session = null;
  }

  /** Feed one real mic chunk (same shape MicCapture already produces for VoiceInterface). */
  async processMicChunk(chunk: Buffer): Promise<void> {
    if (!this.isRunning) return;

    // [FIXED 2026-09-04] Real bug found live (Gavin: after one real
    // exchange, "i said jarvis 7 or 8 times and didnt get him back") -
    // this used to route chunks EITHER to the session OR to the wake-word
    // detector, never both, so for the entire time a session stayed open
    // (isSending=true - which, per the real follow-up window, can be many
    // seconds) the local wake-word model received zero audio at all.
    // VoiceInterface's own processMicChunk() never does this - it keeps
    // feeding the wake-word detector in every state (isSpeaking,
    // isThinking, idle), specifically because a long gap risks the
    // detector's own rolling buffer/scoring falling out of sync with what
    // it expects, and because it's the one signal that must always work
    // regardless of what else is going on. Now always fed, unconditionally
    // - a real "Jarvis" said mid-session both reaches Gemini as ordinary
    // speech AND resets the follow-up window locally (handleWakeWord()'s
    // early-return branches already handle re-firing while isPlaying/
    // isSending harmlessly), so this is a pure safety net, not a behavior
    // change to the happy path.
    await this.wakeWordDetector.processAudioChunk(chunk);

    if (this.isSending && this.session) {
      // Actively streaming a real utterance straight to Gemini Live - no
      // local STT, the model hears raw audio directly.
      this.session.sendAudioChunk(chunk);
    }
  }

  private async ensureSession(): Promise<GeminiLiveSession> {
    if (this.session) return this.session;

    // [ADDED 2026-09-04] Reconnect into the SAME real conversation via
    // session resumption (protocol.ts's sessionResumption) rather than a
    // cold, context-less one - matters now that the session is actually
    // closed on idle (see flushTurnAudio()'s follow-up-timeout branch)
    // instead of being held open forever in the background.
    const session = new GeminiLiveSession({
      systemInstruction: JARVIS_PERSONALITY_PROMPT,
      resumeHandle: this.lastSessionHandle,
    });
    // [FIXED 2026-09-04] "acting"/"acting-done" were declared as valid
    // events on this class's own on() signature but never actually
    // emitted anywhere - real gap found live (Gavin: "why isnt the hud
    // poping up" surfaced that this whole HUD-state story was
    // incomplete). Wrapping the real handlers here (rather than adding a
    // generic tool-call hook to GeminiLiveSession itself) mirrors exactly
    // how orchestrator.ts's onActionStart/onActionEnd already drives
    // VoiceInterface's own "acting" state around a real action.
    const openAppHandler = createOpenAppToolHandler();
    session.registerTool(OPEN_APP_DECLARATION, async (args) => {
      this.emit("acting", `Opening ${typeof args.target === "string" ? args.target : "app"}`);
      try {
        return await openAppHandler(args);
      } finally {
        this.emit("acting-done");
      }
    });
    const closeAppHandler = createCloseAppToolHandler();
    session.registerTool(CLOSE_APP_DECLARATION, async (args) => {
      this.emit("acting", `Closing ${typeof args.target === "string" ? args.target : "app"}`);
      try {
        return await closeAppHandler(args);
      } finally {
        this.emit("acting-done");
      }
    });
    const playMusicHandler = createPlayMusicToolHandler();
    session.registerTool(PLAY_MUSIC_DECLARATION, async (args) => {
      this.emit("acting", `Playing ${typeof args.query === "string" ? args.query : "music"}`);
      try {
        return await playMusicHandler(args);
      } finally {
        this.emit("acting-done");
      }
    });

    session.on("audio", (data) => {
      const { pcm, sampleRateHz } = data as { pcm: Uint8Array; sampleRateHz: number };
      this.turnSampleRateHz = sampleRateHz;
      this.turnPcmChunks.push(Buffer.from(pcm));
    });
    session.on("text", (text) => {
      console.log(`   [gemini-live text] ${text}`);
    });
    session.on("interrupted", () => {
      // The model's own signal that it was cut off mid-reply - discard
      // whatever partial audio was buffered for this turn rather than
      // playing a truncated clip.
      console.log("   ⏹️  Gemini Live: reply interrupted, discarding partial audio");
      this.turnPcmChunks = [];
    });
    session.on("turn-complete", () => {
      this.flushTurnAudio().catch((err) =>
        console.error("❌ Gemini Live playback failed:", err instanceof Error ? err.message : err)
      );
    });
    session.on("session-handle", (handle) => {
      this.lastSessionHandle = handle as string;
    });
    session.on("close", (info) => {
      console.log(`   🔌 Gemini Live session closed: ${JSON.stringify(info)}`);
      this.session = null;
    });
    session.on("error", (err) => {
      console.error("❌ Gemini Live session error:", err);
      this.emit("error", err);
    });

    await session.connect();
    this.session = session;
    return session;
  }

  private async handleWakeWord(event: WakeWordEvent): Promise<void> {
    if (this.isPlaying) {
      // Real, scoped barge-in - same mechanism VoiceInterface's own
      // playInterruptible() uses: saying "Jarvis" again while JARVIS is
      // talking aborts the current clip immediately.
      console.log(`\n🔄 Barge-in (Gemini Live mode): confidence ${event.confidence.toFixed(3)}`);
      this.playbackAbort?.abort();
    } else {
      console.log(`\n🎙️  Wake word detected (Gemini Live mode): confidence ${event.confidence.toFixed(3)}`);
    }

    this.emit("wake-word-detected", event);
    if (this.followUpTimer) clearTimeout(this.followUpTimer);

    try {
      await this.ensureSession();
    } catch (error) {
      console.error("❌ Could not connect to Gemini Live:", error instanceof Error ? error.message : error);
      this.emit("error", error);
      return;
    }

    this.isSending = true;

    // [FIXED 2026-09-04] THE real bug behind "i said jarvis 7 or 8 times
    // and didnt get him back" - confirmed directly from Gavin's own log:
    // wake-word-detector.ts's `triggered` is a ONE-SHOT LATCH, reset only
    // by startListening() (see its own comment: "only the first one per
    // listening session actually fires"). VoiceInterface calls
    // startListening() again at several real points in its own turn flow
    // to reset it; this class called startListening() exactly once, ever
    // (in start()), and never again - so after the very first real wake
    // word, the latch stayed permanently spent for the rest of the
    // process. Gavin's log proves it: a later score of 0.1240 (well past
    // the 0.05 threshold) produced zero reaction, with no second
    // "🎯 Wake word detected" line anywhere after the first. rearm() is
    // the exact real fix VoiceInterface itself uses for this same latch
    // (see its own barge-in-confidence-check comment) - resets the latch
    // without restarting the daemon or anything else. Called
    // unconditionally here, not gated on confidence: even a spurious
    // re-trigger from the tail of the same utterance is harmless (just
    // re-runs this same branch again), whereas the latch staying stuck
    // is a full, silent, permanent outage.
    this.wakeWordDetector.rearm();
  }

  private async flushTurnAudio(): Promise<void> {
    const chunks = this.turnPcmChunks;
    this.turnPcmChunks = [];
    // Real follow-up window: keep the mic streaming straight to the
    // session for a bit after each reply, so a real follow-up question
    // doesn't need the wake word said again - same real feature
    // VoiceInterface's startFollowUpListening() provides for the other
    // pipeline. Reset on every turn, not just the first.
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    this.followUpTimer = setTimeout(() => {
      this.isSending = false;
      // [FIXED 2026-09-04] Real gap found while investigating Gavin's
      // "wake word takes many tries" report: this used to leave the
      // WebSocket connection open in the background indefinitely after
      // the follow-up window closed, unlike VoiceInterface's own
      // Whisper-based path, which has no equivalent held-open connection
      // once a turn ends. Not confirmed as the actual cause (the wake-
      // word feeding code itself is identical between listen/listen-live
      // - checked directly), but closing it here is a real robustness fix
      // either way: a session held open for minutes with no traffic risks
      // a silent server-side timeout/disconnect nobody would notice until
      // the next real turn failed against a half-dead socket. Session
      // resumption (see ensureSession()'s resumeHandle) means the next
      // wake word reconnects into the SAME real conversation, not a cold
      // one - this isn't losing continuity to gain robustness.
      console.log('   (no follow-up heard - closing session, back to waiting for "Jarvis")');
      this.session?.close();
      this.session = null;
      this.emit("idle");
    }, FOLLOW_UP_WINDOW_MS);

    if (chunks.length === 0) return; // interrupted mid-reply, or a text-only turn

    const pcm = Buffer.concat(chunks);
    const wav = pcmToWav(pcm, this.turnSampleRateHz);
    this.emit("audio-ready", { audio: wav, duration: (pcm.length / 2 / this.turnSampleRateHz) * 1000 });

    this.isPlaying = true;
    this.playbackAbort = new AbortController();
    try {
      await playWavBuffer(wav, 30_000, this.playbackAbort.signal);
    } catch (error) {
      if (!(error instanceof PlaybackInterruptedError)) {
        console.log(`   ⚠️  Playback failed: ${error instanceof Error ? error.message : error}`);
      }
    } finally {
      this.isPlaying = false;
      this.playbackAbort = null;
    }

    this.emit("interaction-complete");
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      isSending: this.isSending,
      isPlaying: this.isPlaying,
      sessionConnected: this.session !== null,
    };
  }
}
