import { Button } from "../../components/ui/Button";
import { ParticipantList } from "./ParticipantList";

export function ParticipantSidebar() {
  return (
    <aside>
      <h2>Conversaciones</h2>
      <ParticipantList />
      <div className="pairing">
        <Button id="pair-connector" variant="ghost" size="compact">Emparejar conector</Button>
        <code id="pair-code" hidden />
        <p className="muted" id="pair-help" hidden>Código válido 10 minutos, un solo uso. En la máquina del agente: <code>sidevoice pair &lt;url de esta sala&gt; CÓDIGO</code></p>
      </div>
    </aside>
  );
}
