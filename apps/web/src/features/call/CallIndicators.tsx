import { useRoomStore } from "../../state/room-store";
import { Button } from "../../components/ui/Button";
import { HangupIcon, MicrophoneIcon, SpeakerIcon } from "../../components/ui/Icons";
import { NativeSelect } from "../../components/ui/NativeSelect";
import { cn } from "../../lib/cn";

/* The lights and notes of the call bar. Each one is a projection of the session store and nothing else
 * writes them: the runtime records the fact, React paints it (#53). The microphone level is the one
 * exception, and it is not here — it changes per animation frame and the meter owns its own pixels. */

/* Two cards in the two corners of the call bar, at the height of the buttons and out of their way: what
 * this call has switched on (left) and who is answering it (right). Each row is a light and a line; both
 * collapse to the light and three dots where there is no width, and both open upward (#64). */
function StatusCard({ id, rows, side, label }: { id: string; rows: StatusRow[]; side: "start" | "end"; label: string }) {
  if (!rows.length) return null;
  const worst = rows.some((row) => row.state === "fail") ? "fail" : rows.some((row) => row.state === "warn") ? "warn" : "ok";
  return (
    <details id={id} className="status-card" data-side={side}>
      <summary className="status-pill" data-state={worst} aria-label={label}>
        <i className="engine-dot" data-state={worst} aria-hidden="true" />
        <span className="status-pill-text">{rows[0].value}</span>
        <span className="status-pill-dots" aria-hidden="true">⋯</span>
      </summary>
      <dl className="status-panel">
        {rows.map((row) => (
          <div className="status-row" key={row.id} data-state={row.state}>
            <i className="engine-dot" data-state={row.state} aria-hidden="true" />
            <dt>{row.label}</dt>
            <dd>{row.value}{row.note ? <small>{row.note}</small> : null}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

type StatusRow = { id: string; label: string; value: string; state: "ok" | "warn" | "fail"; note: string };

export function CapabilityCard() {
  const rows = useRoomStore((state) => state.capabilityPanel);
  return <StatusCard id="capability-card" rows={rows} side="start" label="Lo que está activo en esta llamada" />;
}

export function EngineBadge() {
  const rows = useRoomStore((state) => state.enginePanel);
  return <StatusCard id="engine-summary" rows={rows} side="end" label="Qué modelos responden" />;
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

export function AudioDeviceSelects() {
  const devices = useRoomStore((state) => state.audioDevices);
  const choose = (kind: "input" | "output") => (event: React.ChangeEvent<HTMLSelectElement>) =>
    void window.sidevoiceActions?.selectAudioDevice(kind, event.target.value);
  return (
    <>
      <label className="audio-device-choice"><MicrophoneIcon /><span className="sr-only">Micrófono</span>
        <NativeSelect id="input-device" aria-label="Micrófono" value={devices.inputId} onChange={choose("input")} disabled={!devices.available || devices.busy}>
          {devices.inputs.length ? devices.inputs.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)
            : <option value="default">Predeterminado del sistema</option>}
        </NativeSelect>
      </label>
      <label className="audio-device-choice"><SpeakerIcon /><span className="sr-only">Altavoces</span>
        <NativeSelect id="output-device" aria-label="Altavoces" value={devices.outputId} onChange={choose("output")} disabled={!devices.available || !devices.outputAvailable || devices.busy}>
          {devices.outputs.length ? devices.outputs.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)
            : <option value="default">Predeterminado del sistema</option>}
        </NativeSelect>
      </label>
    </>
  );
}
