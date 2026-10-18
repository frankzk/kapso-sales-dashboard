// Auditoría del atraso de Lima (14-10-2026), (G): «Pasar a salida de Urpi
// entregada» solo veía los intentos de los últimos 60 días, y los entregados de
// antes con la caja «por definir» quedaban sin forma de rellenarse.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { olderDeliveredOrderIds, type UrpiAttemptRef } from "@/lib/urpi-results-window";

const flat = (text: string) => text.replace(/\s+/g, " ");
const page = flat(readFileSync(resolve(process.cwd(), "app/dashboard/urpi/page.tsx"), "utf8"));

const attempt = (order_id: string | null, urpi_row: number, result_code: UrpiAttemptRef["result_code"]): UrpiAttemptRef =>
  ({ order_id, urpi_row, result_code });

describe("(G) pedidos de antes de la ventana que pueden tener la salida por rellenar", () => {
  it("los que su último intento es «Entregado»", () => {
    expect(olderDeliveredOrderIds([attempt("a", 10, "reprogramado"), attempt("a", 12, "entregado")], new Set())).toEqual(["a"]);
  });

  it("no si después de la entrega hubo otro intento: el botón decide con el último", () => {
    expect(olderDeliveredOrderIds([attempt("a", 12, "entregado"), attempt("a", 14, "cancelado")], new Set())).toEqual([]);
  });

  it("no los que ya tienen un intento en la ventana: esos ya se ven", () => {
    expect(olderDeliveredOrderIds([attempt("a", 12, "entregado"), attempt("b", 13, "entregado")], new Set(["a"]))).toEqual(["b"]);
  });

  it("no las filas sin pedido", () => {
    expect(olderDeliveredOrderIds([attempt(null, 12, "entregado")], new Set())).toEqual([]);
  });
});

describe("(G) la pantalla de resultados los suma a la ventana", () => {
  it("lee la ventana y, aparte, los entregados de antes con la salida pendiente", () => {
    expect(page).toContain('.gte("report_date", cutoff)');
    expect(page).toContain("const rows = [...windowRows, ...await olderSalidaPendingRows(sb, orgId, cutoff, windowRows)];");
  });

  it("de los viejos lee tres columnas y enteros solo los que tienen la salida pendiente", () => {
    expect(page).toContain('.select("order_id,urpi_row,result_code") .eq("org_id", orgId).lt("report_date", cutoff)');
    expect(page).toContain("olderDeliveredOrderIds(attempts, inWindow)");
    expect(page).toContain('.eq("general_status", "entregado")');
    expect(page).toContain("const pending = [...await salidaPendingIds(sb, entregados)];");
  });

  it("decide la salida pendiente con la misma regla que el botón (planUrpiSalida)", () => {
    expect(page).toContain('planUrpiSalida(salidas.get(id) ?? []).kind === "rellenar"');
    expect(page).toContain("facts.get(id)!.salida_pending = pending.has(id);");
  });
});

describe("(G) la cabecera dice que también enseña los entregados antiguos", () => {
  it("no promete solo «los últimos N días»", () => {
    const board = flat(readFileSync(resolve(process.cwd(), "components/urpi-results-board.tsx"), "utf8"));
    expect(board).toContain(
      "Se muestran los intentos de los últimos {days} días, y los entregados más antiguos cuya salida «Por definir» falta pasar a Urpi.",
    );
  });
});
