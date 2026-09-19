import type { ChatMessage, ConversationView, JoinStatusView, LanguageModelView, ParticipantView, KaraokeRange } from './room-types';
export interface SessionFacts {
 ws: unknown; stream: unknown; sessionId: string | null; roomRevision: number; roomInfo: Record<string, unknown> | null;
 connecting: boolean; reconnecting: boolean; switching: boolean; switchingSession: boolean; switchingTranscription: boolean;
 roomBinding: {thread_id: string; title?: string; binding_id?: string} | null; viewedThread: string | null;
 people: unknown[]; history: ChatMessage[]; roomSeen: Record<string, number>; replayMarks: Record<string, string>; inputReceipts: Record<string, string>;
 userLive: boolean; botLive: boolean; activeSpeech: Record<string, unknown> | null; previewJob: unknown;
 userTurn: {thread: string; key: string; text?: string} | null; pendingPhase: '' | 'listening' | 'transcribing'; pendingUserText: string;
 cancelledInput: boolean; textSending: boolean; micEnabled: boolean;
 voicePreferences: Record<string, unknown> | null; enginePreferences: Record<string, unknown> | null;
 sttRuntime: Record<string, unknown> | null; engineReady: boolean; outputHealth: 'ok' | 'recovering' | 'failed'; echoFacts: unknown;
 joinStep: string | null; joinFailure: string; joinProgress: number | null; joinDetail: string; joinSubject: string;
 screenLock: {state: string; note: string}; deviceNote: string;
 harness: Record<string, boolean>; turns: Record<string, {session: string; thread: string; status?: string; settled?: boolean; harnessEnded?: boolean; readyAt?: number}>;
 now: number; karaokeState: (KaraokeRange & {segment: string}) | null; bootError: string | null; languageModels: LanguageModelView[];
}
export interface SessionStatus {
 speaker: 'user' | 'room' | 'nobody'; conversation: 'idle' | 'working' | 'speaking';
 tab: 'out' | 'listening' | 'transcribing' | 'reconnecting' | 'switching';
 selected: string | null; viewed: string | null; harness: boolean | null; working: boolean; bed: boolean;
}
export interface SessionSnapshot {
 facts: SessionFacts; session: SessionStatus; conversation: ConversationView; participants: ParticipantView[];
 join: JoinStatusView | null; engine: {text: string; title: string; output: string}; echo: {state: string; note: string}; live: string;
 mic: {enabled: boolean; label: string; title: string; pressed: boolean; disabled: boolean; holding: boolean};
 call: {joined: boolean; busy: boolean; label: string}; title: string;
 screenLock: {state: string; note: string}; deviceNote: string;
 bootError: string | null; languageModels: LanguageModelView[];
}
export interface SessionStore {
 facts: SessionFacts;
 getState(): SessionSnapshot; getInitialState(): SessionSnapshot;
 subscribe(listener: (state: SessionSnapshot, previous: SessionSnapshot) => void): () => void;
 patch(facts: Partial<SessionFacts>): void;
 batch<T>(fn: () => T): T;
}
export function createRoomSessionStore(seed?: Partial<SessionFacts>): SessionStore;
export function receiptView(status: string): {symbol: string; label: string};
