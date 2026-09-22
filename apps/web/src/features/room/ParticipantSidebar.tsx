import { ConversationsIcon } from "../../components/ui/Icons";
import { ParticipantList } from "./ParticipantList";

/* What is talking in this room, and nothing else. The machines behind those conversations are a
 * setting — you pair one, and then you forget it — so they live in the settings dialog. */
export function ParticipantSidebar() {
  return (
    <aside>
      <h2><ConversationsIcon /> Conversaciones</h2>
      <ParticipantList />
    </aside>
  );
}
