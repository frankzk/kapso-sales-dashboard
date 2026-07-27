// Rutas de reparto: reglas de la parada y del cierre del día. Puro + testeado.
//
// La diferencia con lib/settlements.ts es de dirección: allí se RECONSTRUYE lo
// que pasó leyendo una hoja; aquí se DECLARA en el momento, parada por parada.
// El resultado es el mismo tipo de cuadre — por eso cerrar una ruta produce una
// liquidación normal y corriente, con sus mismas reglas.
//
// Dos ideas gobiernan este módulo:
//
//   1. LO QUE REPORTA EL MOTORIZADO ES UNA DECLARACIÓN. Se guarda en la parada,
//      no en el pedido. Que marque "entregado" no cierra nada en el Master: el
//      Master lo mueven los reportes del courier y el equipo, y el cuadre
//      compara ambos. Un motorizado no cierra pedidos por su cuenta.
//
//   2. UNA PARADA REPORTADA SE CORRIGE, NO SE REESCRIBE. Cada reporte deja su
//      rastro (`delivery_stop_events`). Es dinero: hace falta saber quién dijo
//      qué y cuándo.

import { resolveTariff, type CostContext, type CostTariff } from "@/lib/costs";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export type StopStatus = "pendiente" | "entregado" | "no_entregado";
export type PaymentMethod = "efectivo" | "yape" | "pos" | "sin_cobro";

export const PAYMENT_METHODS: { code: PaymentMethod; label: string }[] = [
  { code: "efectivo", label: "Efectivo" },
  { code: "yape", label: "Yape" },
  { code: "pos", label: "POS / tarjeta" },
  { code: "sin_cobro", label: "Sin cobro (ya pagado)" },
];

/** Motivos de no entrega. Cerrados a propósito: un catálogo fijo se puede
 *  contar y comparar entre motorizados; un texto libre, no. El detalle va en
 *  la nota. */
export const NON_DELIVERY_REASONS: { code: string; label: string }[] = [
  { code: "no_contesta", label: "No contesta" },
  { code: "rechazado", label: "Rechazó el pedido" },
  { code: "direccion_errada", label: "Dirección errada" },
  { code: "no_estaba", label: "No estaba / volver luego" },
  { code: "reprogramado", label: "Reprogramado por el cliente" },
  { code: "sin_dinero", label: "No tenía el dinero" },
  { code: "otro", label: "Otro (ver nota)" },
];

export function isPaymentMethod(v: string | null | undefined): v is PaymentMethod {
  return PAYMENT_METHODS.some((m) => m.code === v);
}

export function isNonDeliveryReason(v: string | null | undefined): boolean {
  return NON_DELIVERY_REASONS.some((r) => r.code === v);
}

/** Lo que el motorizado manda al reportar una parada. */
export interface StopReport {
  status: StopStatus;
  paymentMethod: PaymentMethod | null;
  collectedAmount: number | null;
  outcomeReason: string | null;
  note: string | null;
  hasPhoto: boolean;
  hasVoucher: boolean;
}

export interface ReportValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Valida un reporte ANTES de tocar la base. Se exporta puro para que la misma
 * regla valga en el móvil (aviso inmediato) y en el servidor (la que manda).
 *
 * Las reglas nacen de lo que rompe una liquidación:
 *  - una entrega sin método de cobro deja un agujero silencioso en el cuadre;
 *  - una entrega en efectivo o POS sin monto es plata sin declarar;
 *  - una no-entrega con dinero cobrado es una contradicción que hay que mirar;
 *  - un cobro por Yape sin captura no se puede validar después.
 */
