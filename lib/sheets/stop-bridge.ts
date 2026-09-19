// Liquidaciones 2 — el puente entre la parada de reparto (`delivery_stops`,
// la verdad) y la fila del cuaderno (`sheet_rows`, la vista con vocabulario).
// Puro y testeado (test/sheets-stop-bridge.test.ts). MOM §29.12 y §30.7.
//
// Dos direcciones:
//   * hoja → parada: `domainStatusToStop` traduce el estado del dominio Reparto
//     propio (con su efecto) al enum de tres estados y al motivo del catálogo
//     de Rutas. El catálogo es más pobre a propósito (se cuenta y se compara);
//     el detalle vive en `written_status` y no se pierde.
//   * parada → hoja: `stopToSheetValues` construye los `values` de una fila de
//     cuaderno a partir de la parada y su pedido. Si la parada trae el estado
//     escrito, manda; si no (paradas reportadas desde la pantalla vieja), se
//     deriva del enum y del motivo.
//
// ASIMETRÍA DOCUMENTADA (MOM §30.3 frente a lib/routes.ts CLOSING_REASONS):
// «rechazado» y «cancelado» se traducen al motivo `rechazado` de Rutas, y
// Rutas SÍ anula el pedido al cerrar la ruta con ese motivo. Desde la hoja,
// «Aplicar al Master» nunca anula: solo entrega. No se resuelve aquí; se deja
// escrito.

import { NON_DELIVERY_REASONS, PAYMENT_METHODS, type PaymentMethod, type StopStatus } from "@/lib/routes";
import { normalizeAlias } from "./statuses";
import type { CellValue, StatusEffect } from "./types";

export interface StopTarget {
  status: StopStatus;
  outcome_reason: string | null;
}

/** Código del dominio → motivo del catálogo de Rutas. Lo que no está aquí
 *  cae por efecto. */
const CODE_TO_REASON: Record<string, string> = {
  no_responde: "no_contesta",
  no_recibe: "no_estaba",
  no_confirmo: "no_estaba",
  en_espera_cliente: "no_estaba",
  dato_errado: "direccion_errada",
  reprogramado: "reprogramado",
  rechazado: "rechazado",
  cancelado: "rechazado",
  retirado: "otro",
  ya_recibio: "otro",
  repetido: "otro",
  devuelto: "otro",
  desarmar: "otro",
};

/** Motivo del catálogo de Rutas → código del dominio (camino inverso). */
const REASON_TO_CODE: Record<string, string> = {
  no_contesta: "no_responde",
  no_estaba: "no_recibe",
  direccion_errada: "dato_errado",
  reprogramado: "reprogramado",
  rechazado: "rechazado",
  sin_dinero: "en_espera_cliente",
};

const KNOWN_REASONS = new Set(NON_DELIVERY_REASONS.map((r) => r.code));

/**
 * Traduce el estado del dominio a lo que la parada puede guardar. Devuelve
 * null cuando no hay estado resuelto (alias sin equivalente): la parada no se
 * toca y la fila queda a revisión.
 */
export function domainStatusToStop(code: string | null, effect: StatusEffect | null): StopTarget | null {
  if (!code || !effect) return null;
  if (effect === "entrega") return { status: "entregado", outcome_reason: null };
  if (effect === "sin_salida" || code === "en_ruta") return { status: "pendiente", outcome_reason: null };
  const reason = CODE_TO_REASON[code] ?? "otro";
  return { status: "no_entregado", outcome_reason: KNOWN_REASONS.has(reason) ? reason : "otro" };
}

/** Método de la parada → método de la lista cerrada del cuaderno. */
export function stopPaymentToSheet(method: PaymentMethod | string | null | undefined): string | null {
  switch (method) {
    case "efectivo":
      return "Efectivo";
    case "yape":
      return "Yape Grupo GF";
    case "pos":
      return "Izipay";
    case "sin_cobro":
      return "Sin cobro";
    default:
      return null;
  }
}

/** Método del cuaderno → método de la parada. Null si no hay equivalente. */
export function sheetPaymentToStop(method: string | null | undefined): PaymentMethod | null {
  switch (method) {
    case "Efectivo":
      return "efectivo";
    case "Yape Grupo GF":
    case "Yape/Plin Frankz":
    case "Yape/Plin Gabriela":
    case "Transferencia":
    case "Link de pago":
    case "Pagado antes":
      return "yape";
    case "Izipay":
      return "pos";
    case "Sin cobro":
      return "sin_cobro";
    default:
      return null;
  }
}

