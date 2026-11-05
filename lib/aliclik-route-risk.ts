// Aliclik cerrado para ESTE pedido por riesgo de no entrega (MOM §8.6,
// owner 05-11-2026).
//
// EL ANÁLISIS (Kenku, Provincia COD, abr–nov 2026). Medido en abr–ago y
// contrastado en sep–nov, con 4.930 cruces de dos y tres variables probados:
// casi todo lo que parecía bajísimo se volvía normal en el período siguiente
// (un departamento, un producto, la dirección sin número). Dos grupos se
// sostuvieron en los dos:
//
//   * Un cliente que YA tuvo un despacho que salió y no se entregó, y ningún
//     entregado: 35/76 (46 %) y 41/76 (54 %), frente a ~69 % de la provincia.
//   * Un pedido hecho de madrugada (00:00–05:59, hora de Lima) que necesitó
//     gestión en DOS O MÁS días antes de tener guía: 3/14 (21 %) y 14/43 (33 %).
//     Cada señal sola deja ~55 %; juntas se hunden.
//
// QUÉ SE CIERRA. Solo Aliclik, por la misma razón que el cierre por rechazo en
// la puerta (lib/door-rejection.ts): es la única ruta que nos cobra el intento
// no entregado (~S/ 18 de ida + S/ 10 de vuelta, cotizado). Al cliente le
// quedan Swayp/Fénix —contraentrega a domicilio, sin costo por intento
// fallido— o la agencia con su adelanto de siempre. La cobertura del pedido NO
// cambia: sigue siendo Provincia COD, porque la cobertura dice dónde está el
// destino, no qué riesgo tiene el cliente.
//
// SE LEVANTA CON MOTIVO ESCRITO, como la escalera de adelanto del §8: la
// evidencia es de 76 y 57 pedidos, no de miles. El automático no escribe
// motivos por nadie, así que a él lo detiene siempre.
//
// Todo lo de aquí es puro: el drawer y la creación de la guía deciden con lo
// mismo, y no se pueden separar.

import type { PriorOrderSnapshot } from "@/lib/order-confirmation-brief";

/** Desde qué día de gestión cuenta el pedido de madrugada. */
export const NIGHT_ORDER_MIN_DAYS = 2;

/** La madrugada termina antes de esta hora de Lima (00:00–05:59). */
export const NIGHT_ORDER_END_HOUR = 6;

/** Lo que le queda al cliente con Aliclik cerrado por esta regla. */
export const ROUTE_RISK_ROUTES_LABEL = "Swayp/Fénix o agencia con adelanto";

/** Largo mínimo del motivo que levanta el cierre (el mismo del §8). */
export const ROUTE_RISK_REASON_MIN = 8;

export type RouteRiskReason =
  | { kind: "fallido_sin_entregado"; failed: number }
  | { kind: "madrugada_gestion"; time: string; days: number };

export interface AliclikRouteRisk {
  /** Aliclik cerrado para este pedido (salvo motivo escrito). */
  closed: boolean;
  reasons: RouteRiskReason[];
  /**
   * Pedido de madrugada que todavía va en su primer día de gestión: no cierra
   * nada, pero la asesora tiene que saber que, si no se confirma hoy, Aliclik
   * se cierra desde el segundo día.
   */
  nightPending: boolean;
}

/** "HH:mm" en Lima de un instante, o null si no se puede leer. */
export function limaClockOf(iso: string | null | undefined): string | null {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(at));
  const hh = parts.find((p) => p.type === "hour")?.value;
  const mm = parts.find((p) => p.type === "minute")?.value;
  if (!hh || !mm) return null;
  // Intl puede devolver "24" a medianoche en algunos runtimes.
  return `${hh === "24" ? "00" : hh}:${mm}`;
}

/** La hora (0–23) en Lima de un instante, o null si no se puede leer. */
export function limaHourOf(iso: string | null | undefined): number | null {
  const clock = limaClockOf(iso);
  return clock === null ? null : Number(clock.slice(0, 2));
}

/** ¿El pedido se hizo de madrugada (00:00–05:59 en Lima)? */
export function isNightOrder(orderCreatedAt: string | null | undefined): boolean {
  const hour = limaHourOf(orderCreatedAt);
  return hour !== null && hour < NIGHT_ORDER_END_HOUR;
}

/**
 * Un pedido anterior que SALIÓ y no se entregó.
 *
 * `devuelto` siempre salió. Un `anulado` solo cuenta si tiene fecha de
 * despacho: nueve de cada diez anulados se cayeron antes de salir y no
 * costaron flete, y esos no dicen nada de si el cliente recibe. Un pedido que
 * sigue en curso todavía no es un fallo.
 */
