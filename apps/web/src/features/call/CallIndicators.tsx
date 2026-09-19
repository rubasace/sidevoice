import { useRoomStore } from "../../state/room-store";
import { Button } from "../../components/ui/Button";
import { HangupIcon, MicrophoneIcon } from "../../components/ui/Icons";
import { cn } from "../../lib/cn";

/* The lights and notes of the call bar. Each one is a projection of the session store and nothing else
 * writes them: the runtime records the fact, React paints it (#53). The microphone level is the one
 * exception, and it is not here — it changes per animation frame and the meter owns its own pixels. */

export function EngineBadge() {
  const engine = useRoomStore((state) => state.engine);
  return <span id="engine-badge" className="engine-badge" role="status" title={engine.title || undefined} data-output={engine.output} hidden={!engine.text}>{engine.text}</span>;
}

export function ScreenLock() {
  const lock = useRoomStore((state) => state.screenLock);
  return (
    <span id="screen-lock" className="screen-lock" role="status" data-state={lock.state || undefined} hidden={!lock.state}>
      <i className="screen-lock-dot" aria-hidden="true" />
      <span id="screen-lock-text" className="sr-only">{lock.state ? lock.note : ""}</span>
    </span>
  );
}

export function EchoCover() {
  const echo = useRoomStore((state) => state.echo);
  return (
    <span id="echo-cover" className="screen-lock echo-cover" role="status" data-state={echo.state || undefined} title={echo.note || undefined} hidden={!echo.state}>
      <i className="screen-lock-dot" aria-hidden="true" />
      <span id="echo-cover-text" className="sr-only">{echo.state ? "Eco: " + echo.note : ""}</span>
    </span>
  );
}

export function DeviceNotes() {
  const deviceNote = useRoomStore((state) => state.deviceNote);
  const lock = useRoomStore((state) => state.screenLock);
  const echo = useRoomStore((state) => state.echo);
  return (
    <div>
      <p id="audio-device-note" role="status">{deviceNote}</p>
      <p id="screen-note" role="status">{lock.note}</p>
      <p id="echo-note" role="status">{echo.note}</p>
    </div>
  );
}

export function MuteButton() {
  const mic = useRoomStore((state) => state.mic);
  return (
    <Button id="mute" variant="ghost" className={cn(mic.holding && "holding")} aria-label={mic.label} title={mic.title}
      aria-pressed={mic.pressed} disabled={mic.disabled} aria-keyshortcuts="Meta+D Control+D"
      onClick={() => window.sidevoiceActions?.toggleMic()}>
      <MicrophoneIcon size={26} />
    </Button>
  );
}

export function CallButton() {
  const call = useRoomStore((state) => state.call);
  return (
    <Button id="connect" variant="primary" className={cn(call.joined && "joined", call.busy && "reconnecting")}
      aria-label={call.label} title={call.label} onClick={() => void window.sidevoiceActions?.toggleCall()}>
      <HangupIcon />
    </Button>
  );
}

export function MicControl({ children }: { children: React.ReactNode }) {
  const mic = useRoomStore((state) => state.mic);
  return <div id="mic-control" className="mic-control" data-muted={String(!mic.enabled)}>{children}</div>;
}
