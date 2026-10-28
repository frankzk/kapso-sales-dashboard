import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { commercialSaleCancelBlocks } from "@/lib/legacy-sale-cancel";
import { wooReturnStockBlock, WOO_SALE_RETURN_SYNCED } from "@/lib/woo-sale-return";
import { parseWooOrderId } from "@/lib/order-admin-url";
import { hasWooApiCredentials, loadWooStoreCreds, withWooAuthFallback, wooClientOpts } from "@/lib/woocommerce-intake";
import { fetchWooOrder, mapWooOrder, type WooClientOpts } from "@/lib/woocommerce";
import { cancelWooOrderInStore } from "@/lib/woo-cancel-server";
import { applyWooOrderResponse } from "@/lib/ingest";
import { recomputeOrderMasterSafe } from "@/lib/order-master";

class WooReturnError extends Error {}

type Queue = { order_id: string; store_id: string; actor: string; shipment_ids: string[]; lease_token: string; last_error: string | null };
export function wooReturnSyncOperation(orderId: string): string {
  const h=createHash("sha256").update(`woo-return-stock|${orderId}`).digest("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}

/** Una sola persona/cron posee el turno. Releer y cancelar un estado ya cancelado no suma stock otra vez. */
export async function processWooSaleReturn(admin: SupabaseClient, orderId?: string, fetchImpl?: WooClientOpts["fetchImpl"]): Promise<{ state: "skipped" | "pending" | "synced"; error?: string }> {
  const { data: claimed, error: claimError } = await admin.rpc("woo_claim_sale_return", { p_order_id: orderId ?? null });
  if (claimError) return { state: "pending", error: "No se pudo comprobar el cierre pendiente de WooCommerce." };
  const q = (claimed as Queue[] | null)?.[0];
  if (!q) return { state: "skipped" };
  try {
    const [order, shipments, events, payments, stops] = await Promise.all([
      admin.from("orders").select("id,store_id,platform,shopify_order_id,financial_status").eq("id", q.order_id).maybeSingle(),
      admin.from("shipments").select("id,courier,delivery_status,custody_state,dispatched_at,custody_transferred_at").eq("order_id", q.order_id),
      admin.from("order_events").select("kind,occurred_at,source,actor,shipment_id,new_status").eq("order_id", q.order_id),
      admin.from("order_payments").select("validation_status").eq("order_id", q.order_id),
      admin.from("delivery_stops").select("status").eq("order_id", q.order_id),
    ]);
    if (order.error || shipments.error || events.error || payments.error || stops.error || !order.data || order.data.platform!=="woocommerce" || order.data.store_id!==q.store_id)
      throw new WooReturnError("No se pudieron verificar pedido, retornos, entregas y pagos. No se envió la cancelación a WooCommerce.");
    if (!events.data?.some((e) => e.kind==="woo_sale_ended_pending_return")) throw new WooReturnError("Falta la constancia de venta terminada.");
    const blocks = commercialSaleCancelBlocks({ platform:"woocommerce",generalStatus:null,financialStatus:order.data.financial_status,shipments:shipments.data ?? [],payments:payments.data ?? [] });
    if (stops.data?.some((s)=>s.status==="entregado") || events.data.some((e)=>e.kind==="delivered" || e.new_status==="entregado")) blocks.push("Hay una entrega reportada que requiere revisión.");
    const physical = wooReturnStockBlock(q.shipment_ids,shipments.data ?? [],events.data ?? []);
    if (physical) blocks.push(physical);
    if (blocks.length) throw new WooReturnError(blocks.join(" "));
    const { creds, error } = await loadWooStoreCreds(admin,q.store_id);
    if (error || !hasWooApiCredentials(creds)) throw new WooReturnError("Revisa la conexión de WooCommerce en Ajustes: no se pudo confirmar el stock.");
    const parsed = parseWooOrderId(order.data.shopify_order_id);
    if (!parsed || parsed.siteKey!==creds.siteKey) throw new WooReturnError("El pedido no corresponde al sitio WooCommerce conectado.");
    const client=wooClientOpts(creds,{ ...(fetchImpl ? {fetchImpl}:{}),timeoutMs:5000 });
    const { value: remote }=await withWooAuthFallback(client,(opts)=>fetchWooOrder(opts,parsed.wooId));
    const mapped=mapWooOrder(remote,{id:q.store_id,woo_site_key:creds.siteKey});
    if (!mapped || remote.id!==Number(parsed.wooId) || ["completed","trash"].includes(remote.status ?? "") || ["paid","partially_paid","partially_refunded","refunded"].includes(mapped.financial_status ?? ""))
      throw new WooReturnError("WooCommerce registra una entrega, un pago o un estado incompatible. El dueño debe revisarlo antes de reponer stock.");
    let confirmed=remote;
    if (remote.status!=="cancelled") {
      const outcome=await cancelWooOrderInStore({client,wooId:Number(parsed.wooId)});
      if (outcome.kind!=="cancelled" || outcome.order.status!=="cancelled") throw new WooReturnError("WooCommerce no confirmó la cancelación tras el retorno. Se volverá a intentar.");
      confirmed=outcome.order;
    }
    // La fuente y el evento se guardan antes de completar el turno. Ante fallo,
    // se relee WooCommerce en el siguiente intento: nunca se suma stock manualmente.
    const applied=await applyWooOrderResponse(admin,creds,confirmed,fetchImpl);
    if (!applied.applied) throw new WooReturnError("WooCommerce ya canceló; falta actualizar su respuesta en el Master. Se reintentará sin sumar stock manualmente.");
    const { error: eventError }=await admin.from("order_events").insert({
      store_id:q.store_id,order_id:q.order_id,kind:WOO_SALE_RETURN_SYNCED,source:"kapta",actor:q.actor,
      note:"Almacén confirmó recepción e inventario. WooCommerce confirmó la cancelación; su mecanismo de stock procesa la reposición una sola vez.",
      operation_id:wooReturnSyncOperation(q.order_id),payload:{shipment_ids:q.shipment_ids,woo_order_id:parsed.wooId},
    });
    if (eventError && eventError.code!=="23505") throw new WooReturnError("WooCommerce ya canceló; falta su constancia de cierre. Se reintentará.");
    const { error: saved }=await admin.from("woo_sale_returns").update({state:"synced",synced_at:new Date().toISOString(),lease_token:null,lease_until:null,last_error:null})
      .eq("order_id",q.order_id).eq("lease_token",q.lease_token);
    if (saved) throw new WooReturnError("WooCommerce ya canceló; falta cerrar el seguimiento de stock en Kapta.");
    await recomputeOrderMasterSafe(admin,[q.order_id]);
    return {state:"synced"};
  } catch (cause) {
    // Solo nuestros mensajes llegan al historial. Los fallos de red/API pueden
    // contener direcciones o datos de autenticación y se sustituyen.
    const safe=cause instanceof WooReturnError ? cause.message : "No se pudo confirmar el cierre de WooCommerce. Se volverá a intentar.";
    await admin.from("woo_sale_returns").update({state:"pending",lease_token:null,lease_until:null,last_error:safe,next_attempt_at:new Date(Date.now()+300000).toISOString()})
      .eq("order_id",q.order_id).eq("lease_token",q.lease_token);
    if (q.last_error!==safe) await admin.from("order_events").insert({store_id:q.store_id,order_id:q.order_id,kind:"woo_sale_return_sync_failed",actor:q.actor,source:"kapta",note:safe});
    return {state:"pending",error:safe};
  }
}
