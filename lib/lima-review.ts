import type { LimaPendingOrder } from "@/lib/repro-lima-pending";
import type { LimaRowClass } from "@/lib/repro-lima-blocks";

/** Roy y Alexis son un proveedor; GF por API es otro. */
export function limaHistoricalProviders(row: Pick<LimaPendingOrder, "dispatchedWith">): string[] {
  return [...new Set((row.dispatchedWith ?? []).map((code) => code === "propio" || code === "gf" || code.startsWith("gf:") ? "gf" : code === "swayp" ? "fenix" : code))].sort();
}

export function limaNeedsReview(row: Pick<LimaPendingOrder, "dispatchedWith">): boolean {
  return limaHistoricalProviders(row).length > 1;
}

export const LIMA_REVIEW_LABELS = {
  couriers: "Revisar posible cierre: salió con varios couriers",
  custody: "Revisar: figura en ruta y en almacén",
  departure: "Revisar salida: sin fecha ni intentos comprobados",
  history: "Revisar: courier histórico sin registrar",
  agreement: "Revisar: acuerdo vencido sin resolver",
  guides: "Revisar: guías externas vivas con distintos couriers",
} as const;

/** Señales de revisión, nunca instrucciones de cancelación ni cambios de custodia. */
export function limaReviewReasons(row: LimaPendingOrder, cls?: LimaRowClass): (keyof typeof LIMA_REVIEW_LABELS)[] {
  const reasons: (keyof typeof LIMA_REVIEW_LABELS)[] = [];
  if (limaNeedsReview(row)) reasons.push("couriers");
  if (new Set(row.ops?.liveCouriers.filter((courier) => !["propio", "por_definir"].includes(courier))).size > 1) reasons.push("guides");
  if (cls?.step !== "no_entregados") return reasons;
  if (cls.noReport && ["empresa", "devuelto"].includes(row.ops?.custody ?? "")) reasons.push("custody");
  const dated = Boolean(row.hasPriorDispatch || row.dispatchedAt || row.lastDepartureAt || row.attempts > 0);
  if (!dated && row.dispatchedWith?.length) reasons.push("departure");
  if (dated && !row.dispatchedWith?.length) reasons.push("history");
  if (cls.noReport && cls.agreed && cls.agendaDay && !cls.agenda) reasons.push("agreement");
  return reasons;
}
