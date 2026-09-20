import { useRoomStore } from "../../state/room-store";

/* Two columns in the transcript header, one at each edge, each a single column of rows aligned left.
 * Left: what this call has switched on, with a light per row. Right: what listens, what speaks, what
 * thinks — names, no lights, because a model is not a state. Nothing to open: it is all on screen. */
type StatusRow = { id: string; label: string; value: string; state: "ok" | "warn" | "fail"; note: string };

function StatusColumn({ id, rows, lights, label }: { id: string; rows: StatusRow[]; lights: boolean; label: string }) {
  if (!rows.length) return <dl id={id} className="status-column" aria-label={label} hidden />;
  return (
    <dl id={id} className="status-column" data-kind={lights ? "lights" : "models"} aria-label={label}>
      {rows.map((row) => (
        <div className="status-line" key={row.id} data-state={row.state} title={row.note || undefined}>
          {lights ? <i className="engine-dot" data-state={row.state} aria-hidden="true" /> : null}
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CapabilityColumn() {
  const rows = useRoomStore((state) => state.capabilityPanel);
  return <StatusColumn id="capability-column" rows={rows} lights label="Lo que está activo en esta llamada" />;
}

export function EngineColumn() {
  const rows = useRoomStore((state) => state.enginePanel);
  return <StatusColumn id="engine-column" rows={rows} lights={false} label="Qué modelos responden" />;
}
