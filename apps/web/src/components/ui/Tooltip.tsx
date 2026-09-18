import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { createContext, useContext, type PropsWithChildren, type ReactElement, type ReactNode } from "react";

const OverlayPortalContext = createContext<HTMLElement | null>(null);

export const TooltipProvider = TooltipPrimitive.Provider;

export function OverlayPortalProvider({ container, children }: PropsWithChildren<{ container: HTMLElement | null }>) {
  return <OverlayPortalContext.Provider value={container}>{children}</OverlayPortalContext.Provider>;
}

export function useOverlayPortal() {
  return useContext(OverlayPortalContext);
}

interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
}

export function Tooltip({ content, children }: TooltipProps) {
  const container = useOverlayPortal();
  if (!content) return children;
  return (
    <TooltipPrimitive.Root delayDuration={350}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal container={container ?? undefined}>
        <TooltipPrimitive.Content className="ui-tooltip" sideOffset={8} collisionPadding={12}>
          {content}
          <TooltipPrimitive.Arrow className="ui-tooltip-arrow" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
