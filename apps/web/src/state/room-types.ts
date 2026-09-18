export interface KaraokeRange {
  from: number;
  to: number;
  mode?: "word" | "chunk" | "segment";
}

export interface ChatMessage {
  segment: string | null;
  thread?: string | null;
  session?: string | null;
  role: "user" | "assistant";
  text: string;
  name: string;
  time: number;
  seq?: number;
  draft?: boolean;
  interrupted?: boolean;
  delivery?: string;
  audio?: string;
  audioNote?: string;
  karaoke?: KaraokeRange | null;
}

export interface ConversationView {
  messages: ChatMessage[];
  pendingText: string;
  pendingCancellable: boolean;
}

export interface ParticipantView {
  threadId: string;
  title: string;
  selected: boolean;
  available: boolean;
  switching: boolean;
  unread: number;
  reach: "listening" | "holding" | "offline";
  stateLabel: string;
  detail?: string;
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface LanguageModelView {
  language: string;
  label: string;
  model: string;
  actualModel: string;
  modelDescription?: string;
  modelOptions: SelectOption[];
  voice: string;
  voiceOptions: SelectOption[];
  speed: number | null;
  speedMin: number;
  speedMax: number;
  inheritedSpeed: number;
}

export interface SidevoiceActions {
  cancelInput(): Promise<void>;
  selectParticipant(threadId: string): void;
  closeParticipant(threadId: string): Promise<void>;
  updateLanguageModel(language: string, model: string): void;
  updateLanguageVoice(language: string, voice: string): void;
  updateLanguageSpeed(language: string, speed: number | null): void;
  previewVoice(language: string): Promise<void>;
}
