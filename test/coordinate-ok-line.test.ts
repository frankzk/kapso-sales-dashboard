import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/dashboard/pedidos/actions", () => ({ clearOrderDispatchDate: vi.fn(), scheduleOrderDispatch: vi.fn() }));

const { CoordinateOkLine } = await import("@/components/dispatch-date-panel");

describe("Provincia COD con coordenada: programar lo dice (02-11-2026, #KP201412)", () => {
  it("«ya tiene coordenada» con el punto en el mapa", () => {
    const html = renderToStaticMarkup(createElement(CoordinateOkLine, { latitude: -17.6552649, longitude: -71.3152498 }));
    expect(html).toContain("ya tiene coordenada");
    expect(html).toContain('href="https://www.google.com/maps?q=-17.6552649,-71.3152498"');
    expect(html).toContain("Ver en el mapa");
  });

  it("sale bajo «Sale el» al confirmar y en «Programar envío», solo si no falta", () => {
    const drawer = readFileSync(resolve(process.cwd(), "components/order-drawer.tsx"), "utf8");
    expect(drawer).toMatch(/!coordinateMissing && classifyOperation\(row\) === "provincia_cod" && savedCoordinate\(row\) && \(\s*<CoordinateOkLine/);
    expect(drawer).toContain("coordinate={savedCoordinate(detail.row)}");
    const panel = readFileSync(resolve(process.cwd(), "components/dispatch-date-panel.tsx"), "utf8");
    expect(panel).toContain("{!coordinateMissing && autoAliclik && savedCoordinate && (");
  });
});
