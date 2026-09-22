// Grupo GF Courier en la ficha del pedido (MOM §29.13): quién tiene el
// paquete y en qué quedó la parada. Puro, probado en test/gf-delivery.test.ts.
//
// Junta lo que ya existe en dos sitios distintos y que la ficha no leía:
//   · la caja del motorizado (`dispatch_manifest_items` + `dispatch_manifests`):
//     cotejado, «Lo llevo», «No lo llevo», retirado;
//   · la parada de su ruta (`delivery_stops`): entregado / no entregado con
//     motivo, cobro, foto y comprobante.
// El Master NO cambia con esto (§29.12: la parada es una declaración; el
// pedido lo mueve el cierre de la ruta). Aquí solo se cuenta lo que pasó.

import { DECLINE_REASONS } from "@/lib/rider-decline-reasons";
import { NON_DELIVERY_REASONS, PAYMENT_METHODS, type PaymentMethod, type StopStatus } from "@/lib/routes";

export interface GfBoxItem {
  manifestId: string;
  routeDate: string;
  loadNumber: number | null;
  /** draft · office_check · ready_for_pickup · pickup_check · in_custody · cancelled */
  boxState: string;
  riderId: string | null;
  riderName: string;
  addedAt: string | null;
  officeCheckedAt: string | null;
  pickupCheckedAt: string | null;
  pickupDeclinedAt: string | null;
  pickupDeclinedReason: string | null;
  removedAt: string | null;
  removalReason: string | null;
}

export interface GfStop {
  id: string;
  status: StopStatus;
  outcomeReason: string | null;
  note: string | null;
  reportedAt: string | null;
  paymentMethod: PaymentMethod | string | null;
  collectedAmount: number | null;
  photoPath: string | null;
  voucherPath: string | null;
  /** 0177: si había «Lo llevo» cuando se reportó; null si no se ha reportado. */
  pickupConfirmed: boolean | null;
  routeDate: string | null;
  /** planificada · en_curso · cerrada */
  routeStatus: string | null;
  riderName: string | null;
  seq: number | null;
}

export interface GfDelivery {
  shipmentId: string;
  box: GfBoxItem | null;
  stop: GfStop | null;
}

export type GfPhase =
  | "en_caja"
  | "lo_lleva"
  | "no_lo_llevo"
  | "retirado"
  | "entregado"
  | "no_entregado"
  | "postergado";

export interface GfDeliverySummary {
  phase: GfPhase;
  /** Titular corto, con el motorizado: «Lo lleva Roy». */
  label: string;
  /** Lo que ayuda a decidir: hora, caja, motivo, cobro. */
  detail: string;
  tone: "slate" | "sky" | "emerald" | "amber" | "red";
  riderName: string | null;
}

/** Motivos que dejan la parada para otro día, no perdida. */
const POSTPONED_REASONS = new Set(["reprogramado", "no_estaba"]);

export function nonDeliveryReasonLabel(code: string | null | undefined): string {
  return NON_DELIVERY_REASONS.find((r) => r.code === code)?.label ?? code ?? "sin motivo";
}

export function declineReasonLabel(code: string | null | undefined): string {
  return DECLINE_REASONS.find((r) => r.code === code)?.label ?? code ?? "sin motivo";
}

export function paymentMethodLabel(code: string | null | undefined): string {
  return PAYMENT_METHODS.find((m) => m.code === code)?.label ?? code ?? "";
}

function limaTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

function limaDayShort(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return null;
  // Como en lib/dispatch-day.ts: `en-CA` da YYYY-MM-DD con ceros y sin
  // depender de cómo cada ICU pinte `es-PE` (Node quitaba el cero del mes).
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
}

/** «22/09 14:32» para un ISO; solo el día si es una fecha sin hora. */
export function limaWhen(iso: string | null | undefined): string | null {
  const day = limaDayShort(iso);
  if (!day) return null;
  const time = iso && iso.length > 10 ? limaTime(iso) : null;
  return time ? `${day} ${time}` : day;
}

const money = (n: number) => `S/ ${n.toFixed(2)}`;

/**
 * Lo más reciente manda: el reporte de la parada por encima de la caja, y
 * dentro de la caja «no lo llevó» y «retirado» por encima de «lo lleva».
 * Devuelve null si el pedido no ha pasado por ninguna caja ni ruta de GF.
 */
