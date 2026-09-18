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
