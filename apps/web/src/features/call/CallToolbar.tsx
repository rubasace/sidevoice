import { MicrophoneIcon, SettingsIcon } from "../../components/ui/Icons";
import { Button } from "../../components/ui/Button";
import { JoinStatus } from "./JoinStatus";
import { AudioDeviceSelects, CallButton, DeviceNotes, MicControl, MuteButton } from "./CallIndicators";
import { CapabilityColumn, EngineColumn } from "../conversation/StatusColumns";

/* The bar's three parts: what this call has switched on at the left edge, the controls island in the
 * middle, what listens, speaks and thinks at the right edge. Facts at the sides, actions in the middle. */
export function CallToolbar() {
  return (
    <footer className="call-bar">
      <CapabilityColumn />
      <div className="controls" id="call-controls">
        <JoinStatus />
        <div id="audio-device-panel" className="audio-devices-panel" hidden>
          <AudioDeviceSelects />
          <Button id="audio-settings-open" variant="ghost" size="icon" className="device-settings" aria-label="Configuración de audio" title="Configuración de audio"><SettingsIcon size={24} /></Button>
          <div className="device-notes"><DeviceNotes /><Button id="refresh-devices" variant="ghost" size="icon" title="Actualizar dispositivos" aria-label="Actualizar dispositivos">↻</Button></div>
        </div>
        <div className="call-actions">
          <MicControl>
            <span id="mic-level-meter" className="sr-only" role="meter" aria-label="Nivel de micrófono" aria-valuemin={0} aria-valuemax={100} aria-valuenow={0} />
            <Button id="audio-devices" variant="ghost" className="audio-selector-toggle" aria-label="Elegir micrófono y altavoces" title="Dispositivos de audio" aria-expanded="false" aria-controls="audio-device-panel"><span className="mic-wave" aria-hidden="true"><i /><i /><i /></span><svg className="audio-chevron" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.3" aria-hidden="true"><path d="m7 14 5-5 5 5" /></svg></Button>
            <MuteButton />
          </MicControl>
          <details id="call-menu" className="call-menu"><summary aria-label="Más opciones" title="Más opciones"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg></summary><div className="call-menu-panel"><Button id="stats-open" variant="ghost" size="compact">Estadísticas de conexión</Button><Button id="call-settings-open" variant="ghost" size="compact">Configuración</Button></div></details>
          <CallButton />
        </div>
      </div>
      <EngineColumn />
    </footer>
  );
}
