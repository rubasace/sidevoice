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
  cancellable?: boolean;
  interrupted?: boolean;
  /** The room can play this reply again for this browser right now (#100). */
  replayable?: boolean;
  delivery?: string;
  audio?: string;
  audioNote?: string;
  /** How the room got this message when it did not hear it happen: `buffered`, or `truncated`. */
  offline?: string | null;
  offlineNote?: string;
  /** Said under input the room never handed to the conversation, and never will. */
  deliveryNote?: string;
  /** The room's own word for this row: `pending`, `sending`, `read`, `not_sent`… */
  status?: string;
  audio_reason?: string | null;
  /** Said on a reply the room is repeating because this browser never heard it through (#52). */
  replayNote?: string;
  karaoke?: KaraokeRange | null;
  playback?: "pending" | "playing" | "complete";
}

export interface ConversationView {
  messages: ChatMessage[];
  pendingText: string;
  pendingCancellable: boolean;
  /** While a turn is open the bubble shows bars instead of text: listening, then transcribing. */
  pendingPhase?: "" | "listening" | "transcribing";
  /** The conversation is working on this browser's last turn: the three dots say so. */
  working?: boolean;
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
  /** Honest activity support: unsupported and unknown are different messages. */
  activityNote?: string | null;
  detail?: string;
  /** The line under the title: unread, and a reach that is not normal — never "listening" or "thinking",
   *  the dot says both. */
  subtitle: string;
  working: boolean;
  /** The machine this conversation runs on, by the name it gave when it paired; null when unknown. */
  machine?: string | null;
  machineId?: string | null;
  /** The harness the conversation runs in ("claude", "codex"), shown as its icon; null when unknown. */
  harness?: string | null;
}

/** One machine paired with this room, as its row reads. A revoked machine is still a row: it stays
 *  in the list, saying so, until somebody takes it away. */
export interface MachineView {
  id: string;
  host: string;
  /** Operating system and connector version in one line — whatever of it the machine said. */
  description: string;
  connected: boolean;
  revoked: boolean;
  state: "connected" | "offline" | "revoked";
  stateLabel: string;
  pairedLabel: string;
  seenLabel: string;
  /** How many of the room's conversations run on this machine right now, and the line that says so. */
  conversations: number;
  conversationsLabel: string;
  /** What the machine said it runs, for the row; the version goes in the details. */
  platform: string;
  version: string;
  /** The room is being asked to revoke or remove this one; its buttons wait. */
  busy: boolean;
}

/** The step a join (or a reconnection) is on, already written the way the person reads it. */
export interface JoinStatusView {
  step: string | null;
  text: string;
  progress: number | null;
  failed: boolean;
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
  modelOptions: ({value: string; label: string; options?: undefined} | {value?: undefined; label: string; options: {value: string; label: string}[]})[];
  voice: string;
  voiceOptions: SelectOption[];
  speed: number | null;
  speedMin: number;
  speedMax: number;
  inheritedSpeed: number;
}

export interface SidevoiceActions {
  cancelInput(): Promise<void>;
  skipReply(): Promise<void>;
  replayReply(historyId: string | null): Promise<void>;
  toggleMic(): void;
  selectAudioDevice(kind: "input" | "output", id: string): Promise<void>;
  toggleCall(): Promise<void>;
  selectParticipant(threadId: string): void;
  closeParticipant(threadId: string): Promise<void>;
  updateLanguageModel(language: string, model: string): void;
  updateLanguageVoice(language: string, voice: string): void;
  updateLanguageSpeed(language: string, speed: number | null): void;
  previewVoice(language: string): Promise<void>;
  /** Take this machine's pairing away from the room. Asked again on a machine already revoked, it
   *  takes the row away too. */
  revokeMachine(id: string): Promise<void>;
}
