import type { KaraokeRange } from "../../state/room-types";

export function KaraokeText({ text, range, playback = "complete" }: { text: string; range?: KaraokeRange | null; playback?: "pending" | "playing" | "complete" }) {
  const valid = range && Number.isInteger(range.from) && Number.isInteger(range.to) && range.from >= 0 && range.to > range.from && range.to <= text.length;
  if (!valid || !range) return <span className="karaoke-text" data-playback={playback}>{text}</span>;
  return <span className="karaoke-text" data-playback="playing" data-progress="true" aria-live="off" title={range.mode === "word" ? "Siguiendo la voz · palabras" : range.mode === "chunk" ? "Siguiendo la voz · fragmentos" : "Reproduciendo esta respuesta"}><span className="karaoke-played">{text.slice(0, range.from)}</span><mark className="karaoke-current">{text.slice(range.from, range.to)}</mark><span className="karaoke-upcoming">{text.slice(range.to)}</span></span>;
}
