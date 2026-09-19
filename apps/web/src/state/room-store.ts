import { createContext, useContext } from "react";
import { createRoomSessionStore } from "./room-session-state.js";
import { useStore } from "zustand";

export type RoomViewState = import('./room-session-state.js').SessionSnapshot;
export type RoomStore = import('./room-session-state.js').SessionStore;

export function createRoomStore(): RoomStore {
  return createRoomSessionStore();
}

export const RoomStoreContext = createContext<RoomStore | null>(null);

export function useRoomStore<T>(selector: (state: RoomViewState) => T): T {
  const store = useContext(RoomStoreContext);
  if (!store) throw new Error("useRoomStore must be used inside RoomProvider");
  return useStore(store, selector);
}

export function installRoomBridge(store: RoomStore) {
  window.sidevoiceUI = {
    store,
    setLanguageModels: (languageModels) => store.patch({ languageModels }),
    setBootError: (bootError) => store.patch({ bootError }),
  };
}
