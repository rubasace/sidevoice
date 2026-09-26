import { useRoomStore } from "../../state/room-store";
import { Button } from "../../components/ui/Button";
import { MessageList } from "./MessageList";
import { ConversationsIcon, KeyboardIcon } from "../../components/ui/Icons";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
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
  // On a phone the text box is away until it is asked for: a keyboard button opens it, and sending — or
  // leaving it empty — puts it away again, so the conversation keeps the height (2026-09-26).
  const [composing, setComposing] = useState(false);
  const composer = useRef<HTMLFormElement>(null);
  // Shown and focused inside the tap itself: the phone only raises its keyboard for a focus a gesture made.
  const compose = () => {
    flushSync(() => setComposing(true));
    composer.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  };
  return (
    <section className="transcript">
      <div className="transcript-head">
        <div className="transcript-heading"><ConversationsToggle /><strong id="transcript-title">{title}</strong></div>
      </div>
      <MessageList conversation={conversation} />
      <button type="button" className="compose-toggle" hidden={composing} aria-label="Escribir un mensaje" title="Escribir un mensaje"
        onClick={compose}><KeyboardIcon /></button>
      <form id="text-composer" className="text-composer" ref={composer} data-open={composing || undefined}
        onSubmitCapture={() => setComposing(false)}
        onBlurCapture={(event) => { const next = event.relatedTarget as Node | null; if (next && composer.current?.contains(next)) return; if (!composer.current?.querySelector<HTMLTextAreaElement>("textarea")?.value.trim()) setComposing(false); }}><textarea id="text-message" rows={2} maxLength={12000} aria-label="Mensaje escrito" placeholder="Escribe un mensaje…" disabled /><Button id="text-send" type="submit" variant="primary" disabled aria-label="Enviar mensaje">Enviar</Button></form>
      <BootError />
    </section>
  );
}
