import { useEffect, useRef, type PropsWithChildren } from "react";
import { createRoomStore, installRoomBridge, RoomStoreContext, type RoomStore } from "../state/room-store";

let controllerImport: Promise<unknown> | null = null;

interface RoomProviderProps extends PropsWithChildren {
  store?: RoomStore;
}

export function RoomProvider({ children, store: suppliedStore }: RoomProviderProps) {
  const started = useRef(false);
  const storeRef = useRef<RoomStore | null>(null);
  if (!storeRef.current) storeRef.current = suppliedStore ?? createRoomStore();
  const store = storeRef.current;

  useEffect(() => {
    installRoomBridge(store);
    if (started.current) return;
    started.current = true;
    controllerImport ??= import("../services/room-session-controller.js");
    void controllerImport.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      window.sidevoiceUI?.setBootError(`No se pudo iniciar Sidevoice: ${message}`);
    });
  }, [store]);

  return <RoomStoreContext.Provider value={store}>{children}</RoomStoreContext.Provider>;
}
