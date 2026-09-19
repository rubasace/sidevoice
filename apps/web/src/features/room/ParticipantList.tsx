import { Avatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { DropdownMenu, DropdownMenuItem } from "../../components/ui/DropdownMenu";
import { useRoomStore } from "../../state/room-store";

export function ParticipantList() {
  const participants = useRoomStore((state) => state.participants);
  return (
    <div id="participants">
      {participants.map((participant) => (
        <div className="participant-row" data-selected={participant.selected || undefined} key={participant.threadId}>
          <Button
            variant="ghost"
            className="person"
            data-reach={participant.reach}
            aria-pressed={participant.selected}
            disabled={participant.switching}
            title={participant.detail}
            onClick={() => window.sidevoiceActions?.selectParticipant(participant.threadId)}
          >
            <Avatar name={participant.title} decorative />
            <span className="participant-copy"><span className="person-name">{participant.title}</span><span className="person-state" data-state={participant.reach}><span className="dot" />{participant.stateLabel}</span>{participant.activityNote && <span className="person-capability">{participant.activityNote}</span>}</span>
          </Button>
          <DropdownMenu label={`Opciones de ${participant.title}`} trigger={<Button variant="ghost" size="icon" className="participant-more" aria-label={`Opciones de ${participant.title}`}>⋯</Button>}>
            <DropdownMenuItem danger onSelect={() => void window.sidevoiceActions?.closeParticipant(participant.threadId)}>Cerrar conversación</DropdownMenuItem>
          </DropdownMenu>
        </div>
      ))}
    </div>
  );
}
