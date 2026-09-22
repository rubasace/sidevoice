import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { MachineList } from "./MachineList";
import { RoomProvider } from "../../app/RoomProvider";
import { createRoomStore } from "../../state/room-store";

vi.mock("../../services/room-session-controller.js", () => ({}));

const paired = (extra: Record<string, unknown> = {}) => ({
  id: "c-1", host: "macbook-pro", platform: "macOS arm64", version: "0.5.0", harnesses: ["claude"],
  created: 1_700_000_000, last_seen: 1_700_086_000, connected: true, revoked: 0, ...extra,
});

function room(machines: Record<string, unknown>[]) {
  const store = createRoomStore();
  render(<RoomProvider store={store}><MachineList /></RoomProvider>);
  act(() => { store.patch({ machines, machinesAt: 1_700_086_400_000 }); });
  return store;
}

test("a machine reads as a machine, and revoking asks first — in the row, never in a browser dialog", async () => {
  const revokeMachine = vi.fn().mockResolvedValue(undefined);
  window.sidevoiceActions = { revokeMachine } as unknown as typeof window.sidevoiceActions;
  room([paired()]);

  const row = document.querySelector(".machine-row")!;
  expect(row.getAttribute("data-state")).toBe("connected");
  expect(row.textContent).toMatch(/macbook-pro/);
  expect(row.textContent).toMatch(/macOS arm64 · 0\.5\.0 · claude/);
  expect(row.textContent).toMatch(/Conectada/);
  expect(row.textContent).toMatch(/Emparejada hace 1 día/);
  expect(row.textContent).not.toMatch(/c-1/);

  // Asking does not revoke; confirming does, and nothing was left to `window.confirm`.
  const confirmSpy = vi.spyOn(window, "confirm");
  await act(async () => { screen.getByRole("button", { name: "Revocar macbook-pro" }).click(); });
  expect(revokeMachine).not.toHaveBeenCalled();
  await act(async () => { screen.getByRole("button", { name: "Sí, revocar" }).click(); });
  expect(revokeMachine).toHaveBeenCalledWith("c-1");
  expect(confirmSpy).not.toHaveBeenCalled();
});

test("a revoked machine stays listed, says so, and is removed by a second action", async () => {
  const revokeMachine = vi.fn().mockResolvedValue(undefined);
  window.sidevoiceActions = { revokeMachine } as unknown as typeof window.sidevoiceActions;
  room([paired({ revoked: 1, connected: true })]);

  const row = document.querySelector(".machine-row")!;
  expect(row.getAttribute("data-state")).toBe("revoked");
  expect(row.textContent).toMatch(/Revocada/);
  expect(row.textContent).not.toMatch(/Conectada/);
  expect(document.getElementById("machines")!.textContent)
    .toMatch(/sigue en la lista hasta que la quitas/);

  await act(async () => { screen.getByRole("button", { name: "Quitar macbook-pro" }).click(); });
  await act(async () => { screen.getByRole("button", { name: "Sí, quitar" }).click(); });
  expect(revokeMachine).toHaveBeenCalledWith("c-1");
});

test("no machine paired yet says so, rather than showing an empty panel", () => {
  room([]);
  expect(document.getElementById("machines")!.textContent).toMatch(/Ninguna máquina emparejada/);
});
