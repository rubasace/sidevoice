import type { PropsWithChildren, ReactNode } from "react";
import { Button } from "./Button";

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
  return (
    <dialog id={id} className={className} aria-labelledby={labelledBy}>
      <div className="settings-heading stats-heading">
        <div>{eyebrow && <span className="stats-eyebrow">{eyebrow}</span>}<h2 id={labelledBy}>{title}</h2></div>
        <Button id={closeId} variant="ghost" size="icon" aria-label={`Cerrar ${title.toLowerCase()}`} title="Cerrar">×</Button>
      </div>
      {children}
      {footer}
    </dialog>
  );
}
