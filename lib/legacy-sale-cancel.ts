// Anulación COMERCIAL local de los históricos Shopify (MOM §38.16).
// No cambia la fuente Shopify ni los hechos de ninguna caja.
import type { WooCancelFacts } from "@/lib/woo-cancel";

export const LEGACY_SALE_CANCELLED = "legacy_shopify_sale_cancelled";
export const LEGACY_SALE_CANCEL_REASON = "La venta de este pedido histórico está anulada en Kapta. No se permiten nuevos envíos. Un admin debe corregir la anulación desde la ficha si fue un error.";
export const LEGACY_SALE_CANCEL_REASONS = [
  { code: "entrega_no_lograda", label: "No se logró entregar; no se reintentará" },
  { code: "cliente_desiste", label: "La clienta ya no lo quiere" },
  { code: "duplicado", label: "Pedido duplicado" },
  { code: "rehacer", label: "Se rehace con otros datos" },
  { code: "sin_stock", label: "Sin stock" },
  { code: "otro", label: "Otro motivo" },
] as const;

export function validateLegacySaleCancelReason(code: unknown, text: unknown) {
  const option = LEGACY_SALE_CANCEL_REASONS.find((reason) => reason.code === code);
  if (!option) return { ok: false as const, error: "Elige el motivo de la anulación." };
  const clean = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (clean.length < 5 || clean.length > 500) return {
    ok: false as const, error: "Explica por qué termina la venta (entre 5 y 500 caracteres).",
  };
  return { ok: true as const, code: option.code, label: option.label, text: clean };
}

export interface LegacySaleEvent {
  kind: string;
  occurred_at: string;
  source?: string | null;
  new_status?: string | null;
}

/** Solo una corrección explícita de un admin, nunca un reporte, reactiva la venta. */
export function legacySaleCancelledAt(events: readonly LegacySaleEvent[]): string | null {
  let cancelled: string | null = null;
  let corrected: string | null = null;
  for (const event of events) {
    if (event.kind === LEGACY_SALE_CANCELLED && (!cancelled || event.occurred_at > cancelled)) cancelled = event.occurred_at;
    if (event.kind === "status_override" && event.source === "manual" && ["pendiente", "en_proceso", "entregado"].includes(event.new_status ?? "") &&
      (!corrected || event.occurred_at > corrected)) corrected = event.occurred_at;
  }
  return cancelled && (!corrected || corrected <= cancelled) ? cancelled : null;
}

export function isHistoricalShopifyOrder(input: {
  orderPlatform: string | null; orderCreatedAt: string | null;
  storePlatform: string | null; switchedAt: string | null;
}): boolean {
  if (input.orderPlatform !== "shopify" || input.storePlatform !== "woocommerce" || !input.orderCreatedAt || !input.switchedAt) return false;
  const created = Date.parse(input.orderCreatedAt);
  const switched = Date.parse(input.switchedAt);
  return Number.isFinite(created) && Number.isFinite(switched) && created < switched;
}

/** Se permiten cajas en calle/retorno: son obligaciones, no un nuevo intento. */
export function legacySaleCancelBlocks(facts: WooCancelFacts) {
  if (facts.platform !== "shopify") return ["Esta opción es solo para pedidos históricos de Shopify."];
  const blocks: string[] = [];
  if (facts.generalStatus === "entregado" || facts.shipments.some((s) => s.delivery_status === "entregado"))
    blocks.push("Hay una entrega registrada. La anulación de una venta entregada requiere revisión del admin.");
  if (["paid", "partially_paid", "partially_refunded", "refunded"].includes(facts.financialStatus ?? "") ||
    facts.payments?.some((p) => p.validation_status === "validado"))
    blocks.push("Hay dinero registrado: el dueño debe resolver el reembolso antes de anular esta venta.");
  else if (facts.payments?.some((p) => p.validation_status && p.validation_status !== "rechazado"))
    blocks.push("Hay un comprobante sin resolver. Revísalo en Cobro antes de anular la venta.");
  if (facts.companion?.travelsIn || facts.companion?.carries.length)
    blocks.push("El pedido comparte una caja con otro pedido. Desvincúlalo antes de anular esta venta.");
  return blocks;
}
