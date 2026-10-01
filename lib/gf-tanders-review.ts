// Un despacho anterior sin entrega permite revisión, no declara fallida la guía.
import { limaDay } from "@/lib/dispatch-day";

export interface TandersReview {
  shipmentIds: string[];
  dispatchedAt: string;
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
}

/** La consulta y la revalidación usan el día real de Lima, no el día de la caja. */
export function tandersReviewQueueFilter(today: string): string {
  return `and(macro_stage.eq.en_curso,macro_substage.eq.en_transito,current_courier.eq.tanders,dispatched_at.lt.${today}T00:00:00-05:00)`;
}

export function tandersReview(order: ReviewOrder, outputs: readonly ReviewOutput[], today: string): TandersReview | null {
  if (order.coverage !== "lima" || order.current_courier !== "tanders" ||
      order.macro_stage !== "en_curso" || order.macro_substage !== "en_transito") return null;
  // Un Master atrasado no debe ofrecer una entrega recién recibida del courier.
  if (outputs.some((o) => o.status_category === "delivered" || o.delivery_status === "entregado" || o.reported_status?.trim().toUpperCase() === "DELIVERED")) return null;
  const live = outputs.filter((o) => ["pendiente", "en_ruta", "por_preparar"].includes(o.delivery_status));
  if (!live.length || live.some((o) => {
    const dispatchedDay = o.dispatched_at && Number.isFinite(Date.parse(o.dispatched_at)) ? limaDay(o.dispatched_at) : null;
    return o.courier !== "tanders" || o.delivery_status !== "en_ruta" || !dispatchedDay || dispatchedDay >= today;
  })) return null;
  return {
    shipmentIds: live.map((o) => o.id).sort(),
    dispatchedAt: live.map((o) => o.dispatched_at!).sort().at(-1)!,
  };
}

/** Confirmación por pedido, vinculada a las salidas que vio el operador. */
export function confirmedTandersReview(review: TandersReview, confirmation: TandersReviewConfirmation | undefined): boolean {
  return Boolean(confirmation && ["returned", "additional"].includes(confirmation.packageLocation) &&
    Array.isArray(confirmation.shipmentIds) && confirmation.shipmentIds.length === review.shipmentIds.length &&
    [...confirmation.shipmentIds].sort().every((id, i) => id === review.shipmentIds[i]));
}

export function tandersReviewReason(location: TandersPackageLocation): string {
  return location === "returned"
    ? "Tanders: despacho anterior sin entrega. El operador confirma que el paquete volvió al almacén; Grupo GF crea una nueva salida."
    : "Tanders: despacho anterior sin entrega. El operador solicita otro paquete mientras se recupera el anterior; Grupo GF crea una salida adicional.";
}
