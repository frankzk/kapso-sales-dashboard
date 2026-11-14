// Repro Lima: el pedido pendiente (nunca falló) cuyo acuerdo ya tiene la salida
// viva del courier acordado dice «Listo» en la fila de atención y no pide
// gestión (owner, 13-11-2026; MOM §9.5). La chapa ya decía «Salida creada»
// (`salida_creada`, test/repro-lima-live-outputs.test.ts), pero la línea de
// abajo seguía pidiendo «confirma con el cliente la fecha y el courier» en
// pedidos con su guía de Aliclik ya creada para el 13/11.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// La hoja importa las acciones de servidor; aquí solo se prueba la línea.
vi.mock("@/app/dashboard/pedidos/repro-lima/actions", () => ({}));

import { FailureLine } from "@/components/repro-lima-panel";
import type { ReproRow } from "@/lib/repro-lima-access";

const pending = (over: Partial<ReproRow>): ReproRow =>
  ({ attentionContext: "pending", failure: null, ...over }) as unknown as ReproRow;
const line = (row: ReproRow) => renderToStaticMarkup(createElement(FailureLine, { row }));

describe("la línea de un pendiente con la salida ya creada", () => {
  it("con la salida del courier acordado: «Listo», sin pedir gestión", () => {
    const html = line(pending({ state: { kind: "salida_creada" }, box: { kind: "con_courier", courier: "aliclik", enOficina: true } }));
    expect(html).toContain("Listo: sale con Aliclik. No requiere gestión salvo que el cliente cambie algo.");
    expect(html).not.toContain("confirma con el cliente");
  });

  it("con la salida de otro courier sigue pidiendo revisar (la chapa dice cuál)", () => {
    const html = line(pending({ state: { kind: "salida_distinta", courier: "fenix" }, box: { kind: "con_courier", courier: "fenix", enOficina: false } }));
    expect(html).toContain("confirma con el cliente la fecha y el courier");
  });

  it("sin salida: la de siempre", () => {
    const html = line(pending({ state: { kind: "por_programar" }, box: { kind: "en_oficina", since: null, courier: "propio" } }));
    expect(html).toContain("Programación y seguimiento de entrega: confirma con el cliente la fecha y el courier.");
  });

  it("el MOM lo registra", () => {
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
    expect(mom).toContain("En la fila de atención de un pendiente que nunca falló, `salida_creada` dice «Listo: sale con Aliclik. No requiere gestión salvo que el cliente cambie algo.»");
  });
});
