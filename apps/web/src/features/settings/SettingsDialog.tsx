import { DialogFrame } from "../../components/ui/DialogFrame";
import { ModelPicker } from "../../components/models/ModelPicker";
import { LanguageModelList } from "./LanguageModelList";
import { Button } from "../../components/ui/Button";
import { NativeSelect } from "../../components/ui/NativeSelect";

function GeneralSettings() {
  return <section id="pane-general" aria-labelledby="settings-general" hidden><h3>Idioma de la interfaz</h3><label>Idioma<NativeSelect id="ui-language" defaultValue="es"><option value="es">Español</option><option value="en">English</option></NativeSelect></label><p className="muted">Cambia los textos de la web. La voz y la transcripción se configuran por separado.</p></section>;
}

function VoiceSettings() {
  return (
    <section id="pane-voice" aria-labelledby="settings-voice">
      <h3>Voces</h3><p className="muted">Elige una voz por defecto y personalízala por idioma.</p>
      <label>Procesamiento en el navegador<NativeSelect id="tts-device" defaultValue="auto"><option value="auto">GPU automática · CPU si no está disponible</option><option value="webgpu">GPU</option><option value="wasm">CPU</option></NativeSelect></label>
      <ModelPicker label="Modelo por defecto" id="default-model" infoId="default-model-info"><option value="kokoro">Kokoro · 82M</option></ModelPicker>
      <div id="elevenlabs-credential" hidden>
        <label>Clave de API de ElevenLabs<input id="elevenlabs-key" type="password" autoComplete="off" spellCheck={false} placeholder="Clave de ElevenLabs" /></label>
        <p className="muted" id="elevenlabs-key-state" role="status" />
        <div className="stt-key-actions"><Button id="elevenlabs-key-save" size="compact">Guardar clave</Button><Button id="elevenlabs-key-clear" size="compact">Quitar clave</Button></div>
        <p className="muted">La clave se guarda en la sala. Las voces incluyen las personalizadas disponibles en tu cuenta.</p>
      </div>
      <label>Voz por defecto<NativeSelect id="default-voice"><option value="ef_dora">Dora · español</option><option value="em_alex">Alex · español</option><option value="em_santa">Santa · español</option><option value="af_heart">Heart · English US</option><option value="af_bella">Bella · English US</option><option value="bf_emma">Emma · English UK</option><option value="bm_george">George · English UK</option></NativeSelect></label>
      <label>Velocidad global <output id="speed-value">1.00×</output><input id="tts-speed" type="range" min="0.5" max="2" step="0.05" defaultValue="1" /></label><p id="speed-note" className="muted" />
      <Button id="prepare-model">Precargar modelo (opcional)</Button><p id="model-status" role="status" className="muted">Se prepara automáticamente al conectar o probar una voz. Puedes precargarlo aquí si quieres.</p>
      <h3>Por idioma</h3><p className="muted">Cada idioma hereda modelo, voz compatible y velocidad. Deja la velocidad vacía para usar la global.</p><LanguageModelList />
      <Button id="reset-languages" className="preview-button">Restablecer idiomas a «Usar por defecto»</Button><p id="preview-status" role="status" className="muted" /><p id="language-support" className="muted" />
      <label>Idioma de voz si el agente no lo indica<NativeSelect id="default-tts-language"><option value="es">Español</option><option value="en">English</option></NativeSelect></label><p className="muted">Los cambios se aplican a las próximas locuciones.</p>
    </section>
  );
}

function TranscriptionSettings() {
  return (
    <section id="pane-transcription" aria-labelledby="settings-transcription" hidden>
      <h3>Transcripción</h3><p className="muted">Configura cómo se reconoce lo que dices.</p>
      <label>Motor de transcripción<NativeSelect id="stt-provider" /></label><p className="muted" id="stt-provider-note" />
      <div id="stt-browser-options"><label>Procesamiento de transcripción<NativeSelect id="stt-device" /></label><p className="muted" id="stt-device-note">Comprobando compatibilidad…</p></div>
      <label>Modelo<NativeSelect id="stt-model" /></label><p className="muted" id="stt-model-note" />
      <div id="stt-credential" hidden><label>Clave de API de OpenAI<input id="stt-key" type="password" placeholder="sk-…" autoComplete="off" spellCheck={false} /></label><p className="muted" id="stt-key-state" role="status" /><div className="stt-key-actions"><Button id="stt-key-save" size="compact">Guardar clave</Button><Button id="stt-key-clear" size="compact">Quitar clave</Button></div></div>
      <label>Idioma al transcribir<NativeSelect id="stt-language"><option value="auto">Detectar automáticamente</option><option value="es">Español</option><option value="en">English</option></NativeSelect></label>
      <p className="muted" id="stt-apply-note">Los cambios entre modelos locales se aplican durante la llamada. Cambiar entre navegador y OpenAI requiere volver a entrar.</p>
    </section>
  );
}

function AdvancedSettings() {
  return (
    <section id="pane-advanced" aria-labelledby="settings-advanced" hidden>
      <h3>Tiempos de conversación</h3>
      <label>Pausa antes del audio pendiente (segundos)<input id="audio-grace-seconds" type="number" min="0" max="10" step="0.5" defaultValue="2" /></label><p className="muted">Tras enviar tu intervención, espera este margen. Si vuelves a hablar, la espera se reinicia. Por defecto: 2 segundos.</p>
      <label title="También se aplica si mostramos una transcripción parcial; no controla la velocidad del modelo.">Silencio para terminar tu intervención (segundos) ⓘ<input id="user-speech-timeout" type="number" min="0.5" max="15" step="0.5" defaultValue="2.5" aria-describedby="user-speech-timeout-note" /></label><p className="muted" id="user-speech-timeout-note">Tiempo de silencio antes de cerrar y enviar tu intervención. También se aplica cuando hay transcripción parcial; no controla la velocidad del modelo. Por defecto: 2,5 segundos.</p>
    </section>
  );
}

export function SettingsDialog() {
  return (
    <DialogFrame id="language-settings" labelledBy="settings-title" title="Configuración" closeId="settings-close" footer={<div className="settings-footer"><p id="settings-error" role="alert" /><Button type="submit" form="language-form" variant="primary">Guardar cambios</Button></div>}>
      <form id="language-form">
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Secciones de configuración">
            <Button variant="ghost" id="settings-general" aria-controls="pane-general" aria-pressed="false">General</Button>
            <Button variant="ghost" id="settings-voice" aria-controls="pane-voice" aria-pressed="true">Voces</Button>
            <Button variant="ghost" id="settings-transcription" aria-controls="pane-transcription" aria-pressed="false">Transcripción</Button>
            <Button variant="ghost" id="settings-advanced" aria-controls="pane-advanced" aria-pressed="false">Avanzado</Button>
          </nav>
          <div className="settings-content"><GeneralSettings /><VoiceSettings /><TranscriptionSettings /><AdvancedSettings /></div>
        </div>
      </form>
    </DialogFrame>
  );
}
