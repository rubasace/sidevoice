import type { PropsWithChildren, ReactNode } from "react";

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
        <button id={closeId} type="button" aria-label={`Cerrar ${title.toLowerCase()}`} title="Cerrar">×</button>
      </div>
      {children}
      {footer}
    </dialog>
  );
}
