import { DialogFrame } from "../../components/ui/DialogFrame";
import { AdvancedIcon, CloseIcon, CopyIcon, GeneralIcon, MachinesIcon, RefreshIcon, TranscriptionIcon, VoicesIcon } from "../../components/ui/Icons";
import { MachineList } from "../room/MachineList";
import { ModelPicker } from "../../components/models/ModelPicker";
import { InfoPopover } from "../../components/models/ModelInfo";
import { LanguageModelList } from "./LanguageModelList";
import { Button } from "../../components/ui/Button";
import { NativeSelect } from "../../components/ui/NativeSelect";

function GeneralSettings() {
  return <section id="pane-general" aria-labelledby="settings-general" hidden><h3>Idioma de la interfaz</h3><label>Idioma<NativeSelect id="ui-language" defaultValue="es"><option value="es">Español</option><option value="en">English</option></NativeSelect></label><p className="muted">Cambia los textos de la web. La voz y la transcripción se configuran por separado.</p><p className="muted">Toda la configuración se guarda en este navegador y se envía a la sala al entrar; la sala no conserva ninguna copia. Cada dispositivo tiene la suya.</p><Button id="reset-settings" variant="ghost">Restablecer toda la configuración de este dispositivo</Button><p className="muted" id="reset-settings-note" role="status" /><p className="muted">Compilación <code id="build-id">{(window as unknown as { sidevoiceBuildId?: string }).sidevoiceBuildId ?? "dev"}</code></p></section>;
}

function VoiceSettings() {
  return (
    <section id="pane-voice" aria-labelledby="settings-voice">
      <h3>Voces</h3>
      <label>Proveedor de voz<NativeSelect id="tts-provider" /></label>
      <div id="tts-browser-options"><label>Procesamiento de la voz<NativeSelect id="tts-device" defaultValue="auto" /></label><p className="muted" id="tts-device-note" /></div>
      <ModelPicker label="Modelo" id="default-model" infoId="default-model-info" />
      <div id="elevenlabs-credential" hidden>
        <label>Clave de API de ElevenLabs<span className="key-field"><input id="elevenlabs-key" type="password" autoComplete="off" spellCheck={false} placeholder="Sin clave guardada" /><Button id="elevenlabs-key-clear" variant="ghost" size="icon" className="key-clear" aria-label="Quitar la clave guardada" title="Quitar la clave guardada"><CloseIcon size={15} /></Button></span></label>
        <p className="muted" id="elevenlabs-key-state" role="status" />
      </div>
      <label>Voz por defecto<NativeSelect id="default-voice"><option value="ef_dora">Dora</option></NativeSelect></label>
      <label>Velocidad global <output id="speed-value">1.00×</output><input id="tts-speed" type="range" min="0.5" max="2" step="0.05" defaultValue="1" /></label><p id="speed-note" className="muted" />
      <Button id="prepare-model">Precargar modelo (opcional)</Button><p id="model-status" role="status" className="muted" />
      <label>Idioma de voz si el agente no lo indica<NativeSelect id="default-tts-language"><option value="es">Español</option><option value="en">English</option></NativeSelect></label>
      <h3>Por idioma</h3><p className="muted">Cada idioma hereda modelo, voz y velocidad. Deja la velocidad vacía para usar la global.</p><LanguageModelList />
      <Button id="reset-languages" className="preview-button">Restablecer idiomas a «Usar por defecto»</Button><p id="preview-status" role="status" className="muted" /><p id="language-support" className="muted" hidden />
    </section>
  );
}

function TranscriptionSettings() {
  return (
    <section id="pane-transcription" aria-labelledby="settings-transcription" hidden>
      <h3>Transcripción</h3>
      <label>Motor de transcripción<NativeSelect id="stt-provider" /></label><p className="muted" id="stt-provider-note" />
      <div id="stt-browser-options"><label>Procesamiento de transcripción<NativeSelect id="stt-device" /></label><p className="muted" id="stt-device-note" /></div>
      <ModelPicker label="Modelo" id="stt-model" infoId="stt-model-info" /><p className="muted" id="stt-model-note" />
      <div id="stt-credential" hidden><label>Clave de API de OpenAI<span className="key-field"><input id="stt-key" type="password" placeholder="Sin clave guardada" autoComplete="off" spellCheck={false} /><Button id="stt-key-clear" variant="ghost" size="icon" className="key-clear" aria-label="Quitar la clave guardada" title="Quitar la clave guardada"><CloseIcon size={15} /></Button></span></label><p className="muted" id="stt-key-state" role="status" /></div>
      <label>Idioma al transcribir<NativeSelect id="stt-language"><option value="auto">Detectar automáticamente</option><option value="es">Español</option><option value="en">English</option></NativeSelect></label>
      <p className="muted" id="stt-apply-note" hidden />
    </section>
  );
}

