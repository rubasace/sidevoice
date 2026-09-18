import type { ReactNode, SelectHTMLAttributes } from "react";
import { NativeSelect } from "../ui/NativeSelect";
import { ModelInfo } from "./ModelInfo";

interface ModelPickerProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  infoId?: string;
  description?: string;
  children?: ReactNode;
  compact?: boolean;
}

export function ModelPicker({ label, infoId, description, children, compact = false, ...selectProps }: ModelPickerProps) {
  return (
    <label className="ui-field model-field" data-compact={compact || undefined}>
      <span className={compact ? "ui-compact-label" : "ui-field-label"}>{label}</span>
      <span className="model-picker">
        <NativeSelect aria-label={selectProps["aria-label"] || label} {...selectProps}>{children}</NativeSelect>
        <ModelInfo id={infoId} description={description} />
      </span>
    </label>
  );
}
