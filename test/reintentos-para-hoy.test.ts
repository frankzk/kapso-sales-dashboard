// «Reintentos para hoy» (MOM §29.13, 01-11-2026, decisión del owner): solo la
// tienda llama y decide un reintento en Lima (Repro Lima). Grupo GF ve en su
// cola solo lo que la tienda ya acordó; la caja que el motorizado todavía tiene
// sigue llegando para recibirla en oficina.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { QUEUE_TILE_LABEL, isRetryForToday, type QueueRow } from "@/lib/dispatch-day";

const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

const row = (over: Partial<QueueRow>): QueueRow => ({
  orderId: "o", orderName: "#KP1", storeName: "Kenku Peru", customerName: "C", customerPhone: null, district: "Ate",
  orderTotal: 89, createdAt: null, scheduledFor: "2026-11-01", tariffAmount: 10, taken: false, requestId: null, armed: null,
  observation: null, hasPriorDispatch: true, programmedFor: null, macroStage: "en_curso", macroSubstage: "por_reprogramar_lima",
  assignable: true, route: null, ...over,
});

describe("isRetryForToday", () => {
  it("un reprogramado con su día acordado hoy o ya vencido, en la cola", () => {
    expect(isRetryForToday(row({ programmedFor: "2026-11-01" }), "2026-11-01")).toBe(true);
    expect(isRetryForToday(row({ programmedFor: "2026-10-30" }), "2026-11-01")).toBe(true);
    expect(isRetryForToday(row({ programmedFor: "2026-11-02" }), "2026-11-01")).toBe(false);
    expect(isRetryForToday(row({ programmedFor: null }), "2026-11-01")).toBe(false);
    expect(isRetryForToday(row({ programmedFor: "2026-11-01", assignable: false }), "2026-11-01")).toBe(false);
    expect(isRetryForToday(row({ programmedFor: "2026-11-01", macroStage: "preparacion", macroSubstage: "por_armar" }), "2026-11-01")).toBe(false);
  });

  it("la tarjeta lo dice", () => {
    expect(QUEUE_TILE_LABEL.reintentos_hoy.label).toBe("Reintentos para hoy");
    expect(QUEUE_TILE_LABEL.reintentos_hoy.hint).toContain("Repro Lima");
  });
});

describe("la cola de Grupo GF", () => {
  const src = read("app/dashboard/courier/actions.ts");

  it("sin día acordado, un «Por reprogramar Lima» no entra a la cola ni a «Sin condiciones»", () => {
    expect(src).toContain("return isReprogramStage(order.macro_stage, order.macro_substage) && !programs.has(order.order_id);");
    const returnable = src.indexOf('if (ownBox && own && decision?.action === "recibir_en_oficina") returnable.push(');
    const awaiting = src.indexOf("else if (awaitingStoreAgreement(order, programByOrder)) awaitingRepro += 1;");
    // La caja que el motorizado tiene se recibe antes de preguntar por el acuerdo.
    expect(returnable).toBeGreaterThan(-1);
    expect(awaiting).toBeGreaterThan(returnable);
  });

  it("Despacho del día dice cuántos esperan a la tienda, con enlace a Repro Lima", () => {
    const board = read("components/dispatch-day-board.tsx");
    expect(board).toContain("esperan a la tienda en Repro Lima");
    expect(board).toContain('href="/dashboard/pedidos/repro-lima"');
    expect(read("components/grupo-gf-courier.tsx")).toContain("awaitingRepro={snapshot.operations.awaitingRepro}");
  });

  it("el MOM lo cuenta", () => {
    expect(read("docs/mom/master-pedidos-v1.md")).toContain("**«Reintentos para hoy»: Grupo GF solo ve lo que la tienda ya acordó");
  });
});
