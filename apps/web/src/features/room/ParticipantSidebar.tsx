import { Button } from "../../components/ui/Button";
import { DialogFrame } from "../../components/ui/DialogFrame";
import { ConversationsIcon, CopyIcon, RefreshIcon } from "../../components/ui/Icons";
import { MachineList } from "./MachineList";
import { ParticipantList } from "./ParticipantList";

export function ParticipantSidebar() {
  return (
    <aside>
      <h2><ConversationsIcon /> Conversaciones</h2>
      <ParticipantList />
      <MachineList />
      <DialogFrame id="pair-dialog" className="pair-dialog" labelledBy="pair-title" title="Emparejar máquina" closeId="pair-close">
        <div className="pair-row">
          <code id="pair-code" className="pair-code" aria-live="polite" />
          <Button id="pair-copy" variant="ghost" size="icon" aria-label="Copiar código" title="Copiar código"><CopyIcon /></Button>
          <Button id="pair-refresh" variant="ghost" size="icon" aria-label="Nuevo código" title="Nuevo código"><RefreshIcon /></Button>
        </div>
        <p className="muted pair-meta"><span id="pair-expires" /> · Un solo uso</p>
      </DialogFrame>
    </aside>
  );
}
