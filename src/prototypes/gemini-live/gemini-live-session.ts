/**
 * Gemini Live API session — the WebSocket half of the architecture update's
 * step 4 prototype.
 *
 * Deliberately isolated (own directory, no imports from phase2/core other
 * than the one real tool it wires up) and deliberately NOT wired into
 * VoiceInterface — per the architecture doc, this is something to build
 * and compare (step 5), not integrate, until it's proven to actually help
 * (step 6).
 *
 * UNVERIFIED against a live connection: this sandbox has no GEMINI_API_KEY
 * and no microphone/speaker hardware. The message shapes are transcribed
 * from Google's current documentation (see protocol.ts's header), not
 * assumed from memory, but "matches the docs" and "actually works against
 * the live endpoint" are different claims — treat the first real run
 * (`bun run dev live-prototype`, on a machine with a real key) as the
 * actual verification, same convention as gemini-provider.ts and
 * windows-control.ts elsewhere in this codebase.
 *
 * No SDK dependency, same reasoning as the rest of src/models/*: a raw
 * WebSocket call avoids adding a package for something this small.
 */

import type {
  ClientMessage,
  FunctionCall,
  FunctionDeclaration,
  FunctionResponse,
  ServerMessage,
} from "./protocol";
import { buildAudioChunkMessage, decodeAudioPart, isAudioPart } from "./protocol";

const LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export interface GeminiLiveSessionConfig {
  apiKey?: string;
  /** Full "models/..." resource name. Live API model names move faster than the regular API's — override via GEMINI_LIVE_MODEL if this default has drifted. */
  model?: string;
  systemInstruction?: string;
  /** Resume a previous session — pass the handle from a prior "session-handle" event. */
  resumeHandle?: string;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * Minimal realtime session wrapper: connect, send text/audio, receive
 * streamed audio/text, react to interruption, resume across reconnects,
 * and call registered tools. Uses the same plain listener-map pattern as
 * VoiceInterface (phase2/voice-interface.ts) rather than pulling in
 * node:events, for consistency with the rest of this codebase.
 */
export class GeminiLiveSession {
  private apiKey: string;
  private model: string;
  private systemInstruction?: string;
  private sessionHandle?: string;

  private ws?: WebSocket;
  private listeners: Map<string, Array<(data: unknown) => void>> = new Map();
  private tools: FunctionDeclaration[] = [];
  private toolHandlers: Map<string, ToolHandler> = new Map();

  constructor(config: GeminiLiveSessionConfig = {}) {
    this.apiKey = config.apiKey || process.env.GEMINI_API_KEY || "";
    // gemini-2.0-flash-live-001 is a known-stable Live API model id as of
    // this writing; the search that verified the WebSocket message shapes
    // (2026-09-04) surfaced a newer "gemini-3.1-flash-live-preview" example
    // too — GEMINI_LIVE_MODEL lets it be swapped without a code change once
    // whichever's actually available to this project's key is confirmed.
    this.model = config.model || process.env.GEMINI_LIVE_MODEL || "models/gemini-2.0-flash-live-001";
    this.systemInstruction = config.systemInstruction;
    this.sessionHandle = config.resumeHandle;
  }

  on(event: "ready" | "audio" | "text" | "interrupted" | "session-handle" | "close" | "error", cb: (data: unknown) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(cb);
  }

  private emit(event: string, data?: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(data);
  }

  /**
   * Register a JARVIS capability as a Live API tool. Call before connect()
   * — tools are declared once, in the setup message.
   */
  registerTool(declaration: FunctionDeclaration, handler: ToolHandler): void {
    this.tools.push(declaration);
    this.toolHandlers.set(declaration.name, handler);
  }

  /** The current session-resumption handle, if any — persist this to actually reconnect into the same session later. */
  get currentSessionHandle(): string | undefined {
    return this.sessionHandle;
  }

  async connect(): Promise<void> {
    if (!this.apiKey) {
      throw new Error("GEMINI_API_KEY not set — required for the Gemini Live prototype.");
    }

    const url = `${LIVE_ENDPOINT}?key=${this.apiKey}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.send({
          setup: {
            model: this.model,
            responseModalities: ["AUDIO"],
            systemInstruction: this.systemInstruction
              ? { parts: [{ text: this.systemInstruction }] }
              : undefined,
            tools: this.tools.length > 0 ? [{ functionDeclarations: this.tools }] : undefined,
            sessionResumption: { handle: this.sessionHandle },
          },
        });
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        this.handleServerMessage(event.data).catch((err) => this.emit("error", err));
        if (!settled) {
          // setupComplete is handled inside handleServerMessage, which
          // emits "ready" — resolve connect() the first time that fires.
        }
      });

      this.on("ready", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.addEventListener("error", (event: Event) => {
        const err = new Error("Gemini Live WebSocket error");
        this.emit("error", err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.addEventListener("close", (event: CloseEvent) => {
        this.emit("close", { code: event.code, reason: event.reason });
      });
    });
  }

  private send(message: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
      throw new Error("Gemini Live session is not connected — call connect() first.");
    }
    this.ws.send(JSON.stringify(message));
  }

  /** Send a text turn (useful for testing without a microphone). */
  sendText(text: string): void {
    this.send({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    });
  }

  /** Streams one chunk of raw 16-bit PCM, 16kHz mono audio — the shape a real microphone capture loop would call repeatedly. */
  sendAudioChunk(pcm16leBytes: Uint8Array): void {
    this.send(buildAudioChunkMessage(pcm16leBytes));
  }

  close(): void {
    this.ws?.close();
  }

  private async handleServerMessage(raw: unknown): Promise<void> {
    const text = typeof raw === "string" ? raw : String(raw);
    let message: ServerMessage;
    try {
      message = JSON.parse(text);
    } catch {
      return; // not a JSON text frame — ignore
    }

    if (message.setupComplete !== undefined) {
      this.emit("ready");
      return;
    }

    if (message.serverContent) {
      const content = message.serverContent;

      // Section 5 (barge-in): the whole point of this flag is "stop
      // playback now" — emit it before anything else in this message so a
      // listener can empty its playback queue immediately.
      if (content.interrupted) {
        this.emit("interrupted");
      }

      for (const part of content.modelTurn?.parts ?? []) {
        if (isAudioPart(part)) {
          this.emit("audio", decodeAudioPart(part));
        } else {
          this.emit("text", part.text);
        }
      }
    }

    if (message.toolCall) {
      await this.handleToolCall(message.toolCall.functionCalls);
    }

    if (message.sessionResumptionUpdate) {
      const update = message.sessionResumptionUpdate;
      if (update.resumable && update.newHandle) {
        this.sessionHandle = update.newHandle;
        this.emit("session-handle", update.newHandle);
      }
    }
  }

  private async handleToolCall(calls: FunctionCall[]): Promise<void> {
    const functionResponses: FunctionResponse[] = [];
    for (const call of calls) {
      const handler = this.toolHandlers.get(call.name);
      let response: Record<string, unknown>;
      if (!handler) {
        response = { success: false, error: `No handler registered for tool "${call.name}"` };
      } else {
        try {
          response = await handler(call.args);
        } catch (error) {
          response = { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      functionResponses.push({ name: call.name, id: call.id, response });
    }
    this.send({ toolResponse: { functionResponses } });
  }
}
