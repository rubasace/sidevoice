type IconProps = { className?: string; size?: number };

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
