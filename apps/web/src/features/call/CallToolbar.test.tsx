import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { CallToolbar } from "./CallToolbar";
import { RoomProvider } from "../../app/RoomProvider";
import { createRoomStore } from "../../state/room-store";

vi.mock("../../services/room-session-controller.js", () => ({}));

function toolbar() {
  const store = createRoomStore();
  render(<RoomProvider store={store}><CallToolbar /></RoomProvider>);
  return store;
}

test("the call bar says what the session facts say, and asks the runtime to act", async () => {
  const store = toolbar();
  const toggleMic = vi.fn();
  const toggleCall = vi.fn().mockResolvedValue(undefined);
  window.sidevoiceActions = { toggleMic, toggleCall } as unknown as typeof window.sidevoiceActions;

  const mute = () => screen.getByRole("button", { name: /micrófono$/i });
  expect(mute()).not.toBeDisabled(); // the preference is set before joining too
  expect(screen.getByRole("button", { name: "Entrar en la sala" })).toBeInTheDocument();

  act(() => { store.patch({ ws: {}, micEnabled: false }); });
  expect(mute()).toHaveAttribute("aria-label", "Activar micrófono");
  expect(mute()).toHaveAttribute("aria-pressed", "true");
  expect(document.getElementById("mic-control")).toHaveAttribute("data-muted", "true");
  expect(screen.getByRole("button", { name: "Salir de la sala" })).toHaveClass("joined");

  act(() => { store.patch({ screenLock: { state: "off", note: "No se pudo mantener la pantalla encendida" }, deviceNote: "Micrófono seleccionado." }); });
  expect(document.getElementById("screen-lock")).toHaveAttribute("data-state", "off");
  expect(document.getElementById("screen-note")).toHaveTextContent("No se pudo mantener la pantalla encendida");
  expect(document.getElementById("audio-device-note")).toHaveTextContent("Micrófono seleccionado.");

  act(() => { store.patch({ stream: {}, echoFacts: { aec: false } }); });
  expect(document.getElementById("echo-cover")).not.toHaveAttribute("hidden");
  expect(document.getElementById("echo-note")?.textContent).toMatch(/cancelación de eco/i);

  mute().click();
  screen.getByRole("button", { name: "Salir de la sala" }).click();
  expect(toggleMic).toHaveBeenCalledTimes(1);
  expect(toggleCall).toHaveBeenCalledTimes(1);
});
