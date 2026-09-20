import { useRoomStore } from "../../state/room-store";
import { Button } from "../../components/ui/Button";
import { MessageList } from "./MessageList";
import { CapabilityColumn, EngineColumn } from "./StatusColumns";

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
        <CapabilityColumn />
        <div className="transcript-heading"><strong id="transcript-title">{title}</strong><span className="muted">Transcripción · ambos lados</span></div>
        <EngineColumn />
      </div>
      <MessageList conversation={conversation} />
      <form id="text-composer" className="text-composer"><textarea id="text-message" rows={2} maxLength={12000} aria-label="Mensaje escrito" placeholder="Escribe un mensaje…" disabled /><Button id="text-send" type="submit" variant="primary" disabled aria-label="Enviar mensaje">Enviar</Button></form>
      <BootError />
    </section>
  );
}
