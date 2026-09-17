// Liquidaciones 2 — la pantalla del motorizado (MOM §30.9). Parte pura,
// testeada en test/sheets-rider-cuaderno.test.ts.
//
// El motorizado escribe en SU hoja de Reparto propio las mismas filas que el
// coordinador ve en Liquidaciones 2: fecha#pedido, estado escrito, cobrado y
// método. Lo que cambia respecto a importar un cuaderno de papel es que aquí
// la diferencia de monto se explica en el momento: si cobró distinto a lo que
// dice Kapta, el motivo es obligatorio y abre la observación que después
// alguien lee y acepta antes de aplicar al Master.

import { REPARTO_PAYMENT_METHODS } from "./templates";
import { applyWrittenPayment, applyWrittenStatus } from "./written-status";
import { normalizeOrderCode, puntoRowKey } from "./reparto-import";
import type { StatusLookup } from "./statuses";
import type { CellValue, StatusEffect } from "./types";

/** Diferencia mínima para considerar que un monto no cuadra (S/). */
export const MONTO_TOLERANCE = 0.5;

export const DIGITAL_METHODS: ReadonlySet<string> = new Set([
  "Yape Grupo GF",
  "Yape/Plin Frankz",
  "Yape/Plin Gabriela",
  "Link de pago",
  "Transferencia",
]);

export function isDigitalMethod(method: string | null | undefined): boolean {
  return Boolean(method && DIGITAL_METHODS.has(method));
}

export function montoDiffers(aCobrar: number | null, kaptaTotal: number | null): boolean {
  if (aCobrar === null || kaptaTotal === null) return false;
  return Math.abs(aCobrar - kaptaTotal) > MONTO_TOLERANCE;
}

/**
 * ¿Hace falta motivo? Solo cuando la fila está vinculada a un pedido de Kapta,
 * el estado tiene efecto entrega y lo cobrado difiere del total. Un intento
 * fallido no cobra, así que no explica nada.
 */
export function needsReason(input: {
  aCobrar: number | null;
  kaptaTotal: number | null;
  effect: StatusEffect | null;
}): boolean {
  return input.effect === "entrega" && montoDiffers(input.aCobrar, input.kaptaTotal);
}

/** «Punto 01», «Punto 02»… siguiendo el mayor correlativo del día. */
export function nextPuntoLabel(existing: readonly (string | null | undefined)[]): string {
  let max = 0;
  for (const p of existing) {
    const m = /(\d+)\s*$/.exec(String(p ?? ""));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Punto ${String(max + 1).padStart(2, "0")}`;
}

/** Orden de los puntos del día: por su número, los sin número al final. */
export function puntoOrder(label: string | null | undefined): number {
  const m = /(\d+)\s*$/.exec(String(label ?? ""));
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

export interface RiderPointInput {
  estado: string | null;
  efectivo: number | null;
  a_cobrar: number | null;
  metodo_pago: string | null;
  observacion_1: string | null;
  comprobante_path?: string | null;
}

/**
 * Las celdas que cambian al guardar lo que tecleó el motorizado. Estado y
 * método se guardan literales y se traducen con las mismas funciones que la
 * importación; el método viene de una lista cerrada en esta pantalla, así que
 * `metodo_pago` siempre resuelve.
 */
export function buildRiderPointChanges(
  current: Record<string, CellValue>,
  input: RiderPointInput,
  lookup: StatusLookup,
): { changes: Record<string, CellValue>; unknownAlias: string | null } {
  const status = applyWrittenStatus(current, input.estado, lookup);
  const payment = applyWrittenPayment(input.metodo_pago);
  const changes: Record<string, CellValue> = {
    ...status.changes,
    ...payment,
    efectivo: input.efectivo,
    a_cobrar: input.a_cobrar,
    observacion_1: input.observacion_1?.trim() || null,
  };
  if (input.comprobante_path !== undefined) changes.comprobante_path = input.comprobante_path;
  return { changes, unknownAlias: status.unknownAlias };
}

/** Solo lo que realmente cambia respecto a lo guardado, para el historial. */
export function diffChanges(
  current: Record<string, CellValue>,
  changes: Record<string, CellValue>,
): Record<string, { previous: CellValue; next: CellValue }> {
  const out: Record<string, { previous: CellValue; next: CellValue }> = {};
  for (const [key, next] of Object.entries(changes)) {
    const previous = current[key] ?? null;
    if (previous !== next) out[key] = { previous, next };
  }
  return out;
}

export interface NewPointInput {
  fecha: string;
  pedido: string | null;
  cliente: string | null;
  tienda: string | null;
  a_cobrar: number | null;
  existingPuntos: readonly (string | null | undefined)[];
  existingKeys: ReadonlySet<string>;
}

/** Fila nueva del cuaderno: clave fecha#pedido y correlativo del día. */
export function buildNewPoint(input: NewPointInput): { row_key: string; values: Record<string, CellValue>; pedido_shopify: boolean } {
  const pedido = normalizeOrderCode(input.pedido);
  const raw = (input.pedido ?? "").trim();
  const base = puntoRowKey(input.fecha, pedido ?? (raw ? raw.toLowerCase() : null), input.cliente, input.existingKeys.size + 1);
  let key = base;
  let n = 2;
  while (input.existingKeys.has(key)) key = `${base}#${n++}`;
  return {
    row_key: key,
    pedido_shopify: Boolean(pedido),
    values: {
      fecha: input.fecha,
      punto: nextPuntoLabel(input.existingPuntos),
      tienda: input.tienda,
      cliente: input.cliente?.trim() || null,
      pedido: pedido ?? (raw || null),
      estado: null,
      estado_reportado: null,
      reprogramar_para: null,
      efectivo: null,
      a_cobrar: input.a_cobrar,
      metodo_pago: null,
      metodo_pago_reportado: null,
      observacion_1: null,
      observacion_2: null,
      revision: pedido || !raw ? null : "pedido_no_shopify",
    },
  };
}

export const PAYMENT_OPTIONS = REPARTO_PAYMENT_METHODS;
