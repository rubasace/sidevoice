import { HangupIcon, MicrophoneIcon, SettingsIcon, SpeakerIcon } from "../../components/ui/Icons";
import { Button } from "../../components/ui/Button";
import { NativeSelect } from "../../components/ui/NativeSelect";

export function CallToolbar() {
  return (
    <footer className="call-bar">
      <div className="controls" id="call-controls">
        <div id="audio-device-panel" className="audio-devices-panel" hidden>
          <label className="audio-device-choice"><MicrophoneIcon /><span className="sr-only">Micrófono</span><NativeSelect id="input-device" aria-label="Micrófono"><option value="default">Predeterminado del sistema</option></NativeSelect></label>
          <label className="audio-device-choice"><SpeakerIcon /><span className="sr-only">Altavoces</span><NativeSelect id="output-device" aria-label="Altavoces"><option value="default">Predeterminado del sistema</option></NativeSelect></label>
          <Button id="audio-settings-open" variant="ghost" size="icon" className="device-settings" aria-label="Configuración de audio" title="Configuración de audio"><SettingsIcon size={24} /></Button>
          <div className="device-notes"><div><p id="audio-device-note" role="status" /><p id="screen-note" role="status" /><p id="echo-note" role="status" /></div><Button id="refresh-devices" variant="ghost" size="icon" title="Actualizar dispositivos" aria-label="Actualizar dispositivos">↻</Button></div>
        </div>
        <div className="call-actions">
          <span id="screen-lock" className="screen-lock" role="status" hidden><i className="screen-lock-dot" aria-hidden="true" /><span id="screen-lock-text" className="sr-only" /></span>
          <span id="echo-cover" className="screen-lock echo-cover" role="status" hidden><i className="screen-lock-dot" aria-hidden="true" /><span id="echo-cover-text" className="sr-only" /></span>
          <span id="engine-badge" className="engine-badge" role="status" hidden />
          <div id="mic-control" className="mic-control" data-muted="false">
            <span id="mic-level-meter" className="sr-only" role="meter" aria-label="Nivel de micrófono" aria-valuemin={0} aria-valuemax={100} aria-valuenow={0} />
            <Button id="audio-devices" variant="ghost" className="audio-selector-toggle" aria-label="Elegir micrófono y altavoces" title="Dispositivos de audio" aria-expanded="false" aria-controls="audio-device-panel"><span className="mic-wave" aria-hidden="true"><i /><i /><i /></span><svg className="audio-chevron" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.3" aria-hidden="true"><path d="m7 14 5-5 5 5" /></svg></Button>
            <Button id="mute" variant="ghost" aria-label="Silenciar micrófono" title="Silenciar micrófono" aria-pressed="false" aria-keyshortcuts="Meta+D Control+D"><MicrophoneIcon size={26} /></Button>
          </div>
          <details id="call-menu" className="call-menu"><summary aria-label="Más opciones" title="Más opciones"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg></summary><div className="call-menu-panel"><Button id="stats-open" variant="ghost" size="compact">Estadísticas de conexión</Button><Button id="call-settings-open" variant="ghost" size="compact">Configuración</Button></div></details>
          <Button id="connect" variant="primary" aria-label="Entrar en la sala" title="Entrar en la sala"><HangupIcon /></Button>
        </div>
      </div>
    </footer>
  );
}
