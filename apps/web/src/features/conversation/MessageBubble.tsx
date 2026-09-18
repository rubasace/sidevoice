import { Button } from "../../components/ui/Button";
import type { ChatMessage } from "../../state/room-types";
import { KaraokeText } from "./KaraokeText";

const receiptSymbol: Record<string, string> = { pending: "◷", sending: "◷", delivered: "✓", unconfirmed: "✓", uncertain: "!", not_sent: "!" };
const receiptLabel: Record<string, string> = {
  pending: "Enviando",
  sending: "Enviando",
  delivered: "Entregado a la conversación; lectura sin confirmar",
  unconfirmed: "Escrito en la conversación, sin acuse",
  uncertain: "Entrega sin confirmar",
  not_sent: "No enviado",
};

export function MessageBubble({ message, position, showName }: { message: ChatMessage; position: "only" | "first" | "middle" | "last"; showName: boolean }) {
  const delivery = message.role === "user" && message.delivery ? message.delivery : null;
  return (
    <article className="chat-bubble" data-role={message.role} data-position={position} data-interrupted={message.interrupted || undefined} aria-label={`${message.name}: ${message.text}`}>
      {showName && <span className="chat-sender">{message.name}</span>}
      <KaraokeText text={message.text} range={message.karaoke} />
      {message.cancellable && <Button variant="ghost" size="compact" className="cancel-input" onClick={() => void window.sidevoiceActions?.cancelInput()}>Cancelar envío</Button>}
      <div className="chat-meta">
        {!message.draft && <time dateTime={new Date(message.time).toISOString()}>{new Date(message.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
        {delivery && <span className="receipt delivery" data-state={delivery} title={receiptLabel[delivery]} aria-label={receiptLabel[delivery]}>{receiptSymbol[delivery]}</span>}
      </div>
      {message.audioNote && <span className="chat-audio-note">{message.audioNote}</span>}
    </article>
  );
}
