/**
 * Gemini Live API — WebSocket wire protocol types
 *
 * Architecture update step 4: "Build a small isolated realtime prototype."
 * This file is the protocol layer only — pure types plus a couple of
 * pure helper functions, no network, no WebSocket. Verified against
 * Google's current documentation (fetched 2026-09-04, not just recalled
 * from training data — the Live API is young enough that guessing field
 * names would be a real risk of shipping something silently wrong):
 *   - https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
 *   - https://ai.google.dev/api/live
 *
 * Endpoint: wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=API_KEY
 *
 * Every client→server message carries exactly one of: setup, clientContent,
 * realtimeInput, toolResponse. Every server→client message carries some
 * combination of: setupComplete, serverContent, toolCall,
 * sessionResumptionUpdate.
 */

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/** A Gemini function declaration — the same shape used by the regular (non-Live) API's function calling. */
export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "OBJECT";
    properties: Record<string, { type: "STRING" | "NUMBER" | "BOOLEAN"; description?: string }>;
    required?: string[];
  };
}

export interface SessionResumptionConfig {
  /** Handle from a previous session's sessionResumptionUpdate.newHandle. Omit to start a new session. */
  handle?: string;
}

/** Must be the first message sent, before anything else. Wait for setupComplete before sending more. */
export interface BidiGenerateContentSetup {
  model: string; // e.g. "models/gemini-2.0-flash-live-001" — full "models/..." resource name, not a bare id
  responseModalities?: Array<"AUDIO" | "TEXT">;
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: Array<{ functionDeclarations: FunctionDeclaration[] }>;
  sessionResumption?: SessionResumptionConfig;
}

export interface RealtimeAudioChunk {
  /** Base64-encoded raw PCM: 16-bit signed little-endian, 16kHz, mono, per the documented input format. */
  data: string;
  mimeType: "audio/pcm;rate=16000";
}

export interface FunctionResponse {
  name: string;
  id: string;
  response: Record<string, unknown>;
}

export type ClientMessage =
  | { setup: BidiGenerateContentSetup }
  | { clientContent: { turns: Array<{ role: "user"; parts: Array<{ text: string }> }>; turnComplete: boolean } }
  | { realtimeInput: { audio: RealtimeAudioChunk } }
  | { toolResponse: { functionResponses: FunctionResponse[] } };

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export interface InlineAudioPart {
  inlineData: {
    /** Base64-encoded raw PCM: 16-bit signed little-endian, 24kHz mono for Live API audio output. */
    data: string;
    mimeType: string; // e.g. "audio/pcm;rate=24000"
  };
}

export interface InlineTextPart {
  text: string;
}

export interface ServerContent {
  modelTurn?: { parts: Array<InlineAudioPart | InlineTextPart> };
  turnComplete?: boolean;
  /**
   * True when a client message (the user speaking again) interrupted the
   * model mid-generation. Section 5's barge-in requirement maps directly
   * onto this: on interrupted=true, stop playback and empty the queued
   * audio immediately — don't wait for the current utterance to finish.
   */
  interrupted?: boolean;
}

export interface FunctionCall {
  name: string;
  id: string;
  args: Record<string, unknown>;
}

export interface SessionResumptionUpdate {
  /** New handle representing a resumable state. Empty string if resumable is false. */
  newHandle: string;
  resumable: boolean;
}

export type ServerMessage = {
  setupComplete?: Record<string, never>;
  serverContent?: ServerContent;
  toolCall?: { functionCalls: FunctionCall[] };
  sessionResumptionUpdate?: SessionResumptionUpdate;
};

// ---------------------------------------------------------------------------
// Pure helpers (no network — safe to unit test directly)
// ---------------------------------------------------------------------------

/** Wrap raw 16-bit PCM bytes as a realtimeInput client message. */
export function buildAudioChunkMessage(pcm16leBytes: Uint8Array): ClientMessage {
  return {
    realtimeInput: {
      audio: {
        data: Buffer.from(pcm16leBytes).toString("base64"),
        mimeType: "audio/pcm;rate=16000",
      },
    },
  };
}

/** Decode a server-sent inline audio part back into raw PCM bytes plus its sample rate. */
export function decodeAudioPart(part: InlineAudioPart): { pcm: Uint8Array; sampleRateHz: number } {
  const rateMatch = part.inlineData.mimeType.match(/rate=(\d+)/);
  const sampleRateHz = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
  const pcm = new Uint8Array(Buffer.from(part.inlineData.data, "base64"));
  return { pcm, sampleRateHz };
}

export function isAudioPart(part: InlineAudioPart | InlineTextPart): part is InlineAudioPart {
  return "inlineData" in part;
}
