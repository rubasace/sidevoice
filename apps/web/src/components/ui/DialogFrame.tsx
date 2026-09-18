import { useState, type PropsWithChildren, type ReactNode } from "react";
import { Button } from "./Button";
import { OverlayPortalProvider } from "./Tooltip";

interface DialogFrameProps extends PropsWithChildren {
  id: string;
  labelledBy: string;
  eyebrow?: string;
  title: string;
  closeId: string;
  footer?: ReactNode;
  className?: string;
}

export function DialogFrame({ id, labelledBy, eyebrow, title, closeId, footer, className = "", children }: DialogFrameProps) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  return (
    <dialog ref={setDialog} id={id} className={className} aria-labelledby={labelledBy}>
      <OverlayPortalProvider container={dialog}>
        <div className="settings-heading stats-heading">
        <div>{eyebrow && <span className="stats-eyebrow">{eyebrow}</span>}<h2 id={labelledBy}>{title}</h2></div>
        <Button id={closeId} variant="ghost" size="icon" aria-label={`Cerrar ${title.toLowerCase()}`} title="Cerrar">×</Button>
      </div>
      {children}
      {footer}
      </OverlayPortalProvider>
    </dialog>
  );
}
