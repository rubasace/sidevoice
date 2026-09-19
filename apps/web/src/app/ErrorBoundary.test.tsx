import { expect, test, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

function Broken(): never {
  throw new Error("name.trim is not a function");
}

afterEach(() => {
  delete window.sidevoiceReportError;
  vi.restoreAllMocks();
});

test("a failing panel is contained, reported to the room, and the rest of the page stays", () => {
  const reports: unknown[] = [];
  window.sidevoiceReportError = (report) => reports.push(report);
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(
    <div>
      <div id="live">Puedes entrar</div>
      <ErrorBoundary area="transcript"><Broken /></ErrorBoundary>
    </div>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Esta parte de la sala falló.");
  expect(screen.getByRole("alert")).toHaveTextContent("name.trim is not a function");
  expect(document.getElementById("live")).not.toBeNull();
  expect(reports).toHaveLength(1);
  const report = reports[0] as { kind: string; message: string; component: string };
  expect(report.kind).toBe("render:transcript");
  expect(report.message).toBe("name.trim is not a function");
  expect(report.component).toContain("Broken");
});
