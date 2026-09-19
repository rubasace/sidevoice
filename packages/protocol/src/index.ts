export type Identifier = string;

export interface RoomBinding {
  thread_id?: Identifier | null;
  title?: string | null;
  binding_id?: Identifier | null;
}

export interface Participant {
  thread_id: Identifier;
  title: string;
  harness?: string | null;
  available: boolean;
  selected: boolean;
  reach?: {
    state: "listening" | "holding" | "offline";
    detail?: string | null;
    remedy?: string | null;
  };
}

export interface VoiceSession {
  session_id: Identifier;
  sample_rate: number;
  transcription?: Record<string, unknown>;
}

export interface SpeechEvent {
  session_id: Identifier;
  thread_id: Identifier;
  revision: number;
  utterance_id: Identifier;
  text: string;
  language?: string | null;
  [key: string]: unknown;
}

export type RoomServerEvent =
  | { type: "voice-session"; data: VoiceSession }
  | { type: "voice-speech" | "voice-speech-audio"; data: SpeechEvent }
  | { type: "voice-cancel"; data: { session_id: Identifier; revision: number } }
  | { type: "voice-user-turn"; data: Record<string, unknown> }
  | { type: "voice-input-receipt"; data: Record<string, unknown> }
  | { type: "voice-preparation"; data: Record<string, unknown> }
  | { type: "error"; data: { message?: string; error?: string } }
  | { type: string; data?: Record<string, unknown> };

export const PRESENTATION_API = "/api/presentation" as const;
export const PRESENTATION_SOCKET = "/api/presentation/ws" as const;
export const CONNECTOR_PROTOCOL_VERSION = 1 as const;

/* ----- telemetry: the vocabulary the room and the page share -----
 *
 * The stages of a turn, and everything a span about one is allowed to say. Both halves implement
 * this list: `apps/web/src/services/telemetry-types.ts` imports it, and `apps/server/sidevoice/
 * telemetry.py` repeats it because Python cannot read this file — a test there asserts the two
 * agree, so the contract has one owner and the copy cannot drift in silence.
 *
 * A stage name is the same thing three times over: the span, the histogram, and the row of the
 * connection-statistics dialog. Renaming one means renaming all three. */
export const TURN_STAGES = [
  "endpoint_silence",
  "recognition",
  "request_to_transcript",
  "transcript_to_delivery",
  "delivery_to_read",
  "read_to_reply",
  "input_queued_to_reply",
  "reply_to_synthesis",
  "provider_synthesis",
  "audio_received_to_playback",
] as const;

export type TurnStage = (typeof TURN_STAGES)[number];

/** Ids, revisions, states, counts and engine names. Never a transcript, a reply or a credential. */
export const TELEMETRY_ATTRIBUTES = [
  "sidevoice.session_id",
  "sidevoice.thread_id",
  "sidevoice.turn_revision",
  "sidevoice.reply_revision",
  "sidevoice.utterance_id",
  "sidevoice.status",
  "sidevoice.reason",
  "sidevoice.outcome",
  "sidevoice.kind",
  "sidevoice.stt_provider",
  "sidevoice.stt_model",
  "sidevoice.stt_device",
  "sidevoice.tts_provider",
  "sidevoice.tts_model",
  "sidevoice.turn_end_mode",
  "sidevoice.harness",
  "sidevoice.shared_audio",
  "sidevoice.synthesis_attempt",
  "sidevoice.stage",
  "sidevoice.duration_ms",
  "sidevoice.audio_output",
  "sidevoice.audio_context",
  "sidevoice.stalls",
  "sidevoice.build_id",
] as const;

export type TelemetryAttribute = (typeof TELEMETRY_ATTRIBUTES)[number];

/** Where the page posts its OTLP batches. The room forwards them; the page never sees a collector. */
export const TELEMETRY_API = "/api/telemetry" as const;
