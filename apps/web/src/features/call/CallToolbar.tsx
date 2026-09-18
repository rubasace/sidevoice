import { HangupIcon, MicrophoneIcon, SettingsIcon, SpeakerIcon } from "../../components/ui/Icons";

export function CallToolbar() {
  return (
    <footer className="call-bar">
      <div className="controls" id="call-controls">
        <div id="audio-device-panel" className="audio-devices-panel" hidden>
          <label className="audio-device-choice"><MicrophoneIcon /><span className="sr-only">Micrófono</span><select id="input-device" aria-label="Micrófono"><option value="default">Predeterminado del sistema</option></select></label>
          <label className="audio-device-choice"><SpeakerIcon /><span className="sr-only">Altavoces</span><select id="output-device" aria-label="Altavoces"><option value="default">Predeterminado del sistema</option></select></label>
          <button id="audio-settings-open" className="device-settings" aria-label="Configuración de audio" title="Configuración de audio"><SettingsIcon size={24} /></button>
          <div className="device-notes"><div><p id="audio-device-note" role="status" /><p id="screen-note" role="status" /></div><button id="refresh-devices" type="button" title="Actualizar dispositivos" aria-label="Actualizar dispositivos">↻</button></div>
        </div>
        <div className="call-actions">
          <div id="mic-control" className="mic-control" data-muted="false">
            <span id="mic-level-meter" className="sr-only" role="meter" aria-label="Nivel de micrófono" aria-valuemin={0} aria-valuemax={100} aria-valuenow={0} />
            <button id="audio-devices" className="audio-selector-toggle" type="button" aria-label="Elegir micrófono y altavoces" title="Dispositivos de audio" aria-expanded="false" aria-controls="audio-device-panel"><span className="mic-wave" aria-hidden="true"><i /><i /><i /></span><svg className="audio-chevron" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.3" aria-hidden="true"><path d="m7 14 5-5 5 5" /></svg></button>
            <button id="mute" aria-label="Silenciar micrófono" title="Silenciar micrófono" aria-pressed="false" aria-keyshortcuts="Meta+D Control+D"><MicrophoneIcon size={26} /></button>
          </div>
          <details id="call-menu" className="call-menu"><summary aria-label="Más opciones" title="Más opciones"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg></summary><div className="call-menu-panel"><button id="stats-open" type="button">Estadísticas de conexión</button><button id="call-settings-open" type="button">Configuración</button></div></details>
          <button id="connect" aria-label="Entrar en la sala" title="Entrar en la sala"><HangupIcon /></button>
        </div>
      </div>
    </footer>
  );
}
