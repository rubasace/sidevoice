import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { ModelInfo } from "./ModelInfo";

interface ModelCardProps {
  label: string;
  provider: string;
  description?: string;
  badges?: string[];
  selected?: boolean;
  onSelect?: () => void;
}

export function ModelCard({ label, provider, description, badges = [], selected = false, onSelect }: ModelCardProps) {
  return (
    <div className={cn("model-card", selected && "model-card--selected")}>
      <Button variant="ghost" className="model-card-main" role="radio" aria-checked={selected} onClick={onSelect}>
        <span className="model-card-name">{label}</span>
        <span className="model-card-provider">{provider}</span>
        {!!badges.length && <span className="model-card-badges">{badges.map((badge) => <span className="ui-badge" key={badge}>{badge}</span>)}</span>}
      </Button>
      <ModelInfo description={description} />
    </div>
  );
}
