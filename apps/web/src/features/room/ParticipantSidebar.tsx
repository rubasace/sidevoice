import { useEffect, useRef, useState } from "react";
import { ChevronIcon, ConversationsIcon } from "../../components/ui/Icons";
import { ParticipantList } from "./ParticipantList";

/** Asked for from anywhere on the page (the phone's header button): open or close the list. */
export const TOGGLE_CONVERSATIONS = "sidevoice-conversations";

/* What is talking in this room, and nothing else. The machines behind those conversations are a
 * setting — you pair one, and then you forget it — so they live in the settings dialog.
 *
 * On a phone the list is not on screen at all (2026-09-26): the transcript needs the width. The button
 * beside the conversation's title opens this same panel over it, and choosing a conversation, or
 * touching anywhere else, closes it. */
export function ParticipantSidebar() {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const toggle = () => setOpen((value) => !value);
    window.addEventListener(TOGGLE_CONVERSATIONS, toggle);
    return () => window.removeEventListener(TOGGLE_CONVERSATIONS, toggle);
  }, []);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (panel.current?.contains(target) || target?.closest?.(".conversations-toggle")) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  return (
    <aside ref={panel} data-open={open || undefined}
      onClickCapture={(event) => { if (open && (event.target as Element).closest?.(".person")) setOpen(false); }}>
      <button type="button" className="sidebar-toggle" aria-expanded={open}
        aria-label={open ? "Cerrar la lista de conversaciones" : "Ver las conversaciones"}
        onClick={() => setOpen(!open)}>
        <ChevronIcon className={open ? "toggle-open" : undefined} />
      </button>
      <h2><ConversationsIcon /> Conversaciones</h2>
      <ParticipantList />
    </aside>
  );
}
