/* Every mark the room uses, named for what it means here and not for what it is drawn like: a screen is
 * "the machine", a plug is "the connector". Somewhere else is where they are drawn — lucide-react, the
 * standard set for React — and this file is the only place that decides which of its drawings each thing
 * in Sidevoice wears. Swapping the set is a change to this file and to nothing else.
 *
 * The exceptions are below: a product's own mark and the logos of other people's products are not
 * generic icons and are drawn here. */
import {
  AudioLines, Captions, ChevronDown, Copy, Cpu, Ear, Keyboard, MessagesSquare, Mic, Monitor, MoreHorizontal,
  Phone, PhoneOff, Play, Plug, RefreshCw, Settings, SkipForward, SlidersHorizontal, Speech, Volume2, Wrench, X,
} from "lucide-react";
import type { ComponentType } from "react";

type IconProps = { className?: string; size?: number };
type LucideLike = ComponentType<{ className?: string; size?: number; strokeWidth?: number; "aria-hidden"?: boolean }>;

/** One drawing, wearing the room's stroke and hidden from anything that reads the page aloud. */
function mark(Drawing: LucideLike, fallbackSize: number) {
  return function Mark({ className, size = fallbackSize }: IconProps) {
    return <Drawing className={className} size={size} strokeWidth={1.8} aria-hidden />;
  };
}

// ----- the room
export const ConversationsIcon = mark(MessagesSquare, 16);
export const MachinesIcon = mark(Monitor, 16);
export const ConnectorIcon = mark(Plug, 12);
export const ChevronIcon = mark(ChevronDown, 16);
export const MoreIcon = mark(MoreHorizontal, 18);
export const CloseIcon = mark(X, 18);
export const CopyIcon = mark(Copy, 18);
export const RefreshIcon = mark(RefreshCw, 18);
export const SettingsIcon = mark(Settings, 22);

// ----- the call
export const MicrophoneIcon = mark(Mic, 24);
export const SpeakerIcon = mark(Volume2, 20);
export const CallIcon = mark(Phone, 22);
export const HangupIcon = mark(PhoneOff, 22);
export const SkipIcon = mark(SkipForward, 22);
export const ListenAgainIcon = mark(Play, 14);
export const KeyboardIcon = mark(Keyboard, 20);

// ----- what answers, when a row names it
export const ModelsIcon = mark(Cpu, 16);
export const ListensIcon = mark(Ear, 12);
export const SpeaksIcon = mark(AudioLines, 12);

// ----- the settings, one mark per section
export const GeneralIcon = mark(SlidersHorizontal, 16);
export const VoicesIcon = mark(Speech, 16);
export const TranscriptionIcon = mark(Captions, 16);
export const AdvancedIcon = mark(Wrench, 16);

/* Drawn here, because they are somebody's mark and not a generic icon. */
export function AppleIcon({ className, size = 12 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true"><path d="M16.4 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.8-.8-3-.8-1.6 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.1 2.8-2.3.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.5-1-2.5-3.7ZM14.1 5.9c.6-.8 1.1-1.9.9-3-.9.1-2 .6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1.1.1 2.1-.5 2.8-1.3Z" /></svg>;
}

export function LinuxIcon({ className, size = 12 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3c-2.5 0-4 2-4 4.5 0 1.5-.5 2.5-1.5 4S5 14.5 5 16.5c0 2.5 2 3.5 3.5 3.5S11 19 12 19s2 1 3.5 1S19 19 19 16.5c0-2-.5-3-1.5-5S16 9 16 7.5C16 5 14.5 3 12 3Z" /><path d="M10 8.5h.01M14 8.5h.01M11 11h2l-1 1.5-1-1.5Z" /></svg>;
}

export function WindowsIcon({ className, size = 12 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true"><path d="M3 5.5 11 4.4v7.1H3V5.5Zm0 13 8 1.1v-7H3v5.9ZM12 4.2 21 3v8.5h-9V4.2Zm0 15.6 9 1.2v-8.5h-9v7.3Z" /></svg>;
}

export function ClaudeIcon({ className, size = 12 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true"><path d="M11 2h2v6.2l3.9-4.8 1.5 1.3-3.9 4.8 5.9-1.9.6 1.9-5.9 1.9 5.9 1.9-.6 1.9-5.9-1.9 3.9 4.8-1.5 1.3-3.9-4.8V22h-2v-6.2l-3.9 4.8-1.5-1.3 3.9-4.8-5.9 1.9-.6-1.9L9.4 12 3.5 10.1l.6-1.9 5.9 1.9-3.9-4.8 1.5-1.3L11 8.2V2Z" /></svg>;
}

export function CodexIcon({ className, size = 12 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m8 9 3 3-3 3M13 15h3" /></svg>;
}

export function SidevoiceMark({ className, size = 22 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true"><rect x="1" y="9.5" width="2.4" height="5" rx="1.2" /><rect x="5.4" y="6" width="2.4" height="12" rx="1.2" /><rect x="9.8" y="2" width="2.4" height="20" rx="1.2" /><rect x="14.2" y="6" width="2.4" height="12" rx="1.2" /><rect x="18.6" y="9.5" width="2.4" height="5" rx="1.2" /></svg>;
}

/** The logo for what a machine said it runs, from the first word of its platform line; a machine we
 *  cannot place gets the plain machine. */
export function PlatformIcon({ platform, size = 12 }: { platform: string; size?: number }) {
  const name = platform.toLowerCase();
  if (name.startsWith("macos") || name.startsWith("darwin") || name.startsWith("ios")) return <AppleIcon size={size} />;
  if (name.startsWith("windows") || name.startsWith("win32")) return <WindowsIcon size={size} />;
  if (name.startsWith("linux")) return <LinuxIcon size={size} />;
  return <MachinesIcon size={size} />;
}

export const HARNESS_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

export function HarnessIcon({ harness, size = 12 }: { harness: string; size?: number }) {
  if (harness === "claude") return <ClaudeIcon size={size} />;
  if (harness === "codex") return <CodexIcon size={size} />;
  return null;
}
