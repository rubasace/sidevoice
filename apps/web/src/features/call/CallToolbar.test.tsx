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

test("the microphones and speakers on offer come from the store, and choosing one is an action", () => {
  const store = toolbar();
  const selectAudioDevice = vi.fn().mockResolvedValue(undefined);
  window.sidevoiceActions = { selectAudioDevice } as unknown as typeof window.sidevoiceActions;
  const input = () => screen.getByLabelText("Micrófono") as HTMLSelectElement;
  expect([...input().options].map((option) => option.textContent)).toEqual(["Predeterminado del sistema"]); // before anything is enumerated
  act(() => {
    store.patch({ audioDevices: { available: true, outputAvailable: false, busy: false, inputId: "mic-1", outputId: "default",
      inputs: [{ id: "default", label: "Predeterminado del sistema" }, { id: "mic-1", label: "Micro del coche" }],
      outputs: [{ id: "default", label: "Predeterminado del sistema" }] } });
  });
  expect([...input().options].map((option) => option.textContent)).toEqual(["Predeterminado del sistema", "Micro del coche"]);
  expect(input().value).toBe("mic-1");
  expect(screen.getByLabelText("Altavoces")).toBeDisabled(); // this browser cannot choose the output
  input().value = "default";
  input().dispatchEvent(new Event("change", { bubbles: true }));
  expect(selectAudioDevice).toHaveBeenCalledWith("input", "default");
});

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
  expect(document.getElementById("screen-note")).toHaveTextContent("No se pudo mantener la pantalla encendida");
  expect(document.getElementById("audio-device-note")).toHaveTextContent("Micrófono seleccionado.");

  mute().click();
  screen.getByRole("button", { name: "Salir de la sala" }).click();
  expect(toggleMic).toHaveBeenCalledTimes(1);
  expect(toggleCall).toHaveBeenCalledTimes(1);
});
