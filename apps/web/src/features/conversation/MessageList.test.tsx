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
    toggleMic: vi.fn(),
    selectAudioDevice: vi.fn().mockResolvedValue(undefined),
    toggleCall: vi.fn().mockResolvedValue(undefined),
    selectParticipant: vi.fn(),
    closeParticipant: vi.fn(),
    updateLanguageModel: vi.fn(),
    updateLanguageVoice: vi.fn(),
    updateLanguageSpeed: vi.fn(),
    previewVoice: vi.fn(),
    revokeMachine: vi.fn(),
  };
  render(<MessageList conversation={view([message({ segment: "call:user-turn:4", role: "user", name: "Tú", text: "Una frase todavía abierta", draft: true, cancellable: true })])} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancelar envío" }));
  expect(cancelInput).toHaveBeenCalledOnce();
});

test("the open turn is its own waveform bubble, with cancelling on a second line inside it", () => {
  const { container } = render(<MessageList conversation={{ messages: [], pendingText: "", pendingCancellable: true, pendingPhase: "listening" }} />);
  const bubble = container.querySelector('.chat-bubble[data-live="listening"]');
  expect(bubble?.querySelector(".voice-wave canvas")).toBeInTheDocument();
  expect(bubble?.querySelector(".cancel-input")?.textContent).toBe("Cancelar envío");
  expect(bubble?.lastElementChild?.className).toContain("cancel-input");
  expect(container.querySelector(".empty")).toBeNull();
});

test("transcribing keeps one bubble and says so, so both phases stay apart", () => {
  const { container } = render(<MessageList conversation={{ messages: [], pendingText: "", pendingCancellable: true, pendingPhase: "transcribing" }} />);
  expect(container.querySelectorAll(".chat-bubble")).toHaveLength(1);
  expect(container.querySelector(".voice-wave")?.getAttribute("data-phase")).toBe("transcribing");
  expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Transcribiendo tu intervención");
});

test("once the transcript arrives the bubble becomes the text and the waveform goes", () => {
  const { container } = render(<MessageList conversation={{ messages: [], pendingText: "Estoy diciendo esto", pendingCancellable: true, pendingPhase: "listening" }} />);
  expect(container.querySelector(".voice-wave")).toBeNull();
  expect(container.querySelector(".chat-bubble[data-live]")).toBeNull();
  expect(screen.getByText("Estoy diciendo esto")).toBeInTheDocument();
});

test("says under the bubble that a message was captured while there was no connection", () => {
  render(<MessageList conversation={view([
    message({ segment: "call:user-catchup:1", role: "user", name: "Tú", text: "Lo dije mientras se caía la sala", offline: "buffered", offlineNote: "Capturado sin conexión" }),
    message({ segment: "call:user-catchup:2", role: "user", name: "Tú", text: "Y esto se cortó", time: base + 1_000, offline: "truncated", offlineNote: "Capturado sin conexión · solo se guardaron los últimos 30 s" }),
  ])} />);
  expect(screen.getByText("Capturado sin conexión")).toBeInTheDocument();
  expect(screen.getByText("Capturado sin conexión · solo se guardaron los últimos 30 s")).toBeInTheDocument();
});

test("says under the bubble that a reply is being repeated because this browser never heard it", () => {
  render(<MessageList conversation={view([
    message({ segment: "call:voice:u1", role: "assistant", name: "Conversación", text: "Lo último que te dije", replayNote: "Repitiendo lo que no oíste" }),
    message({ segment: "call:voice:u2", role: "assistant", name: "Conversación", text: "Y esto no se pudo", time: base + 1_000, replayNote: "No se pudo repetir · la sala ya no tiene ese audio" }),
  ])} />);
  expect(screen.getByText("Repitiendo lo que no oíste")).toBeInTheDocument();
  expect(screen.getByText("No se pudo repetir · la sala ya no tiene ese audio")).toBeInTheDocument();
});
