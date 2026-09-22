import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import type { ConversationView } from "../../state/room-types";
import { groupMessages } from "./group-messages";
import { MessageGroup } from "./MessageGroup";
import { VoiceWaveform } from "./VoiceWaveform";

export function MessageList({ conversation }: { conversation: ConversationView }) {
  const groups = useMemo(() => groupMessages(conversation.messages), [conversation.messages]);
  const viewport = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const previousLast = useRef<string | null>(null);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const [away, setAway] = useState(false);
  const lastId = conversation.messages.at(-1)?.segment || null;

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    const node = viewport.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    nearBottom.current = true;
    setShowNewMessages(false);
    setAway(false);
  };

  // Anything that changes the height of the log counts, the thinking bubble included: it appeared after
  // this ran and left the view a sliver short of the bottom, which is exactly where the dots live (#64).
  useLayoutEffect(() => {
    if (nearBottom.current) scrollToBottom("auto");
    else if (lastId && lastId !== previousLast.current) setShowNewMessages(true);
    previousLast.current = lastId;
  }, [lastId, conversation.pendingText, conversation.pendingPhase, conversation.working, conversation.messages.length]);

  return (
    <div className="message-viewport-wrap">
      <div id="messages" ref={viewport} role="log" aria-live="polite" onScroll={(event) => {
        const node = event.currentTarget;
        nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        setAway(!nearBottom.current);
        if (nearBottom.current) setShowNewMessages(false);
      }}>
        {groups.map((group) => <MessageGroup group={group} key={group.id} />)}
        {(conversation.pendingText || conversation.pendingPhase) && <div className="message-group live-draft" data-role="user"><div className="chat-message-row"><article className="chat-bubble" data-role="user" data-position="only" data-draft="true" data-live={conversation.pendingText ? undefined : conversation.pendingPhase || undefined}>{conversation.pendingText ? <span>{conversation.pendingText}</span> : <VoiceWaveform phase={conversation.pendingPhase === "transcribing" ? "transcribing" : "listening"} />}{conversation.pendingCancellable && <Button variant="ghost" size="compact" className="cancel-input" onClick={() => void window.sidevoiceActions?.cancelInput()}>Cancelar envío</Button>}</article></div></div>}
        {conversation.working && <div className="message-group live-draft" data-role="assistant"><div className="chat-message-row"><article className="chat-bubble thinking" data-role="assistant" data-position="only" aria-label="La conversación está trabajando en tu mensaje"><span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span></article></div></div>}
      </div>
      {(showNewMessages || away) && <Button className="new-messages" size="compact" aria-label="Ir al final de la conversación" onClick={() => scrollToBottom()}>{showNewMessages ? "Nuevos mensajes ↓" : "Ir al final ↓"}</Button>}
    </div>
  );
}