export interface BridgeStop {
  id: string;
  status: StopStatus | string;
  outcome_reason: string | null;
  payment_method: string | null;
  collected_amount: number | string | null;
  note: string | null;
  voucher_path: string | null;
  written_status?: string | null;
  written_status_code?: string | null;
  written_payment?: string | null;
}

export interface BridgeOrder {
  order_name: string | null;
  customer_name: string | null;
  order_total: number | null;
  store_name: string | null;
}

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function storeLabel(storeName: string | null | undefined): string | null {
  const s = (storeName ?? "").toLowerCase();
  if (!s) return null;
  if (s.startsWith("aur")) return "Aurela";
  if (s.startsWith("kenk")) return "Kenku";
  if (s.startsWith("kast")) return "Kast";
  return "Otra";
}

/**
 * Los `values` de la fila de cuaderno que representa esta parada. El estado
 * escrito manda cuando existe; si no, se deriva del enum y del motivo, y el
 * literal que se muestra es la etiqueta del catálogo de Rutas.
 */
export function stopToSheetValues(
  stop: BridgeStop,
  order: BridgeOrder | null,
  meta: { fecha: string; punto: string },
): Record<string, CellValue> {
  const derivedCode =
    stop.status === "entregado"
      ? "entregado"
      : stop.status === "no_entregado"
        ? (REASON_TO_CODE[stop.outcome_reason ?? ""] ?? null)
        : null;
  const estado = stop.written_status_code ?? derivedCode;
  const reasonLabel = NON_DELIVERY_REASONS.find((r) => r.code === stop.outcome_reason)?.label ?? null;
  const estadoReportado =
    stop.written_status ??
    (stop.status === "entregado" ? "ENTREGADO" : stop.status === "no_entregado" ? (reasonLabel ?? "NO ENTREGADO") : null);
  const collected = num(stop.collected_amount);
  const metodo = stopPaymentToSheet(stop.payment_method);
  const metodoLabel = PAYMENT_METHODS.find((m) => m.code === stop.payment_method)?.label ?? null;
  const review: string[] = [];
  if (stop.status !== "pendiente" && !estado) review.push("estado_sin_equivalente");
  return {
    fecha: meta.fecha,
    punto: meta.punto,
    tienda: storeLabel(order?.store_name),
    cliente: order?.customer_name ?? null,
    pedido: order?.order_name ?? null,
    estado,
    estado_reportado: estadoReportado,
    reprogramar_para: null,
    efectivo: stop.payment_method === "efectivo" ? collected : null,
    a_cobrar: stop.status === "entregado" ? (collected ?? order?.order_total ?? null) : (order?.order_total ?? null),
    metodo_pago: stop.status === "entregado" ? metodo : null,
    metodo_pago_reportado: stop.written_payment ?? (stop.status === "entregado" ? metodoLabel : null),
    observacion_1: stop.note ?? null,
    observacion_2: null,
    comprobante_path: stop.voucher_path ?? null,
    revision: review.length ? review.join(", ") : null,
  };
}

export interface WrittenResolution {
  /** Lo escrito, tal cual. */
  written: string;
  code: string | null;
  effect: StatusEffect | null;
  label: string | null;
  target: StopTarget | null;
}

/**
 * Resuelve lo que el motorizado escribió con el vocabulario de su hoja
 * (alias normalizado → código; código → efecto). Puro: vale en el teléfono
 * para avisar y en el servidor para escribir. Sin equivalente devuelve
 * `code: null` y la parada no se mueve por el texto.
 */
export function resolveWrittenForStop(
  text: string | null | undefined,
  vocabulary: { aliases: Record<string, string>; statuses: readonly { code: string; label: string; effect: StatusEffect }[] },
): WrittenResolution {
  const written = (text ?? "").trim();
  const alias = normalizeAlias(written);
  if (!alias) return { written, code: null, effect: null, label: null, target: null };
  const byCode = vocabulary.statuses.find((s) => s.code === alias.toLowerCase().replace(/\s+/g, "_"));
  const code = byCode?.code ?? vocabulary.aliases[alias] ?? null;
  const status = code ? vocabulary.statuses.find((s) => s.code === code) ?? null : null;
  const effect = status?.effect ?? null;
  return { written, code, effect, label: status?.label ?? null, target: domainStatusToStop(code, effect) };
}
