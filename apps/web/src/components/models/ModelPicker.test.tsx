import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { TooltipProvider } from "../ui/Tooltip";
import { ModelPicker } from "./ModelPicker";

test("keeps model labels concise and exposes the optional description separately", () => {
  render(<TooltipProvider><ModelPicker label="Modelo" description="Rápido y barato"><option value="flash">Eleven Flash</option></ModelPicker></TooltipProvider>);
  expect(screen.getByRole("option").textContent).toBe("Eleven Flash");
  const info = screen.getByRole("button", { name: "Descripción del modelo" });
  expect(info).toHaveAttribute("data-tooltip", "Rápido y barato");
  expect(info).not.toHaveAttribute("hidden");
});

test("does not render an information control without a description", () => {
  render(<TooltipProvider><ModelPicker label="Modelo"><option value="local">Local</option></ModelPicker></TooltipProvider>);
  expect(screen.queryByRole("button", { name: "Descripción del modelo" })).not.toBeInTheDocument();
});
