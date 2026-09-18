import type { KaraokeRange } from "../../state/room-types";

export function KaraokeText({ text, range }: { text: string; range?: KaraokeRange | null }) {
  const valid = range && Number.isInteger(range.from) && Number.isInteger(range.to) && range.from >= 0 && range.to > range.from && range.to <= text.length;
  if (!valid || !range) return <span className="karaoke-text">{text}</span>;
  return <span className="karaoke-text" aria-live="off" title={range.mode === "word" ? "Siguiendo la voz · palabras" : range.mode === "chunk" ? "Siguiendo la voz · fragmentos" : "Reproduciendo esta respuesta"}>{text.slice(0, range.from)}<mark className="karaoke-current">{text.slice(range.from, range.to)}</mark>{text.slice(range.to)}</span>;
}
