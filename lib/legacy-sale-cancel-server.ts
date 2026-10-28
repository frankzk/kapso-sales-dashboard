import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { loadCompanionRides } from "@/lib/order-companion-access";
import {
  isHistoricalShopifyOrder, LEGACY_SALE_CANCELLED, legacySaleCancelBlocks,
  legacySaleCancelledAt, validateLegacySaleCancelReason,
} from "@/lib/legacy-sale-cancel";

export function legacySaleCancelOperationId(orderId: string, requestId: string): string {
  const hex = createHash("sha256").update(`legacy-sale-cancel|${orderId}|${requestId}`).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Invoca solo después de autorizar el pedido por RLS y su permiso por organización. */
export async function cancelHistoricalShopifySale(input: {
  admin: SupabaseClient; orderId: string; userId: string;
  reasonCode: unknown; reasonText: unknown; requestId: unknown;
}): Promise<{ error?: string; notice?: string }> {
  const reason = validateLegacySaleCancelReason(input.reasonCode, input.reasonText);
  if (!reason.ok) return { error: reason.error };
  if (typeof input.requestId !== "string" || !/^[a-zA-Z0-9-]{10,80}$/.test(input.requestId))
    return { error: "Vuelve a abrir la anulación para generar un intento válido." };
  const { admin, orderId, userId } = input;
  try {
    const { data: order, error: orderError } = await admin.from("orders")
      .select("id,store_id,name,platform,created_at,cancelled_at,financial_status").eq("id", orderId).maybeSingle();
    if (orderError || !order) return { error: "No se pudo leer el pedido. No se anuló la venta." };
    const { data: store, error: storeError } = await admin.from("stores")
      .select("platform,platform_switched_at").eq("id", order.store_id).maybeSingle();
    if (storeError || !store || !isHistoricalShopifyOrder({
      orderPlatform: order.platform, orderCreatedAt: order.created_at,
      storePlatform: store.platform, switchedAt: store.platform_switched_at,
    })) return { error: "Solo se anulan aquí históricos de Shopify anteriores a la migración de su tienda a WooCommerce." };
    if (order.cancelled_at) return { notice: "El pedido ya está anulado en la tienda." };

    const [master, shipments, payments, events] = await Promise.all([
      admin.from("order_master").select("general_status").eq("order_id", orderId).maybeSingle(),
      admin.from("shipments").select("id,courier,guide_code,delivery_status,custody_state").eq("order_id", orderId),
      admin.from("order_payments").select("validation_status").eq("order_id", orderId),
      admin.from("order_events").select("kind,occurred_at,source,new_status").eq("order_id", orderId),
    ]);
    if (master.error || !master.data || shipments.error || payments.error || events.error)
      return { error: "No se pudieron comprobar el estado, las salidas, los pagos o el historial. No se anuló la venta." };
    if (!legacySaleCancelledAt(events.data ?? [])) {
      const rides = await loadCompanionRides(admin, [orderId]);
      const blocks = legacySaleCancelBlocks({
        platform: order.platform, generalStatus: master.data.general_status,
        financialStatus: order.financial_status, shipments: shipments.data ?? [], payments: payments.data ?? [],
        companion: {
          travelsIn: rides.some((ride) => ride.link.companionOrderId === orderId && ride.shipment) ? "otro pedido" : null,
          carries: rides.filter((ride) => ride.link.hostOrderId === orderId && ride.shipment).map(() => "otro pedido"),
        },
      });
      // Una entrega reportada en Rutas todavía puede no haber llegado al Master.
      const { data: stops, error: stopError } = await admin.from("delivery_stops").select("status").eq("order_id", orderId);
      if (stopError) return { error: "No se pudieron comprobar las entregas de Rutas. No se anuló la venta." };
      if (stops?.some((stop) => stop.status === "entregado") ||
        events.data?.some((event) => event.kind === "delivered" || event.new_status === "entregado"))
        blocks.push("Hay una entrega reportada. Pide al admin revisar el expediente antes de anular la venta.");
      if (blocks.length) return { error: blocks.join(" ") };
      const { error } = await admin.from("order_events").insert({
        store_id: order.store_id, order_id: orderId, kind: LEGACY_SALE_CANCELLED,
        occurred_at: new Date().toISOString(), actor: userId, source: "kapta",
        previous_status: master.data.general_status, new_status: "anulado", new_operational: "anulado",
        reason: `${reason.label} — ${reason.text}`,
        note: "La venta terminó: no se intentará entregar nuevamente. Retornos, inventario y liquidaciones conservan sus pendientes. El original de Shopify no se modifica.",
        operation_id: legacySaleCancelOperationId(orderId, input.requestId),
        payload: { reason_code: reason.code, scope: "kapta_only", order_platform: "shopify", request_id: input.requestId },
      });
      if (error && error.code !== "23505") return { error: "No se pudo guardar la anulación. No se cambió la venta." };
    }
    const updated = await recomputeOrderMasterSafe(admin, [orderId]);
    return { notice: `${order.name ?? "El pedido"}: venta anulada en Kapta. No se modificó Shopify ni ninguna salida.` +
      (updated.written < 1 ? " El hecho quedó guardado; el Master está pendiente de recalcular. Actualiza la ficha antes de continuar." : "") };
  } catch {
    return { error: "No se pudo completar la comprobación de la anulación. Actualiza la ficha antes de reintentar." };
  }
}
