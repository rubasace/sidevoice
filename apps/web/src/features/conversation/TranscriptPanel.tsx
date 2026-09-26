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

/* On a phone the call bar's lights and the models behind them are one dot in the head's right corner — the
 * worst of them — and their detail opens from it, so the bar keeps one row of buttons (2026-09-26). */
function StatusSummary() {
  const lights = useRoomStore((state) => state.capabilityPanel);
  const engines = useRoomStore((state) => state.enginePanel);
  const [open, setOpen] = useState(false);
  const rows = [...lights, ...engines];
  if (!rows.length) return null;
  const worst = rows.some((row) => row.state === "fail") ? "fail" : rows.some((row) => row.state === "warn") ? "warn" : "ok";
  return (
    <div className="status-summary" data-open={open || undefined}>
      <button type="button" className="status-summary-toggle" aria-expanded={open} aria-label="Estado de la llamada" title="Estado de la llamada"
        onClick={() => setOpen(!open)}><i className="engine-dot" data-state={worst} aria-hidden="true" /></button>
      {open && (
        <dl className="status-summary-panel" onClick={() => setOpen(false)}>
          {lights.map((row) => <div className="status-line" key={row.id} data-state={row.state}><i className="engine-dot" data-state={row.state} aria-hidden="true" /><dt>{row.label}</dt><dd>{row.note || row.value}</dd></div>)}
          {engines.map((row) => <div className="status-line" key={row.id} data-state={row.state}><i className="engine-dot" data-state={row.state} aria-hidden="true" /><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
        </dl>
      )}
    </div>
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
        <StatusSummary />
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
