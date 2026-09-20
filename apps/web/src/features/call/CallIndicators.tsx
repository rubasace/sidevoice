import { useRoomStore } from "../../state/room-store";
import { Button } from "../../components/ui/Button";
import { HangupIcon, MicrophoneIcon, SpeakerIcon } from "../../components/ui/Icons";
import { NativeSelect } from "../../components/ui/NativeSelect";
import { cn } from "../../lib/cn";

/* The lights and notes of the call bar. Each one is a projection of the session store and nothing else
 * writes them: the runtime records the fact, React paints it (#53). The microphone level is the one
 * exception, and it is not here — it changes per animation frame and the meter owns its own pixels. */

/* What is doing the work — the transcription engine, the voice, how the turn ends — is context, not a
 * control: it sits in the corner at the height of the call bar, and on a narrow screen it collapses to
 * three dots that open upward instead of pushing the buttons around (#64). */
export function EngineBadge() {
  const engine = useRoomStore((state) => state.engine);
  return (
    <details id="engine-summary" className="engine-summary" hidden={!engine.text}>
      <summary id="engine-badge" className="engine-badge" data-output={engine.output} title={engine.title || undefined} aria-label={"Motores en uso: " + engine.text}>
        <span className="engine-badge-text">{engine.text}</span>
        <span className="engine-badge-dots" aria-hidden="true">⋯</span>
      </summary>
      <div className="engine-summary-panel" role="status">{engine.title || engine.text}</div>
    </details>
  );
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
