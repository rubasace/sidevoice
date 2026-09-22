import { Button } from "../../components/ui/Button";
import { DropdownMenu, DropdownMenuItem } from "../../components/ui/DropdownMenu";
import { HARNESS_NAMES, HarnessIcon, MachinesIcon } from "../../components/ui/Icons";
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
            title={participant.detail ? participant.title + "\n\n" + participant.detail : participant.title}
            onClick={() => window.sidevoiceActions?.selectParticipant(participant.threadId)}
          >
            <span className="person-state" data-state={participant.reach} data-working={participant.working || undefined} title={participant.stateLabel}><span className="dot" /></span>
            <span className="participant-copy"><span className="person-name">{participant.title}</span><span className="person-sub muted" title={participant.activityNote || undefined}>{participant.machine && <span className="person-machine"><MachinesIcon size={12} /> {participant.machine}</span>}{participant.harness && HARNESS_NAMES[participant.harness] && <span className="person-harness"><HarnessIcon harness={participant.harness} /> {HARNESS_NAMES[participant.harness]}</span>}{(participant.machine || participant.harness) && participant.subtitle ? " · " : ""}{participant.subtitle}</span></span>
          </Button>
          <DropdownMenu label={`Opciones de ${participant.title}`} trigger={<Button variant="ghost" size="icon" className="participant-more" aria-label={`Opciones de ${participant.title}`}>⋯</Button>}>
            <DropdownMenuItem danger onSelect={() => void window.sidevoiceActions?.closeParticipant(participant.threadId)}>Cerrar conversación</DropdownMenuItem>
          </DropdownMenu>
        </div>
      ))}
    </div>
  );
}
