import { Button } from "../../components/ui/Button";
import { ListenAgainIcon } from "../../components/ui/Icons";
import type { ChatMessage } from "../../state/room-types";
import { KaraokeText } from "./KaraokeText";

import { receiptView } from "../../state/room-session-state.js";

export function MessageBubble({ message, position, showName }: { message: ChatMessage; position: "only" | "first" | "middle" | "last"; showName: boolean }) {
  const delivery = message.role === "user" && message.delivery ? message.delivery : null;
  return (
    <article className="chat-bubble" data-role={message.role} data-position={position} data-interrupted={message.interrupted || undefined} aria-label={`${message.name}: ${message.text}`}>
      {showName && <span className="chat-sender">{message.name}</span>}
      <KaraokeText text={message.text} range={message.karaoke} playback={message.playback} />
      {message.cancellable && <Button variant="ghost" size="compact" className="cancel-input" onClick={() => void window.sidevoiceActions?.cancelInput()}>Cancelar envío</Button>}
      <div className="chat-meta">
        {message.replayable && message.role === "assistant" && message.playback !== "playing" && message.playback !== "pending" &&
          <Button variant="ghost" size="compact" className="listen-again" aria-label="Volver a escuchar" title="Volver a escuchar"
            onClick={() => void window.sidevoiceActions?.replayReply(message.segment)}><ListenAgainIcon size={14} /></Button>}
        {!message.draft && <time dateTime={new Date(message.time).toISOString()}>{new Date(message.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
        {delivery && <span className="receipt delivery" data-state={delivery} title={receiptView(delivery).label} aria-label={receiptView(delivery).label}>{receiptView(delivery).symbol}</span>}
      </div>
      {message.offlineNote && <span className="chat-audio-note">{message.offlineNote}</span>}
      {message.deliveryNote && <span className="chat-audio-note">{message.deliveryNote}</span>}
      {message.replayNote && <span className="chat-audio-note">{message.replayNote}</span>}
      {message.audioNote && <span className="chat-audio-note">{message.audioNote}</span>}
    </article>
  );
}
