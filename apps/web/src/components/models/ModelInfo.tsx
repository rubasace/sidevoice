import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { useOverlayPortal } from "../ui/Tooltip";

interface InfoPopoverProps {
  id?: string;
  description?: string;
  label?: string;
}

export function InfoPopover({ id, description = "", label = "Más información" }: InfoPopoverProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [content, setContent] = useState(description);
  const portalContainer = useOverlayPortal();

  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    const sync = () => setContent(button.dataset.tooltip || description);
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(button, { attributes: true, attributeFilter: ["data-tooltip"] });
    return () => observer.disconnect();
  }, [description]);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button ref={buttonRef} id={id} variant="ghost" size="icon" className="model-info" data-tooltip={description || undefined} hidden={!content} aria-label={label}>ⓘ</Button>
      </Popover.Trigger>
      <Popover.Portal container={portalContainer ?? undefined}>
        <Popover.Content className="ui-popover" sideOffset={8} collisionPadding={12}>
          {content}
          <Popover.Arrow className="ui-popover-arrow" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function ModelInfo(props: Omit<InfoPopoverProps, "label">) {
  return <InfoPopover {...props} label="Descripción del modelo" />;
}
