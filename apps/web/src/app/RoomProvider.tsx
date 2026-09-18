import { useEffect, useRef, type PropsWithChildren } from "react";

export function RoomProvider({ children }: PropsWithChildren) {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void import("../services/room-session-controller.js");
  }, []);

  return children;
}
