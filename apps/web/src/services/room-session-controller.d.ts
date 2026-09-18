export {};

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
  }
}
