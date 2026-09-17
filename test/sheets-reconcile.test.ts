// Liquidaciones 2 — observaciones automáticas al importar o editar (MOM §30.5).
import { describe, expect, it } from "vitest";
import { amountDifference, countByField, planObservations, type ExistingObservation, type ReconcileOrder, type ReconcileRow } from "@/lib/sheets/reconcile";
import type { StatusEffect } from "@/lib/sheets/types";

const effects = new Map<string, StatusEffect>([
  ["entregado", "entrega"],
  ["no_responde", "informa"],
  ["desarmar", "devolucion"],
]);
const order = (over: Partial<ReconcileOrder> = {}): ReconcileOrder => ({
  order_id: "o1",
  total_amount: 89,
  general_status: "en_proceso",
  cancelled_at: null,
  ...over,
});
const row = (over: Partial<ReconcileRow> & { values?: ReconcileRow["values"] } = {}): ReconcileRow => ({
  row_id: "r1",
  row_key: "2026-09-15##KP1",
  order_id: "o1",
  values: { estado: "entregado", estado_reportado: "ENTREGADO", a_cobrar: 89 },
  ...over,
});
const NOTE = "Importación 2026-09-16 · Roy";

describe("amountDifference", () => {
  it("devuelve la diferencia firmada solo cuando pasa de 50 céntimos, y null si falta un número", () => {
    expect(amountDifference(99, 89)).toBe(10);
    expect(amountDifference(79, "89.00")).toBe(-10);
    expect(amountDifference(89.4, 89)).toBeNull();
    expect(amountDifference(null, 89)).toBeNull();
    expect(amountDifference(89, null)).toBeNull();
    expect(amountDifference("89", 89)).toBeNull();
  });
});

describe("planObservations", () => {
  it("no abre nada cuando el monto cuadra y el pedido sigue vivo", () => {
    expect(planObservations([row()], new Map([["o1", order()]]), effects, [], NOTE)).toEqual([]);
  });

  it("abre «monto» cuando a cobrar difiere en más de 50 céntimos, con la diferencia firmada", () => {
    const plans = planObservations([row({ values: { estado: "entregado", a_cobrar: 99 } })], new Map([["o1", order()]]), effects, [], NOTE);
    expect(plans).toEqual([
      { row_id: "r1", order_id: "o1", field: "monto", external_value: "99.00", kapta_value: "89.00", difference: 10, reason_code: null, note: NOTE },
    ]);
    const redondeo = planObservations([row({ values: { estado: "entregado", a_cobrar: 89.4 } })], new Map([["o1", order()]]), effects, [], NOTE);
    expect(redondeo).toEqual([]);
  });

  it("abre «estado» con motivo cuando Kapta tiene el pedido anulado, y sin motivo si está devuelto", () => {
    const anulado = planObservations([row()], new Map([["o1", order({ general_status: "anulado" })]]), effects, [], NOTE);
    expect(anulado).toMatchObject([{ field: "estado", external_value: "entregado (ENTREGADO)", kapta_value: "anulado", reason_code: "anulado_tras_entrega" }]);
    const porFecha = planObservations([row()], new Map([["o1", order({ cancelled_at: "2026-09-01T00:00:00Z" })]]), effects, [], NOTE);
    expect(porFecha).toHaveLength(1);
    const devuelto = planObservations([row()], new Map([["o1", order({ general_status: "devuelto" })]]), effects, [], NOTE);
    expect(devuelto).toMatchObject([{ field: "estado", kapta_value: "devuelto", reason_code: null }]);
  });

  it("solo mira filas vinculadas cuyo estado declara entrega", () => {
    const orders = new Map([["o1", order({ general_status: "anulado", total_amount: 10 })]]);
    expect(planObservations([row({ order_id: null })], orders, effects, [], NOTE)).toEqual([]);
    expect(planObservations([row({ values: { estado: "no_responde", a_cobrar: 99 } })], orders, effects, [], NOTE)).toEqual([]);
    expect(planObservations([row({ values: { estado: null, estado_reportado: "COSA RARA", a_cobrar: 99 } })], orders, effects, [], NOTE)).toEqual([]);
    expect(planObservations([row({ values: { estado: "desarmar", a_cobrar: 99 } })], orders, effects, [], NOTE)).toEqual([]);
  });

  it("nunca duplica una observación abierta y no reabre una resuelta con el mismo valor", () => {
    const orders = new Map([["o1", order()]]);
    const rows = [row({ values: { estado: "entregado", a_cobrar: 99 } })];
    const abierta: ExistingObservation[] = [{ row_id: "r1", field: "monto", status: "abierta", external_value: "99.00" }];
    expect(planObservations(rows, orders, effects, abierta, NOTE)).toEqual([]);
    const resueltaIgual: ExistingObservation[] = [{ row_id: "r1", field: "monto", status: "resuelta", external_value: "99.00" }];
    expect(planObservations(rows, orders, effects, resueltaIgual, NOTE)).toEqual([]);
    const resueltaOtroValor: ExistingObservation[] = [{ row_id: "r1", field: "monto", status: "resuelta", external_value: "109.00" }];
    expect(planObservations(rows, orders, effects, resueltaOtroValor, NOTE)).toHaveLength(1);
    // Un «monto» abierto no bloquea un «estado» de la misma fila.
    const conAnulado = new Map([["o1", order({ general_status: "anulado" })]]);
    expect(planObservations(rows, conAnulado, effects, abierta, NOTE).map((p) => p.field)).toEqual(["estado"]);
  });

  it("un cobro digital sin comprobante en Kapta NO abre observación (causa retirada el 17-09-2026)", () => {
    const yape = row({ values: { estado: "entregado", a_cobrar: 89, metodo_pago: "Yape Grupo GF", metodo_pago_reportado: "YAPE GF" } });
    const orders = new Map([["o1", order({ paid: false })]]);
    expect(planObservations([yape], orders, effects, [], NOTE)).toEqual([]);
  });

  it("cuenta por campo para el resumen", () => {
    const plans = planObservations(
      [row({ values: { estado: "entregado", a_cobrar: 99 } })],
      new Map([["o1", order({ general_status: "anulado" })]]),
      effects,
      [],
      NOTE,
    );
    expect(countByField(plans)).toEqual({ monto: 1, estado: 1 });
  });
});
