import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { ChevronIcon, ConnectorIcon, MachinesIcon, PlatformIcon } from "../../components/ui/Icons";
import { useRoomStore } from "../../state/room-store";

/** The machines paired with this room, and the only place a person can take a pairing away.
 *
 *  A row says the least that identifies a machine — its name and whether it is here — and opens
 *  on demand to say the rest: what it runs, how many conversations it carries, since when, and the
 *  action that takes its pairing away. Revoking is not undoable (the machine needs a new one-time
 *  code to come back), so it asks first, in the row: a browser `confirm()` would take the whole
 *  page hostage for a question about one line of it. A machine already revoked stays listed,
 *  greyed, until somebody removes it; the note under the list says so. Pairing a new machine
 *  starts here too, since this is where the result appears. */
export function MachineList() {
  const machines = useRoomStore((state) => state.machines);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [asking, setAsking] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((current) => ({ ...current, [id]: !current[id] }));

  return (
    <div className="machines" id="machines">
      <h3><MachinesIcon /> Máquinas</h3>
      {machines.length === 0 && <p className="muted">Ninguna máquina emparejada todavía.</p>}
      {machines.map((machine) => (
        <div className="machine-row" key={machine.id} data-state={machine.state} data-open={open[machine.id] || undefined}>
          <button
            type="button"
            className="machine-summary"
            aria-expanded={!!open[machine.id]}
            aria-label={`${open[machine.id] ? "Ocultar detalles de" : "Mostrar detalles de"} ${machine.host}`}
            onClick={() => toggle(machine.id)}
          >
            <span className="machine-state" data-state={machine.state} title={machine.stateLabel}><span className="dot" /></span>
            <span className="machine-copy"><span className="machine-name" title={machine.host}>{machine.host}</span>
              <span className="machine-brief muted">
                {machine.platform && <span className="machine-tag"><PlatformIcon platform={machine.platform} /> {machine.platform}</span>}
                {machine.version && <span className="machine-tag" title="Versión del conector"><ConnectorIcon /> {machine.version}</span>}
              </span></span>
            <ChevronIcon className="machine-chevron" />
          </button>
          {open[machine.id] && (
            <div className="machine-details">
              <span className="machine-detail">{[machine.stateLabel, machine.conversationsLabel].filter(Boolean).join(" · ")}</span>
              <span className="machine-detail muted">{[machine.pairedLabel, machine.seenLabel].filter(Boolean).join(" · ")}</span>
              {asking === machine.id ? (
                <div className="machine-confirm" role="group" aria-label={`Confirmar para ${machine.host}`}>
                  <span className="muted">{machine.revoked ? "¿Quitar de la lista?" : "¿Revocar el emparejamiento?"}</span>
                  <Button variant="danger" size="compact" disabled={machine.busy}
                    onClick={() => { setAsking(null); void window.sidevoiceActions?.revokeMachine(machine.id); }}
                  >{machine.revoked ? "Sí, quitar" : "Sí, revocar"}</Button>
                  <Button variant="ghost" size="compact" onClick={() => setAsking(null)}>Cancelar</Button>
                </div>
              ) : (
                <Button variant="ghost" size="compact" className="machine-action" disabled={machine.busy}
                  aria-label={`${machine.revoked ? "Quitar" : "Revocar"} ${machine.host}`}
                  onClick={() => setAsking(machine.id)}
                >{machine.revoked ? "Quitar" : "Revocar"}</Button>
              )}
            </div>
          )}
        </div>
      ))}
      {machines.some((machine) => machine.revoked) && (
        <p className="muted">Una máquina revocada sigue en la lista hasta que la quitas. No puede volver a conectarse: para usarla otra vez, emparéjala de nuevo con un código.</p>
      )}
      <div className="pairing">
        <Button id="pair-connector" variant="ghost" size="compact">Emparejar máquina</Button>
      </div>
    </div>
  );
}
