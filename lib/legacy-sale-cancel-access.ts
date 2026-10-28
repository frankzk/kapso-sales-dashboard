import type { SupabaseClient } from "@supabase/supabase-js";
import { LEGACY_SALE_CANCELLED, LEGACY_SALE_CANCEL_REASON, legacySaleCancelledAt, type LegacySaleEvent } from "@/lib/legacy-sale-cancel";

/** Lee por lotes y falla cerrado: no saberlo nunca autoriza otro envío. */
export async function loadLegacySaleCancellations(admin: SupabaseClient, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 200) {
    const { data, error } = await admin.from("order_events")
      .select("order_id,kind,occurred_at,source,new_status")
      .in("order_id", unique.slice(i, i + 200))
      .in("kind", [LEGACY_SALE_CANCELLED, "woo_sale_ended_pending_return", "status_override"]);
    if (error) throw new Error(`No se pudo comprobar la anulación comercial (${error.message}).`);
    const grouped = new Map<string, LegacySaleEvent[]>();
    for (const event of (data ?? []) as (LegacySaleEvent & { order_id: string })[]) {
      const group = grouped.get(event.order_id) ?? [];
      group.push(event); grouped.set(event.order_id, group);
    }
    for (const [id, events] of grouped) {
      const at = legacySaleCancelledAt(events);
      if (at) out.set(id, at);
    }
  }
  return out;
}

export async function legacySaleSendBlock(admin: SupabaseClient, orderId: string): Promise<string | null> {
  try { return (await loadLegacySaleCancellations(admin, [orderId])).has(orderId) ? LEGACY_SALE_CANCEL_REASON : null; }
  catch (cause) { return cause instanceof Error ? cause.message : "No se pudo comprobar la anulación comercial."; }
}

/** Una caja ya cotejada tampoco se despacha después de cancelar la venta. */
export async function legacySaleManifestBlock(admin: SupabaseClient, manifestId: string): Promise<string | null> {
  try {
    const { data: items, error } = await admin.from("dispatch_manifest_items")
      .select("shipment_id,removed_at").eq("manifest_id", manifestId);
    if (error) throw new Error("No se pudieron comprobar las salidas de la ruta.");
    const ids = (items ?? []).filter((item) => !item.removed_at).map((item) => item.shipment_id);
    if (!ids.length) return null;
    const { data: shipments, error: shipmentError } = await admin.from("shipments")
      .select("id,order_id").in("id", ids);
    if (shipmentError || shipments?.length !== new Set(ids).size) throw new Error("No se pudieron comprobar los pedidos de la ruta.");
    const cancelled = await loadLegacySaleCancellations(admin, shipments.map((shipment) => shipment.order_id).filter(Boolean));
    return cancelled.size ? "La ruta contiene una venta terminada en Kapta. Retira su paquete de esta ruta antes de despachar." : null;
  } catch (cause) { return cause instanceof Error ? cause.message : "No se pudo comprobar la anulación comercial de la ruta."; }
}
