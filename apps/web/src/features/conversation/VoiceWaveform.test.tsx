import { render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { VoiceWaveform, waveColumn } from "./VoiceWaveform";

const frames = (count = 3) => new Promise((resolve) => setTimeout(resolve, 20 * count));

function microphone(amplitude: number) {
  const samples = new Float32Array(256).map((_, index) => amplitude * Math.sin(index / 4));
  const readWaveform = vi.fn(() => samples);
  window.sidevoiceAudio = { readWaveform };
  return readWaveform;
}

function reducedMotion(matches: boolean) {
  window.matchMedia = ((media: string) => ({ media, matches, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
}

afterEach(() => {
  delete window.sidevoiceAudio;
  reducedMotion(false);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

test("a louder microphone raises the column and silence keeps it at the floor", () => {
  expect(waveColumn(new Float32Array(64))).toBe(0);
  const quiet = waveColumn(new Float32Array(64).fill(0.002));
  const loud = waveColumn(new Float32Array(64).fill(0.4));
  expect(quiet).toBeLessThan(loud);
  expect(loud).toBeLessThanOrEqual(1);
  expect(waveColumn(new Float32Array(64).fill(1))).toBe(1);
});

test("while listening the bubble pulls the meter's analyser every frame", async () => {
  const readWaveform = microphone(0.3);
  const { container } = render(<VoiceWaveform phase="listening" />);
  expect(container.querySelector(".voice-wave")?.getAttribute("data-phase")).toBe("listening");
  expect(container.querySelector("canvas")).toBeInTheDocument();
  await frames();
  expect(readWaveform.mock.calls.length).toBeGreaterThan(0);
});

test("transcribing freezes the last frame: nothing is read while the turn is being written", async () => {
  const readWaveform = microphone(0.3);
  const { container, rerender } = render(<VoiceWaveform phase="listening" />);
  await frames();
  const reads = readWaveform.mock.calls.length;
  expect(reads).toBeGreaterThan(0);
  rerender(<VoiceWaveform phase="transcribing" />);
  await frames();
  expect(readWaveform.mock.calls.length).toBe(reads);
  expect(container.querySelector(".voice-wave")?.getAttribute("data-phase")).toBe("transcribing");
});

test("a hidden page stops the animation and a visible one resumes it", async () => {
  const readWaveform = microphone(0.3);
  render(<VoiceWaveform phase="listening" />);
  await frames();
  expect(readWaveform.mock.calls.length).toBeGreaterThan(0);
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  document.dispatchEvent(new Event("visibilitychange"));
  await frames();
  const paused = readWaveform.mock.calls.length;
  await frames();
  expect(readWaveform.mock.calls.length).toBe(paused);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  document.dispatchEvent(new Event("visibilitychange"));
  await frames();
  expect(readWaveform.mock.calls.length).toBeGreaterThan(paused);
});

test("a device that asks for less motion gets the bars back and no canvas", async () => {
  const readWaveform = microphone(0.3);
  reducedMotion(true);
  const { container } = render(<VoiceWaveform phase="listening" />);
  expect(container.querySelector("canvas")).toBeNull();
  expect(container.querySelector(".voice-bars")?.getAttribute("data-phase")).toBe("listening");
  await frames();
  expect(readWaveform).not.toHaveBeenCalled();
});

test("a call with no microphone captured draws without reading anything", async () => {
  const { container } = render(<VoiceWaveform phase="listening" />);
  await frames();
  expect(container.querySelector("canvas")).toBeInTheDocument();
});
