export {};

import type { LanguageModelView, SidevoiceActions } from "../state/room-types";

declare global {
  interface Window {
    roomVoice?: {
      context?: AudioContext;
      supportsOutputSelection?: boolean;
      unlock(): Promise<void>;
      prepare(options: Record<string, unknown>, onStatus?: (text: string) => void): Promise<unknown>;
      speak(options: Record<string, unknown>, onStatus?: (text: string) => void, onPlaying?: () => void, onCue?: (cue: unknown) => void): Promise<void>;
      playEncoded(options: Record<string, unknown>, onStatus?: (text: string) => void, onPlaying?: () => void, onCue?: (cue: unknown) => void): Promise<void>;
      cancel(): void;
      setOutputDevice(id: string): Promise<void>;
    };
    roomTranscription?: Record<string, unknown>;
    roomI18n?: { setLanguage(language: string): void };
    sidevoiceSessionId?: () => string | null;
    sidevoiceUI?: {
      store?: import("../state/room-store").RoomStore;
      setLanguageModels(value: LanguageModelView[]): void;
      setBootError(value: string | null): void;
    };
    /** The meter's analyser, pulled per animation frame by the waveform bubble; null while no call captures. */
    sidevoiceAudio?: { readWaveform(): Float32Array | null };
    /** One uncaught error in the interface, on its way to the room. Never any transcript text. */
    sidevoiceReportError?: (report: { kind: string; message: string; stack?: string; component?: string }) => void;
    /** Reports raised before the controller (and its socket) exist. */
    sidevoiceClientErrors?: { kind: string; message: string; stack?: string; component?: string }[];
    sidevoiceBuildId?: string;
    sidevoiceActions?: SidevoiceActions;
  }
}
