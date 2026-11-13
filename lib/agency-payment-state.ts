export type AgencyPaymentBucket = "complete" | "collect" | "validate" | "historical" | "excluded" | "review";
export interface AgencyPaymentFact {
  paymentState: string | null;
  platform?: string | null;
  financialStatus?: string | null;
  totalRefunded?: number | null;
  generalStatus?: string | null;
  substage?: string | null;
}
/** Mirrors agency_payment_bucket in 0336. Never infers a payment from delivery. */
export function agencyPaymentBucket(order: AgencyPaymentFact): AgencyPaymentBucket {
  if (order.paymentState === "pago_completo") return "complete";
  if (order.platform === "shopify" && order.financialStatus?.trim().toLowerCase() === "paid" && (order.totalRefunded ?? 0) <= 0) return "historical";
  if (["anulado", "devuelto"].includes(order.generalStatus ?? "") || ["anulado_cerrado", "devuelto_conciliado"].includes(order.substage ?? "")) return "excluded";
  if (["adelanto_cargado", "diferencia_cargada", "pago_total_cargado", "posible_duplicado"].includes(order.paymentState ?? "")) return "validate";
  if (order.paymentState == null || ["sin_pago", "adelanto_validado"].includes(order.paymentState)) return "collect";
  return "review";
}
