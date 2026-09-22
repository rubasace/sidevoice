import { Button } from "../../components/ui/Button";
import { MachineList } from "./MachineList";
import { ParticipantList } from "./ParticipantList";

export function ParticipantSidebar() {
  return (
    <aside>
      <h2>Conversaciones</h2>
      <ParticipantList />
      <div className="pairing">
        <Button id="pair-connector" variant="ghost" size="compact">Emparejar conector</Button>
        <code id="pair-code" hidden />
        <p className="muted" id="pair-help" hidden>Código válido 3 minutos, un solo uso. Dáselo al agente cuando pida emparejar; a mano: <code>sidevoice pair &lt;url de esta sala&gt; CÓDIGO</code></p>
      </div>
      <MachineList />
    </aside>
  );
}