function AdvancedSettings() {
  return (
    <section id="pane-advanced" aria-labelledby="settings-advanced" hidden>
      <h3>Tiempos de conversación</h3>
      <label>Pausa antes del audio pendiente (segundos)<input id="audio-grace-seconds" type="number" min="0" max="10" step="0.5" defaultValue="2" /></label><p className="muted">Tras enviar tu intervención, espera este margen. Si vuelves a hablar, la espera se reinicia. Por defecto: 2 segundos.</p>
      <h3>Mientras la conversación trabaja</h3>
      <label>Sonido de presencia<NativeSelect id="presence-sound" defaultValue="on"><option value="on">Activado</option><option value="off">Desactivado</option></NativeSelect></label>
      <p className="muted">Un sonido suave y continuo mientras la conversación tiene lo que dijiste y aún no responde: empieza cuando la conversación lo lee y se detiene con la primera respuesta. Sale por el mismo altavoz que la voz, así que la cancelación de eco lo cubre, y su volumen está muy por debajo del umbral del detector para no abrir una intervención. Por defecto: activado al 3,5 % de la escala. Es de este dispositivo; la sala no guarda nada.</p>
      <h3>Al volver a una conversación</h3>
      <label>Repetir lo que no oíste<NativeSelect id="replay-on-return-seconds" defaultValue="120"><option value="0">Desactivado</option><option value="60">Del último minuto</option><option value="120">De los últimos 2 minutos</option><option value="300">De los últimos 5 minutos</option><option value="900">De los últimos 15 minutos</option></NativeSelect></label>
      <p className="muted">Al reconectar tras un corte, o al volver a entrar en la conversación, se reproducen las respuestas de este intervalo que este navegador no llegó a oír, de la más antigua a la más reciente y antes que nada nuevo. Una respuesta que ya escuchaste entera, o que paraste tú, no se repite; si vuelves a hablar, la repetición se cancela. Por defecto: 2 minutos. Es de este dispositivo; la sala no guarda nada.</p>
      <h3>Fin de tu intervención</h3>
      <label>Cuánta paciencia quieres <InfoPopover description="Cuánto silencio deja la sala antes de dar por terminada tu intervención, y cuánto espera antes de entregarla por si sólo estabas cogiendo aire. Los números que hay detrás son de la sala, iguales para todos, para que un arreglo llegue a todo el mundo a la vez." label="Información sobre la paciencia" /><NativeSelect id="turn-patience" defaultValue="normal"><option value="fast">Rápido · corta antes</option><option value="normal">Normal</option><option value="calm">Tranquilo · te deja respirar</option></NativeSelect></label>
      <p className="muted">Rápido responde en cuanto callas, y es cómodo para frases sueltas. Tranquilo deja casi un segundo y medio de pausa y, si sigues hablando justo después, une las dos partes en un solo mensaje: es lo que quieres conduciendo. Se aplica al entrar en la sala; si lo cambias durante una llamada, vuelve a entrar. Por defecto: Normal.</p>
    </section>
  );
}

function MachineSettings() {
  return <section id="pane-machines" aria-labelledby="settings-machines" hidden><MachineList /></section>;
}

export function SettingsDialog() {
  return (
    <DialogFrame id="language-settings" className="settings-dialog" labelledBy="settings-title" title="Configuración" closeId="settings-close" footer={<div className="settings-footer"><p id="settings-error" role="alert" /><Button type="submit" form="language-form" variant="primary">Guardar cambios</Button></div>}>
      <form id="language-form">
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Secciones de configuración">
            <Button variant="ghost" id="settings-general" aria-controls="pane-general" aria-pressed="false"><GeneralIcon /> General</Button>
            <Button variant="ghost" id="settings-voice" aria-controls="pane-voice" aria-pressed="true"><VoicesIcon /> Voces</Button>
            <Button variant="ghost" id="settings-transcription" aria-controls="pane-transcription" aria-pressed="false"><TranscriptionIcon /> Transcripción</Button>
            <Button variant="ghost" id="settings-machines" aria-controls="pane-machines" aria-pressed="false"><MachinesIcon /> Máquinas</Button>
            <Button variant="ghost" id="settings-advanced" aria-controls="pane-advanced" aria-pressed="false"><AdvancedIcon /> Avanzado</Button>
          </nav>
          <div className="settings-content"><GeneralSettings /><VoiceSettings /><TranscriptionSettings /><MachineSettings /><AdvancedSettings /></div>
        </div>
      </form>
      <DialogFrame id="pair-dialog" className="pair-dialog" labelledBy="pair-title" title="Emparejar máquina" closeId="pair-close">
        <div className="pair-row">
          <code id="pair-code" className="pair-code" aria-live="polite" />
          <Button id="pair-copy" variant="ghost" size="icon" aria-label="Copiar código" title="Copiar código"><CopyIcon /></Button>
          <Button id="pair-refresh" variant="ghost" size="icon" aria-label="Nuevo código" title="Nuevo código"><RefreshIcon /></Button>
        </div>
        <p className="muted pair-meta"><span id="pair-expires" /> · Un solo uso</p>
      </DialogFrame>
    </DialogFrame>
  );
}
