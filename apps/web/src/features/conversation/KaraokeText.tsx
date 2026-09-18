import type { KaraokeRange } from "../../state/room-types";

/* The part already spoken is coloured; the rest waits. No mark on the current word, and the same two spans
 * whether or not playback is running, so a cue never remounts the text. */
export function KaraokeText({ text, range, playback = "complete" }: { text: string; range?: KaraokeRange | null; playback?: "pending" | "playing" | "complete" }) {
  const valid = !!range && Number.isInteger(range.from) && Number.isInteger(range.to) && range.from >= 0 && range.to > range.from && range.to <= text.length;
  const spoken = valid && range ? range.to : 0;
  const title = valid && range ? (range.mode === "word" ? "Siguiendo la voz · palabras" : range.mode === "chunk" ? "Siguiendo la voz · fragmentos" : "Reproduciendo esta respuesta") : undefined;
  return <span className="karaoke-text" data-playback={valid ? "playing" : playback} data-progress={valid ? "true" : undefined} aria-live="off" title={title}><span className="karaoke-played">{text.slice(0, spoken)}</span><span className="karaoke-upcoming">{text.slice(spoken)}</span></span>;
}