export function validateStopReport(report: StopReport): ReportValidation {
  const errors: string[] = [];

  if (report.status === "pendiente") {
    errors.push("Elige si lo entregaste o no.");
    return { ok: false, errors };
  }

  if (report.status === "entregado") {
    if (!isPaymentMethod(report.paymentMethod)) {
      errors.push("Indica cómo cobraste.");
    }
    const needsAmount =
      report.paymentMethod === "efectivo" ||
      report.paymentMethod === "yape" ||
      report.paymentMethod === "pos";
    if (needsAmount && (report.collectedAmount === null || report.collectedAmount <= 0)) {
      errors.push("Escribe cuánto cobraste.");
    }
    if (report.paymentMethod === "yape" && !report.hasVoucher) {
      errors.push("Adjunta la captura del Yape.");
    }
    if (!report.hasPhoto) {
      errors.push("Adjunta la foto de la entrega.");
    }
  }

  if (report.status === "no_entregado") {
    if (!isNonDeliveryReason(report.outcomeReason)) {
      errors.push("Indica por qué no se entregó.");
    }
    if (report.outcomeReason === "otro" && !report.note?.trim()) {
      errors.push("Escribe en la nota qué pasó.");
    }
    if ((report.collectedAmount ?? 0) > 0) {
      errors.push("Marcaste que no se entregó pero declaraste dinero cobrado.");
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Una parada tal como está guardada, para los totales de la ruta. */
export interface RouteStop {
  id: string;
  order_id: string;
  status: StopStatus;
  payment_method: string | null;
  collected_amount: number | null;
}

export interface RouteTotals {
  total: number;
  pendientes: number;
  entregados: number;
  noEntregados: number;
  /** Cobrado por método, para saber cuánto efectivo debe traer en la mano. */
  efectivo: number;
  yape: number;
  pos: number;
  /** Todo lo cobrado, sea como sea. */
  cobradoTotal: number;
  /** ¿Ya reportó todas sus paradas? Es la condición para cerrar sin forzar. */
  completa: boolean;
}

export function routeTotals(stops: readonly RouteStop[]): RouteTotals {
  const by = (method: string) =>
    round2(
      stops
        .filter((s) => s.status === "entregado" && s.payment_method === method)
        .reduce((sum, s) => sum + Math.max(0, s.collected_amount ?? 0), 0),
    );

  const efectivo = by("efectivo");
  const yape = by("yape");
  const pos = by("pos");
  const pendientes = stops.filter((s) => s.status === "pendiente").length;

  return {
    total: stops.length,
    pendientes,
    entregados: stops.filter((s) => s.status === "entregado").length,
    noEntregados: stops.filter((s) => s.status === "no_entregado").length,
    efectivo,
    yape,
    pos,
    cobradoTotal: round2(efectivo + yape + pos),
    completa: stops.length > 0 && pendientes === 0,
  };
}

/**
 * Lo que se le paga al motorizado por la ruta.
 *
 * Usa el mismo motor que todo lo demás (`resolveTariff`), así que una tarifa
 * plana de S/ 8.50 es sencillamente una tarifa sin ámbito: se configura una vez
 * en Costos, lleva fecha de vigencia y, si mañana sube, lo que se pagó ayer no
 * se reescribe.
 *
 * Solo se paga lo ENTREGADO por defecto. Que una visita fallida se pague o no
 * es una decisión de la empresa, no del cálculo: si hay tarifa de visita
 * configurada, se aplica; si no la hay, esas paradas valen cero y no se
 * reportan como tarifa faltante, porque no tenerla es una postura válida.
 */
export interface RoutePayout {
  entregas: number;
  visitas: number;
  amount: number;
  /** Entregas sin tarifa vigente ese día: hay que definirla antes de cerrar. */
  missingTariffs: number;
}

export function computeRoutePayout(
  stops: readonly RouteStop[],
  tariffs: readonly CostTariff[],
  ctx: CostContext,
  day: string,
): RoutePayout {
  const entregas = stops.filter((s) => s.status === "entregado");
  const visitas = stops.filter((s) => s.status === "no_entregado");

  const perDelivery = resolveTariff(tariffs, "motorizado_entrega", ctx, day);
  const perVisit = resolveTariff(tariffs, "motorizado_visita", ctx, day);

  const amount = round2(
    entregas.length * (perDelivery?.amount ?? 0) + visitas.length * (perVisit?.amount ?? 0),
  );

  return {
    entregas: entregas.length,
    visitas: visitas.length,
    amount,
    // Solo la de entrega se considera obligatoria: sin ella el pago sería cero
    // en silencio. La de visita ausente significa "las visitas no se pagan".
    missingTariffs: entregas.length > 0 && !perDelivery ? 1 : 0,
  };
}

/**
 * Convierte las paradas de una ruta cerrada en líneas de liquidación.
 *
 * Aquí está la ganancia de todo el módulo: las líneas nacen YA vinculadas a su
 * pedido (`order_id` viene de la asignación, no de adivinar un nombre), así que
 * la liquidación de un motorizado propio no tiene cola de revisión. Es la misma
 * estructura que produce el lector de Excel, para que el cuadre sea uno solo.
 */
export interface SettlementLineDraft {
  order_id: string;
  declared_status: string;
  declared_amount: number | null;
  match_status: "ok";
  raw: Record<string, string>;
}

export function stopsToSettlementLines(
  stops: readonly RouteStop[],
): SettlementLineDraft[] {
  return stops
    .filter((s) => s.status !== "pendiente")
    .map((s) => ({
      order_id: s.order_id,
      declared_status: s.status === "entregado" ? "entregado" : "no entregado",
      // Una no-entrega declara cero, no null: el motorizado SÍ reportó, y dijo
      // que no cobró nada. Es distinto de "no lo declaró".
      declared_amount: s.status === "entregado" ? round2(Math.max(0, s.collected_amount ?? 0)) : 0,
      match_status: "ok" as const,
      raw: {
        origen: "ruta",
        estado: s.status,
        metodo: s.payment_method ?? "",
        monto: s.collected_amount === null ? "" : String(s.collected_amount),
      },
    }));
}
