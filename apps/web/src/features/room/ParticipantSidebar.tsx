import { Button } from "../../components/ui/Button";
import { DialogFrame } from "../../components/ui/DialogFrame";
import { MachineList } from "./MachineList";
import { ParticipantList } from "./ParticipantList";

export function ParticipantSidebar() {
  return (
    <aside>
      <h2>Conversaciones</h2>
      <ParticipantList />
      <div className="pairing">
        <Button id="pair-connector" variant="ghost" size="compact">Emparejar conector</Button>
      </div>
      <DialogFrame id="pair-dialog" className="pair-dialog" labelledBy="pair-title" title="Emparejar conector" closeId="pair-close"
        footer={<div className="pair-footer"><Button id="pair-refresh" variant="ghost" size="compact">Nuevo código</Button></div>}>
        <code id="pair-code" className="pair-code" aria-live="polite" />
        <p className="muted pair-meta"><span id="pair-expires" /> · Un solo uso</p>
      </DialogFrame>
      <MachineList />
    </aside>
  );
}
