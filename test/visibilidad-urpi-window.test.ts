// Auditoría del atraso de Lima (14-10-2026), (G): «Pasar a salida de Urpi
// entregada» solo veía los intentos de los últimos 60 días, y los entregados de
// antes con la caja «por definir» quedaban sin forma de rellenarse.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { olderDeliveredOrderIds, olderUrpiFollowUp, type UrpiAttemptRef, type UrpiOlderFact } from "@/lib/urpi-results-window";

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

const fact = (order_id: string, general_status: string, cancelled_at: string | null = null): UrpiOlderFact => ({ order_id, general_status, cancelled_at });

describe("entregados de antes de la ventana que Kapta sigue teniendo abiertos (02-11-2026)", () => {
  it("abiertos → por marcar; entregados → a mirar su salida", () => {
    expect(olderUrpiFollowUp([fact("abierto", "en_proceso"), fact("pendiente", "pendiente"), fact("ent", "entregado")]))
      .toEqual({ entregados: ["ent"], abiertos: ["abierto", "pendiente"] });
  });

  it("lo anulado (en Kapta o en Shopify) o devuelto no se carga", () => {
    expect(olderUrpiFollowUp([fact("a", "anulado"), fact("d", "devuelto"), fact("s", "en_proceso", "2026-08-01T00:00:00Z"), fact("se", "entregado", "2026-08-01T00:00:00Z")]))
      .toEqual({ entregados: [], abiertos: [] });
  });
});

describe("(G) la pantalla de resultados los suma a la ventana", () => {
  it("lee la ventana y, aparte, los entregados de antes que todavía piden algo", () => {
    expect(page).toContain('.gte("report_date", cutoff)');
    expect(page).toContain("const rows = [...windowRows, ...await olderFollowUpRows(sb, orgId, cutoff, windowRows)];");
  });

  it("de los viejos lee tres columnas y enteros solo los de salida pendiente o abiertos", () => {
    expect(page).toContain('.select("order_id,urpi_row,result_code") .eq("org_id", orgId).lt("report_date", cutoff)');
    expect(page).toContain("olderDeliveredOrderIds(attempts, inWindow)");
    expect(page).toContain("const { entregados, abiertos } = olderUrpiFollowUp(facts);");
    expect(page).toContain("const pending = [...await salidaPendingIds(sb, entregados), ...abiertos];");
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
      "Se muestran los intentos de los últimos {days} días, y los entregados más antiguos que faltan marcar o cuya salida «Por definir» falta pasar a Urpi.",
    );
  });
});
