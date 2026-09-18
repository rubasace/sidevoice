import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { useOverlayPortal } from "./Tooltip";

interface DropdownMenuProps {
  label: string;
  trigger: ReactNode;
  children: ReactNode;
}

export function DropdownMenu({ label, trigger, children }: DropdownMenuProps) {
  const portalContainer = useOverlayPortal();
  return (
    <DropdownPrimitive.Root>
      <DropdownPrimitive.Trigger asChild aria-label={label}>{trigger}</DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal container={portalContainer ?? undefined}>
        <DropdownPrimitive.Content className="ui-dropdown" sideOffset={8} collisionPadding={12} aria-label={label}>
          {children}
        </DropdownPrimitive.Content>
      </DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
  );
}

export function DropdownMenuItem({ children, danger = false, onSelect }: { children: ReactNode; danger?: boolean; onSelect?: () => void }) {
  return <DropdownPrimitive.Item className="ui-dropdown-item" data-danger={danger || undefined} onSelect={onSelect}>{children}</DropdownPrimitive.Item>;
}
