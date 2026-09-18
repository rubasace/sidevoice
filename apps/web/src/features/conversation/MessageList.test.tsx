import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage, ConversationView } from "../../state/room-types";
import { MessageList } from "./MessageList";

const base = 1_700_000_000_000;
const message = (overrides: Partial<ChatMessage>): ChatMessage => ({ segment: crypto.randomUUID(), thread: "one", session: "call", role: "assistant", text: "Hola", name: "Agente", time: base, ...overrides });
const view = (messages: ChatMessage[], pendingText = ""): ConversationView => ({ messages, pendingText, pendingCancellable: !!pendingText });

afterEach(() => { delete window.sidevoiceActions; });

test("renders consecutive incoming messages as one WhatsApp-style group with one leading avatar", () => {
  const { container } = render(<MessageList conversation={view([message({ segment: "a" }), message({ segment: "b", text: "Sigo", time: base + 1_000 }), message({ segment: "c", role: "user", name: "Tú", text: "Vale", time: base + 2_000 })])} />);
  expect(container.querySelectorAll(".message-group")).toHaveLength(2);
  expect(container.querySelectorAll('.message-group[data-role="assistant"] .ui-avatar')).toHaveLength(1);
  expect(container.querySelectorAll('.message-group[data-role="assistant"] .chat-avatar-spacer')).toHaveLength(1);
  expect(screen.getAllByText("Agente")).toHaveLength(1);
});

test("keeps a live user draft visible beside a newly queued reply and renders karaoke declaratively", () => {
  const { container } = render(<MessageList conversation={view([message({ segment: "voice", text: "Respuesta activa ahora", playback: "playing", karaoke: { from: 10, to: 16, mode: "word" } })], "Sigo hablando…")} />);
  expect(screen.getByText("Sigo hablando…")).toBeInTheDocument();
  expect(container.querySelector(".karaoke-played")?.textContent).toBe("Respuesta activa");
  expect(container.querySelector("mark")).toBeNull();
  expect(container.querySelector(".karaoke-upcoming")?.textContent).toBe(" ahora");
  expect(screen.getByRole("button", { name: "Cancelar envío" })).toBeInTheDocument();
});

test("marks an assistant message as visually pending before playback starts", () => {
  const { container } = render(<MessageList conversation={view([message({ segment: "voice", text: "Todavía sin reproducir", playback: "pending" })])} />);
  expect(container.querySelector('.karaoke-text')?.getAttribute('data-playback')).toBe('pending');
});

test("keeps the active transcribed draft cancellable after listening text disappears", () => {
  const cancelInput = vi.fn().mockResolvedValue(undefined);
  window.sidevoiceActions = {
    cancelInput,
    selectParticipant: vi.fn(),
    closeParticipant: vi.fn(),
    updateLanguageModel: vi.fn(),
    updateLanguageVoice: vi.fn(),
    updateLanguageSpeed: vi.fn(),
    previewVoice: vi.fn(),
  };
  render(<MessageList conversation={view([message({ segment: "call:user-turn:4", role: "user", name: "Tú", text: "Una frase todavía abierta", draft: true, cancellable: true })])} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancelar envío" }));
  expect(cancelInput).toHaveBeenCalledOnce();
});

test("shows listening bars in the live bubble while a turn is open and no text has arrived", () => {
  const { container } = render(<MessageList conversation={{ messages: [], pendingText: "", pendingCancellable: true, pendingPhase: "transcribing" }} />);
  expect(container.querySelector(".voice-bars")?.getAttribute("data-phase")).toBe("transcribing");
  expect(container.querySelector(".empty")).toBeNull();
});
