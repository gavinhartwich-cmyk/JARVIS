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

/**
 * [EXTENDED 2026-09-04] Real, general recursive schema - per Gavin's
 * direct ask after the generic capability bridge still wasn't what he
 * wanted: "i dont want a easier way to add actions i want a simpler way
 * to make bigger dents in more actions... more actions in one thing."
 * The flat STRING/NUMBER/BOOLEAN-only version this replaced could only
 * express one atomic action per tool call - a real multi-step task
 * (open an app, then type, then press Enter) cost one round trip PER
 * STEP. Gemini's real function-calling schema already supports ARRAY/
 * OBJECT (this was never a protocol limit, just an unnecessarily narrow
 * TS type on top of it) - this is what lets a single capability like
 * run_actions (capability-registry.ts) take a whole real plan as one
 * structured parameter instead of one bespoke tool per verb.
 */
export interface FunctionParameterSchema {
  type: "STRING" | "NUMBER" | "BOOLEAN" | "ARRAY" | "OBJECT";
  description?: string;
  /** Required when type is "ARRAY" - the schema of each element. */
  items?: FunctionParameterSchema;
  /** Required when type is "OBJECT". */
  properties?: Record<string, FunctionParameterSchema>;
  required?: string[];
}

/** A Gemini function declaration — the same shape used by the regular (non-Live) API's function calling. */
export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "OBJECT";
    properties: Record<string, FunctionParameterSchema>;
    required?: string[];
  };
}

export interface SessionResumptionConfig {
  /** Handle from a previous session's sessionResumptionUpdate.newHandle. Omit to start a new session. */
  handle?: string;
}

/**
 * Must be the first message sent, before anything else. Wait for
 * setupComplete before sending more.
 *
 * [FIXED 2026-09-04] Real bug found on the first live connection this
 * project ever made to this endpoint: `responseModalities` at the top
 * level of `setup` (as originally written here, transcribed from
 * documentation) is rejected outright - "Invalid JSON payload received.
 * Unknown name 'responseModalities' at 'setup': Cannot find field."
 * Confirmed directly against the real WebSocket endpoint that it belongs
 * nested under `generationConfig` instead, same shape as the regular
 * generateContent API's generationConfig.
 */
export interface BidiGenerateContentSetup {
  model: string; // e.g. "models/gemini-3.1-flash-live-preview" — full "models/..." resource name, not a bare id
  generationConfig?: {
    // Live-verified: this model rejects "TEXT" as a requested modality
    // ("The requested combination of response modalities (TEXT) is not
    // supported") - AUDIO is the one confirmed to actually work.
    responseModalities?: Array<"AUDIO" | "TEXT">;
  };
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
