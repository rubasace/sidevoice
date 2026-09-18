import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";

interface ModelInfoProps {
  id?: string;
  description?: string;
}

export function ModelInfo({ id, description = "" }: ModelInfoProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [content, setContent] = useState(description);

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
      <Tooltip content={content}>
        <Popover.Trigger asChild>
          <Button ref={buttonRef} id={id} variant="ghost" size="icon" className="model-info" data-tooltip={description || undefined} hidden={!content} aria-label="Descripción del modelo">ⓘ</Button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content className="ui-popover" sideOffset={8} collisionPadding={12}>
          {content}
          <Popover.Arrow className="ui-popover-arrow" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