export function isFailedDispatch(row: PriorOrderSnapshot): boolean {
  const status = (row.general_status ?? "").trim().toLowerCase();
  if (status === "devuelto") return true;
  return status === "anulado" && Boolean((row.dispatched_at ?? "").trim());
}

/** Cuántos despachos fallidos y cuántos entregados tiene el cliente en sus otros pedidos. */
export function dispatchRecord(priors: readonly PriorOrderSnapshot[]): { failed: number; delivered: number } {
  let failed = 0;
  let delivered = 0;
  for (const row of priors) {
    if ((row.general_status ?? "").trim().toLowerCase() === "entregado") delivered += 1;
    else if (isFailedDispatch(row)) failed += 1;
  }
  return { failed, delivered };
}

export interface RouteRiskInput {
  /** `provincia_cod` es la única operación donde aplica (lo medido). */
  operation: string | null | undefined;
  orderCreatedAt: string | null | undefined;
  /** Días distintos de gestión de confirmación usados hasta ahora. */
  confirmationDays: number | null | undefined;
  /**
   * El pedido ya salió alguna vez (`dispatched_at`). Entonces sus días de
   * gestión cuentan también los de después de la guía —reprogramar, Repro—, que
   * no son lo medido: la regla de madrugada mira solo la confirmación previa a
   * la primera guía.
   */
  alreadyDispatched?: boolean;
  /** Los OTROS pedidos del mismo teléfono (la ficha del §8). */
  priors: readonly PriorOrderSnapshot[];
}

export function aliclikRouteRisk(input: RouteRiskInput): AliclikRouteRisk {
  if (input.operation !== "provincia_cod") return { closed: false, reasons: [], nightPending: false };
  const reasons: RouteRiskReason[] = [];

  const record = dispatchRecord(input.priors);
  if (record.failed >= 1 && record.delivered === 0) {
    reasons.push({ kind: "fallido_sin_entregado", failed: record.failed });
  }

  const hour = limaHourOf(input.orderCreatedAt);
  const days = Math.max(0, Math.floor(input.confirmationDays ?? 0));
  const night = hour !== null && hour < NIGHT_ORDER_END_HOUR;
  if (night && !input.alreadyDispatched && days >= NIGHT_ORDER_MIN_DAYS) {
    reasons.push({ kind: "madrugada_gestion", time: limaClockOf(input.orderCreatedAt) ?? "", days });
  }

  return {
    closed: reasons.length > 0,
    reasons,
    nightPending: night && !input.alreadyDispatched && days < NIGHT_ORDER_MIN_DAYS,
  };
}

/** Cada motivo en una frase para la asesora. */
export function routeRiskReasonText(reason: RouteRiskReason): string {
  if (reason.kind === "fallido_sin_entregado") {
    return reason.failed === 1
      ? "El cliente ya tuvo un pedido que salió y no se entregó, y ninguno entregado."
      : `El cliente ya tuvo ${reason.failed} pedidos que salieron y no se entregaron, y ninguno entregado.`;
  }
  return `Pedido hecho de madrugada (${reason.time}) que ya va por su ${reason.days}.º día de gestión sin guía.`;
}

export const ROUTE_RISK_TITLE = "Aliclik cerrado para este pedido";

export interface AliclikRouteRiskGate {
  allowed: boolean;
  requiresException: boolean;
  message: string | null;
}

/**
 * La compuerta de la creación. Mismo patrón que `aliclikRiskGate`: cerrado sin
 * motivo, abierto con un motivo de al menos ROUTE_RISK_REASON_MIN caracteres,
 * que queda auditado en la línea de tiempo.
 */
export function aliclikRouteRiskGate(
  risk: AliclikRouteRisk,
  exceptionReason?: string | null,
): AliclikRouteRiskGate {
  if (!risk.closed) return { allowed: true, requiresException: false, message: null };
  const reason = exceptionReason?.trim() ?? "";
  if (reason.length >= ROUTE_RISK_REASON_MIN) return { allowed: true, requiresException: true, message: null };
  return {
    allowed: false,
    requiresException: true,
    message:
      `${ROUTE_RISK_TITLE}: ${risk.reasons.map(routeRiskReasonText).join(" ")} ` +
      `Despáchalo por ${ROUTE_RISK_ROUTES_LABEL}. Para crear la guía Aliclik igual, escribe por qué.`,
  };
}
