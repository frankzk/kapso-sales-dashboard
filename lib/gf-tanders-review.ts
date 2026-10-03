// Un despacho anterior sin entrega permite revisión, no declara fallida la guía.
import { limaDay } from "@/lib/dispatch-day";

export interface TandersReview {
  shipmentIds: string[];
  /**
   * Despacho anterior: cuándo Tanders lo recolectó. Sin recolectar: cuándo se
   * creó la guía en Tanders. Es la fecha que muestra la lista.
   */
  dispatchedAt: string;
  /** La guía nunca se recolectó: el paquete sigue en el almacén (03-10-2026). */
  uncollected?: boolean;
}

export type TandersPackageLocation = "returned" | "additional";
export interface TandersReviewConfirmation {
  shipmentIds: string[];
  packageLocation: TandersPackageLocation;
}
export type TandersConfirmations = Record<string, TandersReviewConfirmation>;

interface ReviewOrder {
  macro_stage?: unknown;
  macro_substage?: unknown;
  coverage?: unknown;
  current_courier?: unknown;
}
interface ReviewOutput {
  id: string;
  courier: string;
  delivery_status: string;
  dispatched_at: string | null;
  status_category?: string | null;
  reported_status?: string | null;
  /** Cuándo se creó la guía en Tanders (`tanders_raw.createdAt`). */
  tanders_created_at?: string | null;
}

/**
 * Desde qué día queda libre un paquete que Tanders recolectó y no entregó.
 *
 * El día que Tanders lo recolecta es su día de reparto: hasta que termina, el
 * paquete es suyo. Queda libre el SIGUIENTE DÍA HÁBIL, y el único día no hábil
 * es el domingo —los feriados se trabaja— (confirmado por la operación,
 * 02-10-2026). Recolectado el viernes, libre el sábado; recolectado el sábado,
 * libre el lunes, no el domingo.
 *
 * Devuelve el día límite: se ofrecen los despachos ANTERIORES a él. Un día
 * cualquiera es él mismo; un domingo es el sábado anterior, para que lo
 * despachado el sábado espere al lunes. Días `YYYY-MM-DD` de Lima. Pura.
 */
export function tandersReleaseCutoff(today: string): string {
  const noon = new Date(`${today}T12:00:00Z`);
  if (!Number.isFinite(noon.getTime()) || noon.getUTCDay() !== 0) return today;
  return new Date(noon.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/** El día hábil siguiente: el día después, saltando el domingo. Pura. */
export function nextBusinessDay(day: string): string {
  const noon = new Date(`${day}T12:00:00Z`);
  if (!Number.isFinite(noon.getTime())) return day;
  const next = new Date(noon.getTime() + 86_400_000);
  if (next.getUTCDay() === 0) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * El día en que Tanders debía repartir una guía que todavía no recolectó: el
 * siguiente día hábil después de crearla. Si pasa ese día y la guía sigue
 * Pendiente, el paquete queda libre el día hábil siguiente, como uno que salió
 * y no se entregó (decisión del owner, 03-10-2026). Pura.
 */
export function tandersExpectedDeliveryDay(createdAt: string | null | undefined): string | null {
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) return null;
  const created = limaDay(createdAt);
  return created ? nextBusinessDay(created) : null;
}

/** La consulta y la revalidación usan el día real de Lima, no el día de la caja. */
export function tandersReviewQueueFilter(today: string): string {
  const cutoff = tandersReleaseCutoff(today);
  return `and(macro_stage.eq.en_curso,macro_substage.eq.en_transito,current_courier.eq.tanders,dispatched_at.lt.${cutoff}T00:00:00-05:00)`;
}

export function tandersReview(order: ReviewOrder, outputs: readonly ReviewOutput[], today: string): TandersReview | null {
  if (order.coverage !== "lima" || order.current_courier !== "tanders") return null;
  const inTransit = order.macro_stage === "en_curso" && order.macro_substage === "en_transito";
  // Sin recolectar, el paquete sigue en el almacén: el pedido está listo para asignar.
  const waitingPickup = order.macro_stage === "por_despachar" && order.macro_substage === "listo_para_asignar";
  if (!inTransit && !waitingPickup) return null;
  // Un Master atrasado no debe ofrecer una entrega recién recibida del courier.
  if (outputs.some((o) => o.status_category === "delivered" || o.delivery_status === "entregado" || o.reported_status?.trim().toUpperCase() === "DELIVERED")) return null;
  const live = outputs.filter((o) => ["pendiente", "en_ruta", "por_preparar"].includes(o.delivery_status));
  const cutoff = tandersReleaseCutoff(today);
  // Recolectada: libre el día hábil siguiente al de su reparto.
  const collectedAndDue = (o: ReviewOutput) => {
    const dispatchedDay = o.dispatched_at && Number.isFinite(Date.parse(o.dispatched_at)) ? limaDay(o.dispatched_at) : null;
    return o.delivery_status === "en_ruta" && Boolean(dispatchedDay) && dispatchedDay! < cutoff;
  };
  // Nunca recolectada: libre el día hábil siguiente al que Tanders debía repartirla.
  const uncollectedAndDue = (o: ReviewOutput) => {
    const expected = tandersExpectedDeliveryDay(o.tanders_created_at);
    return o.delivery_status === "pendiente" && !o.dispatched_at && Boolean(expected) && expected! < cutoff;
  };
  if (!live.length || live.some((o) => o.courier !== "tanders")) return null;
  if (inTransit && live.every(collectedAndDue)) {
    return {
      shipmentIds: live.map((o) => o.id).sort(),
      dispatchedAt: live.map((o) => o.dispatched_at!).sort().at(-1)!,
    };
  }
  if (waitingPickup && live.every(uncollectedAndDue)) {
    return {
      shipmentIds: live.map((o) => o.id).sort(),
      dispatchedAt: live.map((o) => o.tanders_created_at!).sort().at(-1)!,
      uncollected: true,
    };
  }
  return null;
}

/** Confirmación por pedido, vinculada a las salidas que vio el operador. */
export function confirmedTandersReview(review: TandersReview, confirmation: TandersReviewConfirmation | undefined): boolean {
  return Boolean(confirmation && ["returned", "additional"].includes(confirmation.packageLocation) &&
    Array.isArray(confirmation.shipmentIds) && confirmation.shipmentIds.length === review.shipmentIds.length &&
    [...confirmation.shipmentIds].sort().every((id, i) => id === review.shipmentIds[i]));
}

export function tandersReviewReason(location: TandersPackageLocation, uncollected = false): string {
  if (uncollected) {
    return location === "returned"
      ? "Tanders: la guía nunca se recolectó y pasó su día de reparto. El operador confirma que el paquete está en el almacén; Grupo GF crea una nueva salida."
      : "Tanders: la guía nunca se recolectó y pasó su día de reparto. El operador solicita otro paquete; Grupo GF crea una salida adicional.";
  }
  return location === "returned"
    ? "Tanders: despacho anterior sin entrega. El operador confirma que el paquete volvió al almacén; Grupo GF crea una nueva salida."
    : "Tanders: despacho anterior sin entrega. El operador solicita otro paquete mientras se recupera el anterior; Grupo GF crea una salida adicional.";
}
