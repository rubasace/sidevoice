import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { useRoomStore } from "../../state/room-store";

/** The machines paired with this room, and the only place a person can take a pairing away.
 *
 *  Revoking is not undoable — the machine needs a new one-time code to come back — so it asks first,
 *  in the row itself: a browser `confirm()` would take the whole page hostage for a question about
 *  one line of it. A machine already revoked stays listed, greyed, until somebody removes it; the
 *  note under the list says so, because otherwise the row looks like a revocation that did not work. */
export function MachineList() {
  const machines = useRoomStore((state) => state.machines);
  const [asking, setAsking] = useState<string | null>(null);

  return (
    <div className="machines" id="machines">
      <h3>Máquinas</h3>
      {machines.length === 0 && <p className="muted">Ninguna máquina emparejada todavía.</p>}
      {machines.map((machine) => (
        <div className="machine-row" key={machine.id} data-state={machine.state}>
          <div className="machine-copy">
            <span className="machine-name">{machine.host}<span className="machine-state" data-state={machine.state}><span className="dot" />{machine.stateLabel}</span></span>
            {machine.description && <span className="machine-detail">{machine.description}</span>}
            <span className="machine-detail muted">{[machine.pairedLabel, machine.seenLabel].filter(Boolean).join(" · ")}</span>
          </div>
          {asking === machine.id ? (
            <div className="machine-confirm" role="group" aria-label={`Confirmar para ${machine.host}`}>
              <span className="muted">{machine.revoked ? "¿Quitar de la lista?" : "¿Revocar el emparejamiento?"}</span>
              <Button
                variant="danger"
                size="compact"
                disabled={machine.busy}
                onClick={() => { setAsking(null); void window.sidevoiceActions?.revokeMachine(machine.id); }}
              >{machine.revoked ? "Sí, quitar" : "Sí, revocar"}</Button>
              <Button variant="ghost" size="compact" onClick={() => setAsking(null)}>Cancelar</Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="compact"
              className="machine-action"
              disabled={machine.busy}
              aria-label={`${machine.revoked ? "Quitar" : "Revocar"} ${machine.host}`}
              onClick={() => setAsking(machine.id)}
            >{machine.revoked ? "Quitar" : "Revocar"}</Button>
          )}
        </div>
      ))}
      {machines.some((machine) => machine.revoked) && (
        <p className="muted">Una máquina revocada sigue en la lista hasta que la quitas. No puede volver a conectarse: para usarla otra vez, emparéjala de nuevo con un código.</p>
      )}
    </div>
  );
}
