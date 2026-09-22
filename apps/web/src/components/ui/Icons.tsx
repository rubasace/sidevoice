type IconProps = { className?: string; size?: number };

export function ConversationsIcon({ className, size = 16 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" /><path d="M20 9h1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1v3l-3-3h-4" /></svg>;
}

export function MachinesIcon({ className, size = 16 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M2 19h20" /></svg>;
}

export function ChevronIcon({ className, size = 16 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;
}

export function AppleIcon({ className, size = 12 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true"><path d="M16.4 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.8-.8-3-.8-1.6 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.1 2.8-2.3.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.5-1-2.5-3.7ZM14.1 5.9c.6-.8 1.1-1.9.9-3-.9.1-2 .6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1.1.1 2.1-.5 2.8-1.3Z" /></svg>;
}

export function LinuxIcon({ className, size = 12 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3c-2.5 0-4 2-4 4.5 0 1.5-.5 2.5-1.5 4S5 14.5 5 16.5c0 2.5 2 3.5 3.5 3.5S11 19 12 19s2 1 3.5 1S19 19 19 16.5c0-2-.5-3-1.5-5S16 9 16 7.5C16 5 14.5 3 12 3Z" /><path d="M10 8.5h.01M14 8.5h.01M11 11h2l-1 1.5-1-1.5Z" /></svg>;
}

export function WindowsIcon({ className, size = 12 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true"><path d="M3 5.5 11 4.4v7.1H3V5.5Zm0 13 8 1.1v-7H3v5.9ZM12 4.2 21 3v8.5h-9V4.2Zm0 15.6 9 1.2v-8.5h-9v7.3Z" /></svg>;
}

export function ConnectorIcon({ className, size = 12 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 2v5M15 2v5M6 7h12v3a6 6 0 0 1-12 0V7Z" /><path d="M12 16v6" /></svg>;
}

/** The logo for what a machine said it runs, from the first word of its platform line; a machine we cannot place gets the plain machine. */
export function PlatformIcon({ platform, size = 12 }: { platform: string; size?: number }) {
  const name = platform.toLowerCase();
  if (name.startsWith("macos") || name.startsWith("darwin") || name.startsWith("ios")) return <AppleIcon size={size} />;
  if (name.startsWith("windows") || name.startsWith("win32")) return <WindowsIcon size={size} />;
  if (name.startsWith("linux")) return <LinuxIcon size={size} />;
  return <MachinesIcon size={size} />;
}

export function RefreshIcon({ className, size = 18 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" /></svg>;
}

export function CopyIcon({ className, size = 18 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>;
}

export function SettingsIcon({ className, size = 22 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true"><path d="m9 3 1-2h4l1 2 2 1h2l2 3-1 2v3l1 2-2 3h-2l-2 1-1 3h-4l-1-3-2-1H5l-2-3 1-2V9L3 7l2-3h2z" transform="translate(1 1) scale(.9)"/><circle cx="12" cy="12" r="3"/></svg>;
}

export function MicrophoneIcon({ className, size = 24 }: IconProps) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/><path className="mic-slash" d="M2 2l20 20"/></svg>;
}

export function SpeakerIcon({ size = 24 }: IconProps) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M11 4 5 9H2v6h3l6 5zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/></svg>;
}

export function HangupIcon({ size = 30 }: IconProps) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 15v-4c4-4 12-4 16 0v4l-5-1v-3a12 12 0 0 0-6 0v3z"/></svg>;
}
