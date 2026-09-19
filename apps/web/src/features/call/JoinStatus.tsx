import { useRoomStore } from "../../state/room-store";

/**
 * The single line that accompanies a join: one step at a time, above the call controls, where the
 * person just tapped. It disappears the moment the call is up, and a failure stays in its place
 * with what to do about it. The download modal is a different thing: it belongs to the long steps.
 */
export function JoinStatus() {
  const join = useRoomStore((state) => state.join);
  return (
    <p
      id="join-status"
      className="join-status"
      role={join?.failed ? "alert" : "status"}
      aria-live="polite"
      data-state={join ? (join.failed ? "failed" : "busy") : ""}
      hidden={!join}
    >
      {join ? (
        <>
          {join.failed ? null : <i className="join-status-dot" aria-hidden="true" />}
          <span>{join.text}</span>
        </>
      ) : null}
    </p>
  );
}
