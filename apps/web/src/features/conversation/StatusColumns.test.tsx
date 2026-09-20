import { expect, test, vi } from "vitest";
import { render } from "@testing-library/react";
import { act } from "react";
import { TranscriptPanel } from "./TranscriptPanel";
import { RoomProvider } from "../../app/RoomProvider";
import { createRoomStore } from "../../state/room-store";

vi.mock("../../services/room-session-controller.js", () => ({}));

test("the transcript header carries the lights on the left and the models on the right, and no live line", () => {
  const store = createRoomStore();
  render(<RoomProvider store={store}><TranscriptPanel /></RoomProvider>);
  expect(document.getElementById("live")).toBeNull();
  act(() => {
    store.patch({ ws: {}, stream: {}, echoFacts: { aec: false }, screenLock: { state: "on", note: "" },
      roomBinding: { thread_id: "t-1", binding_id: "b-1", title: "Sidevoice" },
      enginePreferences: { stt_provider: "openai", stt_model: "gpt-transcribe", default_model: "eleven_flash_v2_5" },
      people: [{ thread_id: "t-1", title: "Sidevoice", available: true, engine: { model: "claude-opus-5", effort: "high" } }] });
  });
  const lights = document.getElementById("capability-column")!;
  expect(lights.textContent).toMatch(/Eco/);
  expect(lights.textContent).toMatch(/Pantalla/);
  expect(lights.textContent).toMatch(/Audio/);
  expect(lights.textContent).not.toMatch(/Nube/);
  expect(lights.querySelector('.status-line[data-state="fail"] .engine-dot')).not.toBeNull();
  const models = document.getElementById("engine-column")!;
  expect(models.textContent).toMatch(/OpenAI · gpt-transcribe/);
  expect(models.textContent).toMatch(/ElevenLabs/);
  expect(models.textContent).toMatch(/claude-opus-5 · esfuerzo high/);
  expect(models.querySelector(".engine-dot")).toBeNull();
  expect(models.textContent).not.toMatch(/smart-turn/);
});
