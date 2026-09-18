import { cn } from "../../lib/cn";

interface AvatarProps {
  name: string;
  className?: string;
  decorative?: boolean;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  return (parts.length > 1 ? parts.slice(0, 2).map((part) => part[0]).join("") : parts[0]?.slice(0, 2) || "AI").toUpperCase();
}

export function Avatar({ name, className, decorative = false }: AvatarProps) {
  return <span className={cn("ui-avatar", className)} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : name}>{initials(name)}</span>;
}
