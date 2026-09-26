import { useRoomStore } from "../../state/room-store";
import { Button } from "../../components/ui/Button";
import { MessageList } from "./MessageList";
import { ConversationsIcon } from "../../components/ui/Icons";
import { TOGGLE_CONVERSATIONS } from "../room/ParticipantSidebar";

/* On a phone the list of conversations lives behind this button, with how many are there to choose. */
function ConversationsToggle() {
  const available = useRoomStore((state) => state.participants.filter((participant) => participant.available).length);
  return (
    <button type="button" className="conversations-toggle" aria-label={`Conversaciones (${available})`} title="Conversaciones"
      onClick={() => window.dispatchEvent(new Event(TOGGLE_CONVERSATIONS))}>
      <ConversationsIcon size={18} />{available > 0 && <span className="conversations-count">{available}</span>}
    </button>
  );
}

function BootError() {
  const error = useRoomStore((state) => state.bootError);
  return <div id="error" role="alert">{error}</div>;
}

export function TranscriptPanel() {
  const conversation = useRoomStore((state) => state.conversation);
  const title = useRoomStore((state) => state.title);
  return (
    <section className="transcript">
      <div className="transcript-head">
        <div className="transcript-heading"><ConversationsToggle /><strong id="transcript-title">{title}</strong></div>
      </div>
      <MessageList conversation={conversation} />
      <form id="text-composer" className="text-composer"><textarea id="text-message" rows={2} maxLength={12000} aria-label="Mensaje escrito" placeholder="Escribe un mensaje…" disabled /><Button id="text-send" type="submit" variant="primary" disabled aria-label="Enviar mensaje">Enviar</Button></form>
      <BootError />
    </section>
  );
}
