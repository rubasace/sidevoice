import { expect, test } from "vitest";
import { createRoomSessionStore, shortModel } from "./room-session-state.js";

test("a model name is said the way a person says it, and one we cannot read is said as it came", () => {
  expect(shortModel("claude-fable-5-1")).toBe("Fable 5.1");
  expect(shortModel("claude-opus-5")).toBe("Opus 5");
  expect(shortModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(shortModel("gpt-5.6-terra")).toBe("GPT-5.6 Terra");
  expect(shortModel("gpt-5-codex")).toBe("GPT-5 Codex");
  // Nothing is guessed at and nothing is cut: a name with no shape we know reads exactly as it came.
  expect(shortModel("mistral-large-latest")).toBe("mistral-large-latest");
  expect(shortModel("")).toBe("");
  expect(shortModel(null)).toBe("");
});

test("what a conversation thinks with reaches the row and the models panel, shortened, and only when a harness said it", () => {
  const store = createRoomSessionStore();
  store.patch({
    roomBinding: { thread_id: "t-1", binding_id: "b-1", title: "Sidevoice" },
    enginePreferences: { stt_provider: "openai", stt_model: "gpt-transcribe", default_model: "kokoro" },
    people: [
      { thread_id: "t-1", title: "Sidevoice", available: true, engine: { model: "claude-fable-5-1", effort: null, thinking: null } },
      { thread_id: "t-2", title: "Astra", available: true, engine: { model: "gpt-5.6-terra" } },
      { thread_id: "t-3", title: "Sin modelo", available: true },
    ],
  });
  const rows = store.getState().participants;
  expect(rows.map((row) => row.model)).toEqual(["Fable 5.1", "GPT-5.6 Terra", null]);
  const thinks = store.getState().enginePanel.find((row) => row.id === "agent")!;
  expect(thinks.label).toBe("Piensa");
  expect(thinks.value).toBe("Fable 5.1");
});

test("no row for what no harness has said", () => {
  const store = createRoomSessionStore();
  store.patch({
    roomBinding: { thread_id: "t-1", binding_id: "b-1", title: "Sidevoice" },
    enginePreferences: { stt_provider: "openai", stt_model: "gpt-transcribe", default_model: "kokoro" },
    people: [{ thread_id: "t-1", title: "Sidevoice", available: true }],
  });
  expect(store.getState().enginePanel.some((row) => row.id === "agent")).toBe(false);
});
