import { ModelPicker } from "../../components/models/ModelPicker";
import { Button } from "../../components/ui/Button";
import { NativeSelect } from "../../components/ui/NativeSelect";
import { useRoomStore } from "../../state/room-store";

export function LanguageModelList() {
  const rows = useRoomStore((state) => state.languageModels);
  return (
    <div id="language-rows">
      {!!rows.length && <div className="language-row language-row-head" aria-hidden="true"><span>Idioma</span><span>Modelo</span><span>Voz</span><span>Velocidad</span><span /></div>}
      {rows.map((row) => (
        <div className="language-row" key={row.language}>
          <strong className="language-name">{row.label}</strong>
          <ModelPicker
            compact
            label="Modelo"
            aria-label={`Modelo · ${row.label}`}
            id={`model-${row.language}`}
            value={row.model}
            description={row.modelDescription}
            onChange={(event) => window.sidevoiceActions?.updateLanguageModel(row.language, event.target.value)}
          >
            {row.modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </ModelPicker>
          <label className="language-control language-voice">
            <span className="ui-compact-label">Voz</span>
          <NativeSelect id={`voice-${row.language}`} aria-label={`Voz · ${row.label}`} value={row.voice} onChange={(event) => window.sidevoiceActions?.updateLanguageVoice(row.language, event.target.value)}>
            {row.voiceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </NativeSelect>
          </label>
          <label className="language-control language-speed">
            <span className="ui-compact-label">Velocidad</span>
          <input
            id={`speed-${row.language}`}
            type="number"
            min={row.speedMin}
            max={row.speedMax}
            step="0.05"
            value={row.speed ?? ""}
            placeholder={`${row.inheritedSpeed.toFixed(2)}×`}
            title={`Vacío: velocidad global, ajustada al rango del motor (${row.speedMin}–${row.speedMax}×).`}
            aria-label={`Velocidad · ${row.label}`}
            onChange={(event) => window.sidevoiceActions?.updateLanguageSpeed(row.language, event.target.value === "" ? null : Number(event.target.value))}
          />
          </label>
          <Button className="language-preview" id={`preview-${row.language}`} variant="ghost" size="icon" aria-label={`Probar voz · ${row.label}`} title={`Probar voz · ${row.label}`} onClick={() => void window.sidevoiceActions?.previewVoice(row.language)}>▶</Button>
        </div>
      ))}
    </div>
  );
}
