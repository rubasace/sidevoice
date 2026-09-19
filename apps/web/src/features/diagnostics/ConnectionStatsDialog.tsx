import { DialogFrame } from "../../components/ui/DialogFrame";
import { Button } from "../../components/ui/Button";

const cards = [
  ["Última voz → texto enviado", "stats-endpoint", "Mediana · silencio + Whisper"],
  ["Texto enviado → respuesta", "stats-response", "Mediana · primera respuesta por turno"],
  ["Síntesis completa", "stats-synthesis", "Mediana · respuestas medidas"],
  ["Preparación en el navegador", "stats-playout", "Audio recibido → reproducción programada"]
];

export function ConnectionStatsDialog() {
  return (
    <DialogFrame id="connection-stats" labelledBy="stats-title" eyebrow="Diagnóstico de la llamada" title="Conexión y latencia" closeId="stats-close" footer={<div className="stats-footer"><span id="stats-updated" className="muted" /><Button id="stats-refresh">Actualizar</Button></div>}>
      <div className="stats-body">
        <p id="stats-status" role="status">Recogiendo mediciones…</p>
        <div className="stats-cards">{cards.map(([label, id, note]) => <div key={id}><span>{label}</span><strong id={id}>—</strong><small>{note}</small></div>)}</div>
        <section aria-labelledby="stats-connection-title"><h3 id="stats-connection-title">Estado de la conexión</h3><dl className="connection-facts" id="stats-connection" /></section>
        <section aria-labelledby="stats-stages-title"><h3 id="stats-stages-title">Tramos del último turno</h3><p className="muted" id="stats-stages-note">De tu última voz al audio de la respuesta, en el orden en que ocurren; cada tramo se mide en su propio reloj.</p><ol id="stats-stages" className="stats-stages" aria-label="Tramos del último turno" /></section>
        <section aria-labelledby="stats-aggregates-title"><h3 id="stats-aggregates-title">Agregados de la sesión</h3><p className="muted" id="stats-aggregates-note">Recuento, media, p50, p90 y máximo por tramo. Los tramos se solapan: no se deben sumar.</p><div id="stats-aggregates" className="stats-aggregates" /><div className="stats-aggregates-actions"><Button id="stats-aggregates-copy">Copiar como texto</Button><span id="stats-aggregates-copied" className="muted" role="status" /></div></section>
        <section aria-labelledby="stats-turns-title"><h3 id="stats-turns-title">Últimas respuestas</h3><p className="muted">Los tramos se solapan: no se deben sumar. «Agente» incluye entrega, colas y generación, no solo el modelo.</p><div className="stats-table-wrap" tabIndex={0} aria-label="Mediciones por respuesta"><table className="stats-table"><thead><tr><th>Turno</th><th>Fin de voz → texto</th><th>Silencio</th><th>Whisper</th><th>Agente</th><th>Espera de audio</th><th>Primer fragmento TTS</th><th>TTS completa</th><th>Navegador</th><th>Estado</th></tr></thead><tbody id="stats-rows" /></table></div><p id="stats-empty" className="muted" /></section>
        <p className="stats-limitations">Son mediciones de la aplicación, no del sonido que sale del altavoz. No incluyen una medición física del retraso Bluetooth. Los datos faltantes aparecen como «—», nunca como cero.</p>
      </div>
    </DialogFrame>
  );
}
