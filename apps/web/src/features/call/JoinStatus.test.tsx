import { expect, test } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { JoinStatus } from "./JoinStatus";
import { createRoomStore, installRoomBridge, RoomStoreContext } from "../../state/room-store";
import type { JoinStatusView } from "../../state/room-types";

function renderJoin(join: JoinStatusView | null) {
  const store = createRoomStore();
  store.setState({ join });
  installRoomBridge(store);
  render(
    <RoomStoreContext.Provider value={store}>
      <JoinStatus />
    </RoomStoreContext.Provider>,
  );
  return store;
}

test("no join, no line", () => {
  renderJoin(null);
  expect(document.getElementById("join-status")).not.toBeVisible();
});

test("a step is one quiet line, and a failure takes its place as an alert", () => {
  renderJoin({ step: "voice", text: "Cargando el modelo de voz (42 %)", progress: 42, failed: false });
  expect(screen.getByRole("status")).toHaveTextContent("Cargando el modelo de voz (42 %)");
  expect(document.getElementById("join-status")?.dataset.state).toBe("busy");

  act(() => {
    window.sidevoiceUI?.setJoinStatus?.({ step: "failed", text: "El micrófono está bloqueado para esta página.", progress: null, failed: true });
  });
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent("El micrófono está bloqueado para esta página.");
  expect(document.getElementById("join-status")?.dataset.state).toBe("failed");
});

test("the line goes away once the call is up", () => {
  const store = renderJoin({ step: "room", text: "Entrando en la sala", progress: null, failed: false });
  act(() => store.setState({ join: null }));
  expect(document.getElementById("join-status")).not.toBeVisible();
});
