import { useState } from "react";
import { ChevronIcon, ConversationsIcon } from "../../components/ui/Icons";
import { ParticipantList } from "./ParticipantList";

/* What is talking in this room, and nothing else. The machines behind those conversations are a
 * setting — you pair one, and then you forget it — so they live in the settings dialog.
 *
 * On a phone this is a rail of initials at the left edge, and the button opens it over the transcript:
 * the list stays where it is on every screen, instead of moving above the conversation on a small one. */
export function ParticipantSidebar() {
  const [open, setOpen] = useState(false);
  return (
    <aside data-open={open || undefined}>
      <button type="button" className="sidebar-toggle" aria-expanded={open}
        aria-label={open ? "Cerrar la lista de conversaciones" : "Ver las conversaciones"}
        onClick={() => setOpen(!open)}>
        <ChevronIcon className={open ? "toggle-open" : undefined} />
      </button>
      <h2><ConversationsIcon /> Conversaciones</h2>
      <ParticipantList />
    </aside>
  );
}
