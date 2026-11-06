// La tarjeta de Grupo GF de la mesa de ruta lleva el rótulo de la salida nueva
// (06-11-2026, owner con #KP200684: «¿por qué no estaría dentro de Grupo GF
// Courier?»). Grupo GF no tiene guía propia: imprimir ese rótulo ES preparar su
// salida. Antes vivía solo en «Situación» y «Salidas y guías», y «Ver en Grupo
// GF» llevaba a Despacho del día, donde el pedido no aparecía todavía.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrderRouteDesk } from "@/components/order-route-desk";
import type { OrderRoutePlan, RouteCandidate } from "@/lib/order-route-plan";

const grupoGf: RouteCandidate = {
  key: "propio",
  label: "Grupo GF Courier",
  action: "manual",
  recommended: true,
  availability: "available",
  timing: "Puede salir hoy · corte 12:00",
  reason: "Tarifa S/ 13.00 incluida IGV.",
  requiresAdvance: false,
};

const plan = (gf: RouteCandidate = grupoGf): OrderRoutePlan => ({
  operation: "lima",
  operationLabel: "Lima COD",
  outputCount: 1,
  activeOutputCount: 1,
  maxOutputs: 5,
  warnings: [],
  candidates: [gf],
});

const render = (groupGf: Parameters<typeof OrderRouteDesk>[0]["groupGf"], gf?: RouteCandidate) =>
  renderToStaticMarkup(
    createElement(OrderRouteDesk, { plan: plan(gf), actionEnabled: () => true, onSelect: () => {}, groupGf }),
  );

describe("la tarjeta de Grupo GF", () => {
  it("sin salida nueva, su botón imprime el rótulo y dice qué sigue", () => {
    const html = render({ printNew: { onPrint: () => {}, pending: false } });
    expect(html).toContain("Imprimir rótulo de la salida nueva");
    expect(html).toContain("Primero el rótulo: crea la salida nueva, Almacén la arma desde stock");
    expect(html).not.toContain("Ver en Grupo GF");
    expect(html).toContain("Sugerido");
  });

  it("con la «por definir» ya rotulada, la nombra, deja reimprimir y lleva a Grupo GF", () => {
    const html = render({ ready: { outputCode: "KP200684-S02", labelHref: "/api/pedidos/rotulos?ids=s2" } });
    expect(html).toContain("Salida lista");
    expect(html).toContain("KP200684-S02");
    expect(html).toContain('href="/api/pedidos/rotulos?ids=s2"');
    expect(html).toContain("Reimprimir rótulo");
    expect(html).toContain("Ver en Grupo GF");
    expect(html).not.toContain("Imprimir rótulo de la salida nueva");
  });

  it("sin nada de eso, la tarjeta de siempre", () => {
    const html = render(undefined);
    expect(html).toContain("Ver en Grupo GF");
    expect(html).not.toContain("rótulo");
  });

  it("bloqueada no ofrece imprimir", () => {
    const html = render({ printNew: { onPrint: () => {}, pending: false } }, { ...grupoGf, availability: "blocked", recommended: false });
    expect(html).not.toContain("Imprimir rótulo de la salida nueva");
    expect(html).toContain("No disponible");
  });

  it("la ficha le pasa la misma acción de «Salidas y guías» y la «por definir» con su rótulo", () => {
    const drawer = readFileSync(resolve(process.cwd(), "components/order-drawer.tsx"), "utf8");
    expect(drawer).toContain("printNew: offerNewOutputLabel ? { onPrint: () => void printNewOutputLabel(), pending } : null");
    expect(drawer).toContain("const readyOutput = detail ? pickFillableRouteOutput(detail.guides) : null;");
  });
});
