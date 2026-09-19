export {};

import type { ConversationView, KaraokeRange, LanguageModelView, ParticipantView, SidevoiceActions } from "../state/room-types";

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
      setConversation(value: ConversationView): void;
      setParticipants(value: ParticipantView[]): void;
      setLanguageModels(value: LanguageModelView[]): void;
      setBootError(value: string | null): void;
      updateKaraoke?(segment: string, karaoke: KaraokeRange | null): void;
    };
    /** The meter's analyser, pulled per animation frame by the waveform bubble; null while no call captures. */
    sidevoiceAudio?: { readWaveform(): Float32Array | null };
    sidevoiceActions?: SidevoiceActions;
  }
}
