import { HARNESS_NAMES, HarnessIcon, MachinesIcon } from "../../components/ui/Icons";
import { useRoomStore } from "../../state/room-store";

/* On a phone the conversations are a strip under the header, scrolling sideways, each one the same card
 * the sidebar shows — title, state, machine and harness — because a rail of initials took a column the
 * transcript needs and said too little (2026-09-26). On a wider screen the sidebar shows them instead. */
export function ConversationTabs() {
  const participants = useRoomStore((state) => state.participants);
  if (!participants.length) return null;
  return (
    <nav className="conversation-tabs" aria-label="Conversaciones">
      {participants.map((participant) => (
        <button type="button" key={participant.threadId} className="conversation-tab person"
          aria-pressed={participant.selected} data-reach={participant.reach} disabled={participant.switching}
          title={participant.detail ? participant.title + "\n\n" + participant.detail : participant.title}
          onClick={() => window.sidevoiceActions?.selectParticipant(participant.threadId)}>
          <span className="person-state" data-state={participant.reach} data-working={participant.working || undefined} title={participant.stateLabel}><span className="dot" /></span>
          <span className="participant-copy"><span className="person-name">{participant.title}</span><span className="person-sub muted">{participant.machine && <span className="person-machine"><MachinesIcon size={12} /> {participant.machine}</span>}{participant.harness && HARNESS_NAMES[participant.harness] && <span className="person-harness"><HarnessIcon harness={participant.harness} /> {HARNESS_NAMES[participant.harness]}</span>}</span></span>
        </button>
      ))}
    </nav>
  );
}
