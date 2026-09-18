import { createContext, useContext } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import type { ConversationView, LanguageModelView, ParticipantView } from "./room-types";

export interface RoomViewState {
  conversation: ConversationView;
  participants: ParticipantView[];
  languageModels: LanguageModelView[];
  bootError: string | null;
}

export type RoomStore = StoreApi<RoomViewState>;

export function createRoomStore(): RoomStore {
  return createStore<RoomViewState>(() => ({
    conversation: { messages: [], pendingText: "", pendingCancellable: false },
    participants: [],
    languageModels: [],
    bootError: null,
  }));
}

export const RoomStoreContext = createContext<RoomStore | null>(null);

export function useRoomStore<T>(selector: (state: RoomViewState) => T): T {
  const store = useContext(RoomStoreContext);
  if (!store) throw new Error("useRoomStore must be used inside RoomProvider");
  return useStore(store, selector);
}

export function installRoomBridge(store: RoomStore) {
  window.sidevoiceUI = {
    setConversation: (conversation) => store.setState({ conversation }),
    setParticipants: (participants) => store.setState({ participants }),
    setLanguageModels: (languageModels) => store.setState({ languageModels }),
    setBootError: (bootError) => store.setState({ bootError }),
    // A playback cue changes one message's karaoke; nothing else in the list moves.
    updateKaraoke: (segment, karaoke) => store.setState((state) => ({ conversation: { ...state.conversation, messages: state.conversation.messages.map((m) => (m.segment === segment ? { ...m, karaoke, playback: "playing" } : m)) } })),
  };
}
