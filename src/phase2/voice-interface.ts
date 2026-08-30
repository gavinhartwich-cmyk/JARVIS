/**
 * Phase 2: Natural Voice Interface
 *
 * Complete voice interaction pipeline:
 * Microphone → Wake Word → Speech Recognition → JARVIS Core →
 * Response Generation → Text-to-Speech → Speaker
 */

import { WakeWordDetector, WakeWordEvent } from "./wake-word-detector";
import { SpeechRecognizer, RecognitionResult } from "./speech-recognizer";
import { SpeechSynthesizer, SynthesisResult } from "./speech-synthesizer";
import { VoiceConfig, DEFAULT_VOICE_CONFIG } from "./voice-config";
import { createDefaultGateway, GatewayModelProvider } from "../models/llm-gateway";
import type { ModelProvider } from "../models/types";
import { playWavBuffer } from "./audio-player";

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

// A real signal-energy threshold has to be tuned against an actual room
// and microphone, not guessed - this default is a reasonable starting
// point for 16-bit PCM (16-bit full scale is 32768; ~1.5% of full scale
// is a common floor for "someone is plainly talking" vs. room noise) but
// WILL likely need tuning on Gavin's actual hardware, the same honest
// caveat wake-word-detector.ts's sensitivity default carries.
const SPEECH_RMS_THRESHOLD = 500;

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

const JARVIS_SYSTEM_PROMPT =
  "You are JARVIS, a helpful voice assistant. Keep replies short and " +
  "conversational (1-3 sentences) since they will be spoken aloud, not read.";

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
  private speechSynthesizer?: SpeechSynthesizer;
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
  private isSpeaking: boolean = false;
  // Per-turn VAD state (see END_OF_TURN_SILENCE_MS / computeRmsEnergy
  // above) - reset in handleWakeWord() at the start of each turn.
  private turnSilenceMs: number = 0;
  private turnHasSpeech: boolean = false;
  private turnStartedAt: number = 0;

  // Event listeners
  private listeners: Map<string, Function[]> = new Map();

  constructor(config: VoiceConfig = DEFAULT_VOICE_CONFIG, modelProvider?: ModelProvider) {
    this.config = config;
    // Same Gemini -> Ollama -> OpenRouter gateway Phase 1 uses, so a voice
    // reply degrades to the local model instead of dying on a 429 too.
    this.modelProvider = modelProvider || new GatewayModelProvider(createDefaultGateway());
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
      this.speechSynthesizer = new SpeechSynthesizer({
        voiceId: this.config.textToSpeech.voiceId,
        speakingRate: this.config.textToSpeech.speakingRate,
        outputFormat: this.config.textToSpeech.outputFormat,
        modelPath: this.config.textToSpeech.modelPath,
        sampleRate: this.config.audio.sampleRate,
      });
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
    }

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
    console.log(`\n✨ Wake word detected! Starting conversation...`);

    this.context.isActive = true;
    this.context.lastWakeWordTime = new Date();
    this.turnSilenceMs = 0;
    this.turnHasSpeech = false;
    this.turnStartedAt = Date.now();
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
    if (!this.isRunning || this.isSpeaking) return;

    if (!this.context.isActive) {
      // Idle: only the wake-word detector cares about audio right now.
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
    const isSpeechEnergy = computeRmsEnergy(chunk) > SPEECH_RMS_THRESHOLD;
    if (isSpeechEnergy) {
      this.turnHasSpeech = true;
      this.turnSilenceMs = 0;
    } else {
      this.turnSilenceMs += chunkMs;
    }

    const turnDurationMs = Date.now() - this.turnStartedAt;
    const hitSilenceCutoff = this.turnHasSpeech && this.turnSilenceMs >= END_OF_TURN_SILENCE_MS;
    const hitMaxDuration = turnDurationMs >= this.config.conversation.maxTurnDuration * 1000;

    if ((hitSilenceCutoff || hitMaxDuration) && this.speechRecognizer) {
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
   * Handle user speech recognition
   */
  private async handleUserSpeech(result: RecognitionResult) {
    console.log(`\n👤 User said: "${result.text}"`);
    this.emit("user-speech-recognized", result);

    const { response, audio } = await this.respondToText(result.text);

    if (audio) {
      console.log(`\n🔊 Response ready: ${audio.duration}ms`);
      // Block on real playback, and drop mic input for its duration (see
      // isSpeaking above) - both real fixes, not just bookkeeping: without
      // the first, nothing anyone could ever actually hear was produced;
      // without the second, JARVIS's own voice coming back through the
      // mic could re-trigger the wake word or get transcribed as if the
      // user had said it.
      this.isSpeaking = true;
      try {
        await playWavBuffer(audio.audio);
      } catch (err) {
        console.log(`   ⚠️  Playback failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        this.isSpeaking = false;
      }
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
    // Honest gap, noted 2026-08-27: unlike `Orchestrator.processConversation()`
    // (core/orchestrator.ts), this path does NOT detect/execute app-control
    // intents ("open Spotify") — it's a deliberately lighter, identity-less
    // call (see this method's doc comment above), and wiring real execution
    // in here would need the same identity/authorization resolution the
    // orchestrator path already has. Not built here yet because voice-reply
    // has no microphone input anyway (text-in/audio-out only, per this
    // file's header) — worth revisiting once real mic capture makes this
    // the primary interactive surface, at which point it should probably
    // route through the orchestrator path instead of duplicating the logic.
    this.emit("jarvis-responding", { input: userInput });

    console.log(`\n🤖 JARVIS processing: "${userInput}"`);

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
      response = "Sorry, I couldn't reach any model provider to answer that.";
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
