import { Button } from "../../components/ui/Button";
import { DropdownMenu, DropdownMenuItem } from "../../components/ui/DropdownMenu";
import { HARNESS_NAMES, HarnessIcon, MachinesIcon, MoreIcon } from "../../components/ui/Icons";
import { useRoomStore } from "../../state/room-store";

/** The shortest thing that still tells two conversations apart, for the narrow rail a phone gets. */
function initials(title: string) {
  const words = title.split(/[\s·—–-]+/).filter(Boolean);
  return (words.slice(0, 2).map((word) => word[0]).join("") || "?").toUpperCase();
}

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
            <span className="person-initials" aria-hidden="true">{initials(participant.title)}</span><span className="person-state" data-state={participant.reach} data-working={participant.working || undefined} title={participant.stateLabel}><span className="dot" /></span>
            <span className="participant-copy"><span className="person-name" title={participant.title}>{participant.title}</span><span className="person-sub muted" title={participant.activityNote || undefined}>{participant.machine && <span className="person-machine"><MachinesIcon size={12} /> {participant.machine}</span>}{participant.harness && HARNESS_NAMES[participant.harness] && <span className="person-harness"><HarnessIcon harness={participant.harness} /> {HARNESS_NAMES[participant.harness]}</span>}{(participant.machine || participant.harness) && participant.subtitle ? " · " : ""}{participant.subtitle}</span></span>
          </Button>
          <DropdownMenu label={`Opciones de ${participant.title}`} trigger={<Button variant="ghost" size="icon" className="participant-more" aria-label={`Opciones de ${participant.title}`}><MoreIcon /></Button>}>
            <DropdownMenuItem danger onSelect={() => void window.sidevoiceActions?.closeParticipant(participant.threadId)}>Cerrar conversación</DropdownMenuItem>
          </DropdownMenu>
        </div>
      ))}
    </div>
  );
}
