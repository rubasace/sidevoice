import { useRoomStore } from "../../state/room-store";

/* On a phone the conversations are tabs in the header, between the mark and the settings: a side rail took
 * a column the transcript needed (2026-09-26). One tab per conversation, its state dot and its title,
 * scrolling sideways like an editor's tabs. On a wider screen the sidebar shows them and this stays hidden. */
export function ConversationTabs() {
  const participants = useRoomStore((state) => state.participants);
  if (!participants.length) return null;
  return (
    <nav className="conversation-tabs" aria-label="Conversaciones">
      {participants.map((participant) => (
        <button type="button" key={participant.threadId} className="conversation-tab"
          aria-pressed={participant.selected} data-reach={participant.reach} disabled={participant.switching}
          title={participant.detail ? participant.title + "\n\n" + participant.detail : participant.title}
          onClick={() => window.sidevoiceActions?.selectParticipant(participant.threadId)}>
          <span className="person-state" data-state={participant.reach} data-working={participant.working || undefined} title={participant.stateLabel}><span className="dot" /></span>
          <span className="conversation-tab-title">{participant.title}</span>
        </button>
      ))}
    </nav>
  );
}
