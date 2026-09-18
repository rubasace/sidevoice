import { Button } from "../../components/ui/Button";

export function PreparationDialog() {
  return (
    <dialog id="voice-loading" aria-labelledby="loading-title">
      <h2 id="loading-title">Preparando voz</h2>
      <p id="loading-note">La primera vez se descargan el modelo y la voz. Después se reutiliza la caché de este navegador.</p>
      <p id="loading-detail" role="status" />
      <progress id="loading-progress" max="100" aria-label="Progreso de preparación" />
      <output id="loading-percent" aria-live="polite" />
      <Button id="loading-cancel">Cancelar</Button>
    </dialog>
  );
}
