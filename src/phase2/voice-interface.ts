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
import { findCachedAnswer, recordCacheableEpisode } from "../core/episode-cache";
import { telemetry, Stage } from "../core/telemetry";
import { classifyIntent, type KnownAction } from "../core/intent-router";
import { ScreenControl } from "../phase3/screen-control";
import { identityEngine } from "../core/identity";

const JARVIS_SYSTEM_PROMPT =
  "You are JARVIS, a helpful voice assistant. Keep replies short and " +
  "conversational (1-3 sentences) since they will be spoken aloud, not read.";

// REASONING path (architecture update section 1/2): same single model call
// as FAST, but asked to actually weigh the question instead of giving a
// quick take. Not yet backed by any retrieval/tool augmentation — see
// core/intent-router.ts's header comment for why that's still a TODO.
const REASONING_SYSTEM_PROMPT =
  "You are JARVIS, a helpful voice assistant. This question asks for a real " +
  "comparison or judgment call, not just a fact — weigh the actual trade-offs " +
  "before answering. Keep the spoken reply concise (3-5 sentences), but do not " +
  "skip the reasoning to get there.";

/**
 * A handler for the DEEP path (architecture update section 1/9): the
 * existing multi-agent pipeline. Deliberately a plain callback rather than
 * VoiceInterface importing Orchestrator directly — this keeps the voice
 * layer usable (and testable) without pulling in the whole agent/DB/tool
 * stack, and keeps "which intelligence backs DEEP" a caller-supplied detail
 * rather than a hardcoded dependency, in the spirit of provider-independence
 * (section 6).
 */
