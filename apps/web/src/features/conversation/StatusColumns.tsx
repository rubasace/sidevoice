import { useState } from "react";
import { useRoomStore } from "../../state/room-store";
import { Button } from "../../components/ui/Button";
import { ModelsIcon } from "../../components/ui/Icons";

/* The two edges of the call bar. Left: what this call has switched on, as a light and the name of the
 * thing — never the sentence, which said "cancelación activa" beside a green dot that had already said
 * it. What the light cannot say is in its title, for whoever wants it. Right: what listens, speaks and
 * thinks, by name; on a phone there is no room for three names beside the island, so they wait behind
 * a button and come up over it. */
type StatusRow = { id: string; label: string; value: string; state: "ok" | "warn" | "fail"; note: string };

function StatusColumn({ id, rows, lights, label }: { id: string; rows: StatusRow[]; lights: boolean; label: string }) {
  if (!rows.length) return <dl id={id} className="status-column" aria-label={label} hidden />;
  return (
    <dl id={id} className="status-column" data-kind={lights ? "lights" : "models"} aria-label={label}>
      {rows.map((row) => (
        <div className="status-line" key={row.id} data-state={row.state}
          title={[row.value, row.note].filter(Boolean).join(" · ") || undefined}>
          {lights ? <i className="engine-dot" data-state={row.state} aria-hidden="true" /> : null}
          <dt>{row.label}</dt>
          {lights ? null : <dd>{row.value}</dd>}
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
  const [open, setOpen] = useState(false);
  return (
    <div className="engine-slot" data-open={open || undefined}>
      <Button id="engine-open" variant="ghost" size="icon" className="engine-toggle" aria-expanded={open}
        aria-label="Qué modelos responden" title="Qué modelos responden" onClick={() => setOpen(!open)}>
        <ModelsIcon />
      </Button>
      <StatusColumn id="engine-column" rows={rows} lights={false} label="Qué modelos responden" />
    </div>
  );
}