export function gfDeliverySummary(d: GfDelivery): GfDeliverySummary | null {
  const { box, stop } = d;
  const rider = stop?.riderName || box?.riderName || null;
  // Sin ficha de motorizado (rutas del cuaderno) no se inventa un nombre.
  const por = rider ? `por ${rider}` : "por el motorizado";
  const de = rider ? `de ${rider}` : "del motorizado";
  const who = rider ?? "el motorizado";

  if (stop && stop.status !== "pendiente") {
    const when = limaWhen(stop.reportedAt);
    if (stop.status === "entregado") {
      const pay = stop.paymentMethod && stop.paymentMethod !== "sin_cobro"
        ? `${paymentMethodLabel(stop.paymentMethod)}${stop.collectedAmount != null ? ` ${money(stop.collectedAmount)}` : ""}`
        : "sin cobro";
      const parts = [when, pay, stop.pickupConfirmed === false ? "entregado sin confirmar recojo" : null, stop.note].filter(Boolean);
      return { phase: "entregado", label: `Entregado ${por}`, detail: parts.join(" · "), tone: "emerald", riderName: rider };
    }
    const reason = nonDeliveryReasonLabel(stop.outcomeReason);
    const postponed = POSTPONED_REASONS.has(stop.outcomeReason ?? "");
    const parts = [reason, when, stop.note].filter(Boolean);
    return postponed
      ? { phase: "postergado", label: `Postergado ${por}`, detail: parts.join(" · "), tone: "amber", riderName: rider }
      : { phase: "no_entregado", label: `No entregado ${por}`, detail: parts.join(" · "), tone: "red", riderName: rider };
  }

  if (box) {
    const boxDay = limaDayShort(box.routeDate);
    const boxLabel = `caja del ${boxDay ?? box.routeDate}${box.loadNumber && box.loadNumber > 1 ? ` · carga ${box.loadNumber}` : ""}`;
    if (box.pickupDeclinedAt) {
      const parts = [declineReasonLabel(box.pickupDeclinedReason), limaWhen(box.pickupDeclinedAt), "vuelve a «por asignar»"].filter(Boolean);
      return { phase: "no_lo_llevo", label: `No lo llevó ${who}`, detail: parts.join(" · "), tone: "red", riderName: rider };
    }
    if (box.removedAt) {
      const parts = [box.removalReason, limaWhen(box.removedAt), boxLabel].filter(Boolean);
      return { phase: "retirado", label: `Retirado de la caja ${de}`, detail: parts.join(" · "), tone: "slate", riderName: rider };
    }
    if (box.pickupCheckedAt) {
      const parts = [`desde ${limaWhen(box.pickupCheckedAt) ?? "hoy"}`, boxLabel, stop ? `parada ${stop.seq ?? ""} pendiente`.replace("  ", " ") : "parada pendiente"].filter(Boolean);
      return { phase: "lo_lleva", label: `Lo lleva ${who}`, detail: parts.join(" · "), tone: "sky", riderName: rider };
    }
    const parts = [boxLabel, box.officeCheckedAt ? "cotejado en oficina" : "sin cotejar", "sin «Lo llevo» del motorizado"].filter(Boolean);
    return { phase: "en_caja", label: `En la caja ${de}`, detail: parts.join(" · "), tone: "slate", riderName: rider };
  }

  if (stop) {
    const day = limaDayShort(stop.routeDate);
    const parts = [day ? `ruta del ${day}` : null, stop.routeStatus === "cerrada" ? "ruta cerrada sin reporte" : "parada pendiente"].filter(Boolean);
    return { phase: "en_caja", label: `En la ruta ${de}`, detail: parts.join(" · "), tone: "slate", riderName: rider };
  }
  return null;
}

/** Una frase para la tarjeta «Revisar la salida activa»: «Lo lleva Roy · desde 22/09 10:32 · caja del 22/09 · parada pendiente». */
export function gfDeliverySentence(d: GfDelivery | null | undefined): string | null {
  if (!d) return null;
  const s = gfDeliverySummary(d);
  if (!s) return null;
  return s.detail ? `${s.label} · ${s.detail}` : s.label;
}

/**
 * Entre varias cajas o paradas de la misma salida, la más reciente: la caja
 * activa (sin retirar) antes que una retirada, y a igualdad la última añadida.
 */
export function pickLatestBox(items: readonly GfBoxItem[]): GfBoxItem | null {
  if (!items.length) return null;
  const rank = (b: GfBoxItem) => `${b.removedAt ? "0" : "1"}:${b.addedAt ?? ""}`;
  return [...items].sort((a, b) => (rank(a) < rank(b) ? 1 : rank(a) > rank(b) ? -1 : 0))[0] ?? null;
}

export function pickLatestStop(stops: readonly GfStop[]): GfStop | null {
  if (!stops.length) return null;
  const rank = (s: GfStop) => `${s.status !== "pendiente" ? "1" : "0"}:${s.reportedAt ?? s.routeDate ?? ""}`;
  return [...stops].sort((a, b) => (rank(a) < rank(b) ? 1 : rank(a) > rank(b) ? -1 : 0))[0] ?? null;
}
