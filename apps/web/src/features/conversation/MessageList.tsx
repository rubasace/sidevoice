import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import type { ConversationView } from "../../state/room-types";
import { groupMessages } from "./group-messages";
import { MessageGroup } from "./MessageGroup";

export function MessageList({ conversation }: { conversation: ConversationView }) {
  const groups = useMemo(() => groupMessages(conversation.messages), [conversation.messages]);
  const viewport = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const previousLast = useRef<string | null>(null);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const lastId = conversation.messages.at(-1)?.segment || null;

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    const node = viewport.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    nearBottom.current = true;
    setShowNewMessages(false);
  };

  useLayoutEffect(() => {
    if (nearBottom.current) scrollToBottom("auto");
    else if (lastId && lastId !== previousLast.current) setShowNewMessages(true);
    previousLast.current = lastId;
  }, [lastId, conversation.pendingText]);

  return (
    <div className="message-viewport-wrap">
      <div id="messages" ref={viewport} role="log" aria-live="polite" onScroll={(event) => {
        const node = event.currentTarget;
        nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        if (nearBottom.current) setShowNewMessages(false);
      }}>
        {!groups.length && !conversation.pendingText && <div className="empty"><b>Hablemos de lo que sigue.</b><span>Tu voz y la respuesta aparecerán aquí.<br />El historial de la sala se conserva al reconectar.</span></div>}
        {groups.map((group) => <MessageGroup group={group} key={group.id} />)}
        {conversation.pendingText && <div className="message-group live-draft" data-role="user"><div className="chat-message-row"><article className="chat-bubble" data-role="user" data-position="only" data-draft="true"><span>{conversation.pendingText}</span>{conversation.pendingCancellable && <Button variant="ghost" size="compact" className="cancel-input" onClick={() => void window.sidevoiceActions?.cancelInput()}>Cancelar envío</Button>}</article></div></div>}
      </div>
      {showNewMessages && <Button className="new-messages" size="compact" onClick={() => scrollToBottom()}>Nuevos mensajes ↓</Button>}
    </div>
  );
}
