import { Avatar } from "../../components/ui/Avatar";
import type { MessageGroupView } from "./group-messages";
import { MessageBubble } from "./MessageBubble";

export function MessageGroup({ group }: { group: MessageGroupView }) {
  const incoming = group.role === "assistant";
  return (
    <section className="message-group" data-role={group.role} aria-label={`Mensajes de ${group.name}`}>
      {group.messages.map((message, index) => {
        const last = group.messages.length - 1;
        const position = last === 0 ? "only" : index === 0 ? "first" : index === last ? "last" : "middle";
        return (
          <div className="chat-message-row" key={message.segment || `${message.time}-${index}`}>
            {incoming && (index === 0 ? <Avatar name={group.name} decorative /> : <span className="chat-avatar-spacer" aria-hidden="true" />)}
            <MessageBubble message={message} position={position} showName={incoming && index === 0} />
          </div>
        );
      })}
    </section>
  );
}
