import { useEffect, useRef, useState } from "react";

/* The bubble of the turn being recorded is the microphone itself: a canvas that pulls the meter's analyser
 * once per animation frame and paints its own pixels. React renders this element once per phase, never per
 * frame, and the runtime keeps owning the audio graph (docs/FRONTEND.md). */

const COLUMN_MS = 55; // one column of history per ~55 ms, so the scroll follows time and not the frame rate
const CELL = 5; // column pitch in CSS pixels
const BAR = 3;
const FLOOR = 2; // a silent column is still a line, never a gap

export type WaveformPhase = "listening" | "transcribing";

const LABELS: Record<WaveformPhase, { aria: string; title: string }> = {
  listening: { aria: "Escuchando", title: "Escuchando…" },
  transcribing: { aria: "Transcribiendo tu intervención", title: "Transcribiendo…" },
};

/** The same 60 dB window the call meter uses (`measureMic`), so bubble and meter agree on how loud this is. */
export function waveColumn(samples: Float32Array): number {
  if (!samples.length) return 0;
  let squares = 0;
  for (const sample of samples) squares += sample * sample;
  const rms = Math.sqrt(squares / samples.length);
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

function motionQuery(): MediaQueryList | null {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => !!motionQuery()?.matches);
  useEffect(() => {
    const query = motionQuery();
    if (!query?.addEventListener) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function VoiceWaveform({ phase }: { phase: WaveformPhase }) {
  const reduced = usePrefersReducedMotion();
  const canvas = useRef<HTMLCanvasElement>(null);
  const columns = useRef<number[]>([]);

  useEffect(() => {
    const node = canvas.current;
    const context = node?.getContext?.("2d");
    if (!node || !context) return;
    let frame = 0;
    let lastColumn = 0;
    let width = 1;
    let height = 1;
    let ink = "currentColor";

    const size = () => {
      const ratio = window.devicePixelRatio || 1;
      const box = node.getBoundingClientRect();
      width = Math.max(1, Math.round(box.width || node.clientWidth || 0));
      height = Math.max(1, Math.round(box.height || node.clientHeight || 0));
      node.width = Math.round(width * ratio);
      node.height = Math.round(height * ratio);
      context.setTransform?.(ratio, 0, 0, ratio, 0, 0);
      ink = window.getComputedStyle?.(node).color || ink;
    };

    // Newest column at the right: the turn scrolls away to the left as a recorder does.
    const paint = () => {
      const capacity = Math.max(1, Math.floor(width / CELL));
      const values = columns.current;
      while (values.length > capacity) values.shift();
      const middle = height / 2;
      const span = Math.max(FLOOR, height - 2);
      context.clearRect(0, 0, width, height);
      context.fillStyle = ink;
      context.beginPath();
      for (let slot = 0; slot < capacity; slot += 1) {
        const value = values[values.length - 1 - slot] ?? 0;
        const bar = Math.max(FLOOR, value * span);
        const x = width - BAR - slot * CELL;
        const y = middle - bar / 2;
        if (context.roundRect) context.roundRect(x, y, BAR, bar, BAR / 2);
        else context.rect(x, y, BAR, bar);
      }
      context.fill();
    };

    const observer = new ResizeObserver(() => { size(); paint(); });
    observer.observe(node);
    size();
    paint();

    // Transcribing keeps the last frame: nothing is read, nothing is scheduled, the pulse is CSS.
    if (reduced || phase !== "listening") return () => observer.disconnect();

    const tick = () => {
      const samples = window.sidevoiceAudio?.readWaveform() ?? null;
      const value = samples ? waveColumn(samples) : 0;
      const values = columns.current;
      const now = performance.now();
      if (!values.length || now - lastColumn >= COLUMN_MS) { values.push(value); lastColumn = now; }
      // Between columns the newest one keeps the loudest instant it covers, so a peak is never skipped.
      else values[values.length - 1] = Math.max(values[values.length - 1], value);
      paint();
      frame = requestAnimationFrame(tick);
    };
    const start = () => { if (!frame && !document.hidden) { lastColumn = performance.now(); frame = requestAnimationFrame(tick); } };
    const stop = () => { if (frame) { cancelAnimationFrame(frame); frame = 0; } };
    const visibility = () => { if (document.hidden) stop(); else start(); };
    document.addEventListener("visibilitychange", visibility);
    start();
    return () => { stop(); observer.disconnect(); document.removeEventListener("visibilitychange", visibility); };
  }, [phase, reduced]);

  const label = LABELS[phase];
  if (reduced) return <span className="voice-bars" data-phase={phase} role="status" aria-label={label.aria} title={label.title}><i /><i /><i /><i /><i /></span>;
  return <span className="voice-wave" data-phase={phase} role="status" aria-label={label.aria} title={label.title}><canvas ref={canvas} aria-hidden="true" /></span>;
}
