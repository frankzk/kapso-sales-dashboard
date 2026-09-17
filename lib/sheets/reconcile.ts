// Liquidaciones 2 — qué observaciones de cuadre abrir tras importar o editar
// una hoja cuaderno. Puro y testeado (test/sheets-reconcile.test.ts).
//
// LA REGLA (MOM §30.5). Una fila que declara ENTREGA de un pedido de Kapta se
// contrasta con lo que Kapta sabe, y cada diferencia abre una observación con
// los dos valores. Nadie la resuelve sin motivo; aquí solo se decide QUÉ abrir:
//   * monto: «a cobrar» difiere del total del pedido en más de S/ 0,50.
//   * estado: Kapta tiene el pedido anulado (motivo «anulado_tras_entrega») o
//     devuelto (sin motivo: lo pone quien revise).
//   * pago: cobrado por un medio digital (Yape, Plin, link, transferencia) y
//     Kapta no tiene comprobante validado ni el pedido pagado en Shopify
//     (motivo «pago_sin_comprobante», 0170).
// Nunca dos observaciones abiertas para la misma (fila, campo). Una resuelta
// no bloquea, salvo que el valor externo sea el mismo que ya se resolvió: así
// re-importar el mismo cuaderno no reabre lo que ya se explicó.

import type { CellValue, StatusEffect } from "./types";

export interface ReconcileRow {
  row_id: string;
  row_key: string;
  order_id: string | null;
  values: Record<string, CellValue>;
}

export interface ReconcileOrder {
  order_id: string;
  total_amount: number | null;
  general_status: string;
  cancelled_at: string | null;
  /** Tiene un comprobante validado en Kapta o está `paid` en Shopify. */
  paid?: boolean;
}

/** Métodos del cuaderno que exigen comprobante en Kapta. */
export const DIGITAL_PAYMENT_METHODS: ReadonlySet<string> = new Set([
  "Yape Grupo GF",
  "Yape/Plin Frankz",
  "Yape/Plin Gabriela",
  "Link de pago",
  "Transferencia",
]);

export interface ExistingObservation {
  row_id: string;
  field: string;
  status: "abierta" | "resuelta";
  external_value: string | null;
}

export interface ObservationPlan {
  row_id: string;
  order_id: string;
  field: "monto" | "estado" | "pago";
  external_value: string;
  kapta_value: string;
  difference: number | null;
  reason_code: string | null;
  note: string;
}

export const MONTO_TOLERANCE = 0.5;

const money = (n: number) => n.toFixed(2);

/**
 * Diferencia «a cobrar» − «monto Kapta», redondeada a céntimos, o null si no
 * hay dos números o si están dentro de la tolerancia. La usan el plan de
 * observaciones y la pantalla (celda en ámbar, mini-formulario al editar).
 */
export function amountDifference(aCobrar: unknown, total: unknown): number | null {
  if (typeof aCobrar !== "number" || !Number.isFinite(aCobrar)) return null;
  const t = typeof total === "number" ? total : typeof total === "string" && total.trim() ? Number(total) : NaN;
  if (!Number.isFinite(t)) return null;
  const diff = Math.round((aCobrar - t) * 100) / 100;
  return Math.abs(diff) > MONTO_TOLERANCE ? diff : null;
}

export function planObservations(
  rows: readonly ReconcileRow[],
  orders: ReadonlyMap<string, ReconcileOrder>,
  effects: ReadonlyMap<string, StatusEffect>,
  existing: readonly ExistingObservation[],
  note: string,
): ObservationPlan[] {
  const open = new Set<string>();
  const resolvedValues = new Map<string, Set<string>>();
  for (const e of existing) {
    const key = `${e.row_id}:${e.field}`;
    if (e.status === "abierta") open.add(key);
    else {
      const set = resolvedValues.get(key) ?? new Set<string>();
      if (e.external_value !== null) set.add(e.external_value);
      resolvedValues.set(key, set);
    }
  }
  const blocked = (rowId: string, field: string, external: string) =>
    open.has(`${rowId}:${field}`) || (resolvedValues.get(`${rowId}:${field}`)?.has(external) ?? false);

  const out: ObservationPlan[] = [];
  for (const row of rows) {
    if (!row.order_id) continue;
    const estado = typeof row.values.estado === "string" ? row.values.estado : null;
    if (!estado || effects.get(estado) !== "entrega") continue;
    const order = orders.get(row.order_id);
    if (!order) continue;

    const aCobrar = typeof row.values.a_cobrar === "number" ? row.values.a_cobrar : null;
    const diff = amountDifference(aCobrar, order.total_amount);
    if (aCobrar !== null && diff !== null) {
      const external = money(aCobrar);
      if (!blocked(row.row_id, "monto", external)) {
        out.push({
          row_id: row.row_id,
          order_id: row.order_id,
          field: "monto",
          external_value: external,
          kapta_value: money(Number(order.total_amount)),
          difference: diff,
          reason_code: null,
          note,
        });
      }
    }

    const written = typeof row.values.estado_reportado === "string" && row.values.estado_reportado ? row.values.estado_reportado : estado;
    const external = `entregado (${written})`;
    const cancelled = order.general_status === "anulado" || Boolean(order.cancelled_at);
    if (cancelled) {
      if (!blocked(row.row_id, "estado", external)) {
        out.push({ row_id: row.row_id, order_id: row.order_id, field: "estado", external_value: external, kapta_value: "anulado", difference: null, reason_code: "anulado_tras_entrega", note });
      }
    } else if (order.general_status === "devuelto") {
      if (!blocked(row.row_id, "estado", external)) {
        out.push({ row_id: row.row_id, order_id: row.order_id, field: "estado", external_value: external, kapta_value: "devuelto", difference: null, reason_code: null, note });
      }
    }

    const metodo = typeof row.values.metodo_pago === "string" ? row.values.metodo_pago : null;
    if (metodo && DIGITAL_PAYMENT_METHODS.has(metodo) && order.paid !== true) {
      const externalPago = typeof row.values.metodo_pago_reportado === "string" && row.values.metodo_pago_reportado ? row.values.metodo_pago_reportado : metodo;
      if (!blocked(row.row_id, "pago", externalPago)) {
        out.push({ row_id: row.row_id, order_id: row.order_id, field: "pago", external_value: externalPago, kapta_value: "sin comprobante validado", difference: null, reason_code: "pago_sin_comprobante", note });
      }
    }
  }
  return out;
}

/** Cuenta por campo, para el resumen de importación y el mensaje en pantalla. */
export function countByField(plans: readonly ObservationPlan[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of plans) out[p.field] = (out[p.field] ?? 0) + 1;
  return out;
}
