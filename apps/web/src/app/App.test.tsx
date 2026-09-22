import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

vi.mock("../services/room-session-controller.js", () => ({}));

test("renders the room as accessible React components", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "Sidevoice" })).toBeInTheDocument();
  expect(screen.getByRole("log")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Entrar en la sala" })).toBeInTheDocument();
  expect(document.getElementById("language-settings")).toBeInTheDocument();
});