export type DeepHandler = (utterance: string) => Promise<string>;

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
  private screenControl: ScreenControl;
  private deepHandler?: DeepHandler;

  private context: VoiceInteractionContext;
  private isRunning: boolean = false;

  // Event listeners
  private listeners: Map<string, Function[]> = new Map();

  constructor(
    config: VoiceConfig = DEFAULT_VOICE_CONFIG,
    modelProvider?: ModelProvider,
    deepHandler?: DeepHandler
  ) {
    this.config = config;
    // Same Gemini -> Ollama -> OpenRouter gateway Phase 1 uses, so a voice
    // reply degrades to the local model instead of dying on a 429 too.
    this.modelProvider = modelProvider || new GatewayModelProvider(createDefaultGateway());
    this.screenControl = new ScreenControl();
    this.deepHandler = deepHandler;
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
    this.emit("wake-word-detected", event);

    // Start listening for speech
    if (this.speechRecognizer) {
      await this.speechRecognizer.startStreaming();
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
    // Architecture update section 7: measure every stage of the live reply
    // path (not just total time), so a slow turn shows *where* the time
    // went instead of just that it happened.
    const traceId = telemetry.start("voice.respondToText");
    telemetry.mark(traceId, Stage.INPUT_RECEIVED);

    this.context.messageHistory.push({
      role: "user",
      content: userText,
      timestamp: new Date(),
    });

    const response = await this.generateResponse(userText, traceId);

    this.context.messageHistory.push({
      role: "assistant",
      content: response,
      timestamp: new Date(),
    });

    let audio: SynthesisResult | undefined;
    if (this.speechSynthesizer) {
      try {
        audio = await this.speechSynthesizer.synthesize(response);
        telemetry.mark(traceId, Stage.FIRST_AUDIO);
        this.emit("audio-ready", audio);
      } catch (error) {
        // A missing/broken TTS binary shouldn't take down a turn that
        // otherwise succeeded — degrade to a text-only reply instead,
        // same as the `voice-reply` CLI already does for "TTS disabled".
        const err = error instanceof Error ? error.message : String(error);
        console.error("❌ Text-to-speech synthesis failed, returning text-only reply:", err);
        telemetry.mark(traceId, Stage.FIRST_AUDIO, "tts_failed");
      }
    }

    telemetry.finish(traceId);
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
  private async generateResponse(userInput: string, traceId?: string): Promise<string> {
    this.emit("jarvis-responding", { input: userInput });

    console.log(`\n🤖 JARVIS processing: "${userInput}"`);

    // Intent/Complexity Router (architecture update sections 1, 2, 9):
    // decide which of FAST/TOOL/REASONING/DEEP this turn needs *before*
    // spending a model call — routing itself is pattern-based, not an LLM
    // call, so using it never costs more than skipping it would have saved.
    const route = classifyIntent(userInput);
    if (traceId) telemetry.mark(traceId, Stage.INTENT_ROUTING, route.path);
    console.log(`   Route: ${route.path} (${route.reason})`);

    if (route.path === "tool" && route.action) {
      // Section 8: a known action goes straight to its deterministic
      // executor — no LLM call to "translate" it first.
      return this.executeKnownAction(route.action, traceId);
    }

    if (route.path === "deep") {
      if (this.deepHandler) {
        try {
          const result = await this.deepHandler(userInput);
          if (traceId) telemetry.mark(traceId, Stage.AGENT_EXECUTION, "deep");
          console.log(`🤖 JARVIS (deep): "${result}"`);
          return result;
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          console.error("❌ Deep pipeline failed, falling back to a direct reply:", err);
          if (traceId) telemetry.mark(traceId, Stage.AGENT_EXECUTION, "deep_failed_fallback");
          // Fall through to the direct single-call path below rather than
          // leaving the user with nothing.
        }
      } else {
        console.log("   (no deep handler configured — answering directly instead)");
      }
    }

    // Persistent episode cache: skips the full reply-generation call below
    // entirely on a verified hit. Gated on question stability (never for
    // action requests or anything time/context-dependent) and confirmed by
    // a small LLM check before being served — see core/episode-cache.ts.
    const cached = await findCachedAnswer(userInput, this.modelProvider);
    if (cached) {
      console.log(`🗄️  JARVIS (cached): "${cached}"`);
      if (traceId) telemetry.mark(traceId, Stage.FIRST_TOKEN, "cache_hit");
      return cached;
    }

    const recentHistory = this.context.messageHistory.slice(-6, -1); // exclude the just-pushed user turn
    const messages = [
      ...recentHistory.map((turn) => ({
        role: turn.role,
        content: turn.content,
      })),
      { role: "user" as const, content: userInput },
    ];

    const isReasoning = route.path === "reasoning";
    let response: string;
    try {
      if (traceId) telemetry.mark(traceId, Stage.PROVIDER_CONNECTION, this.modelProvider.name);
      const result = await this.modelProvider.complete(messages, {
        systemPrompt: isReasoning ? REASONING_SYSTEM_PROMPT : JARVIS_SYSTEM_PROMPT,
        maxTokens: isReasoning ? 400 : 200,
      });
      // "first_token" is a bit of a misnomer here — modelProvider.complete()
      // is not streaming, so this mark actually lands at full completion.
      // That gap (no true time-to-first-token on the fast path yet) is
      // itself one of the findings this instrumentation exists to surface;
      // see ARCHITECTURE-UPDATE-ADAPTIVE-PROCESSING.md section 4.
      if (traceId) telemetry.mark(traceId, Stage.FIRST_TOKEN, "non-streaming");
      response = result.content.trim();
      // Fire-and-forget: recordCacheableEpisode no-ops for action requests
      // and time/context-dependent questions, and never throws (memory
      // failures shouldn't block or slow down the response).
      void recordCacheableEpisode(userInput, response);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      console.error("❌ JARVIS response generation failed:", err);
      this.emit("error", { message: err });
      response = "Sorry, I couldn't reach any model provider to answer that.";
      if (traceId) telemetry.mark(traceId, Stage.FIRST_TOKEN, "error");
    }

    console.log(`🤖 JARVIS: "${response}"`);
    return response;
  }

  /**
   * TOOL path executor (architecture update section 8): runs a known
   * action deterministically through ScreenControl — no model call at all,
   * matching or failing exactly as the underlying automation does. Only
   * open/close are wired to a real executor today; extending this to more
   * verbs belongs with building each one's executor (capability registry,
   * architecture doc step 8), not with guessing here that one exists.
   */
  private async executeKnownAction(action: KnownAction, traceId?: string): Promise<string> {
    let result: { success: boolean; error?: string };
    try {
      const identity = await identityEngine.resolveFromDeviceSession();
      result =
        action.name === "open_app"
          ? await this.screenControl.openApp(action.target, identity)
          : await this.screenControl.closeApp(action.target, identity);
    } catch (error) {
      // Covers both a failed automation call and a failed identity
      // resolution (e.g. no database configured) — either way this must
      // degrade to a spoken error, not crash the whole turn.
      result = { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (traceId) telemetry.mark(traceId, Stage.TOOL_EXECUTION, action.name);

    if (result.success) {
      const verb = action.name === "open_app" ? "Opening" : "Closing";
      return `${verb} ${action.target}.`;
    }
    console.error(`❌ ${action.name} "${action.target}" failed:`, result.error);
    return `I couldn't ${action.name === "open_app" ? "open" : "close"} ${action.target}: ${result.error ?? "unknown error"}.`;
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
