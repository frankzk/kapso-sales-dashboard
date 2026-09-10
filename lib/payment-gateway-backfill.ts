// Traer de Shopify la pasarela de los pedidos pagados que siguen vivos.
//
// POR QUÉ. Desde el 10-09-2026 «pagado por web» es SOLO la pasarela confirmada
// del checkout, guardada (lib/payment-gateway.ts). Los pedidos sincronizados
// antes de pedirle ese dato a Shopify no lo tienen, así que con la regla
// estricta dejan de contar como pagados — TODOS, también los que sí cobró el
// checkout. Un pedido de ésos en Lima saldría con el total a cobrar en la
// puerta: la clienta pagaría dos veces. Medido al cambiar la regla: 424 vivos
// con `paid` y sin pasarela guardada.
//
// La sincronización normal no los vuelve a traer —va por `updated_at`, y un
// pedido pagado que nadie toca no se actualiza—, así que se les pregunta uno a
// uno, por tandas, desde el cron de sync. Se escribe el pedido entero
// (`upsertOrders`), que deja la lista de pasarelas en `raw` y la clasificación
// en `payment_gateway`; con eso el pedido sale de la cola aunque la respuesta
// sea «ninguna pasarela conocida», y no se le vuelve a preguntar.
//
// LO QUE NO HACE: adivinar. Si Shopify dice `manual`, el pedido pasa a exigir
// constancia, que es lo que decidió la operación.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getStoreCreds, upsertOrders } from "@/lib/ingest";
import { fetchOrderById } from "@/lib/shopify";
import { recomputeOrderMasterSafe } from "@/lib/order-master";

/** Pedidos por pasada y por tienda. El sync corre cada 5 minutos. */
export const BACKFILL_BATCH = 40;

/** Etapas en las que el cobro todavía se decide. Lo cerrado no cambia de mano. */
const ETAPAS_VIVAS = ["por_confirmar", "preparacion", "por_despachar", "en_curso"];

export interface GatewayBackfillReport {
  candidates: number;
  fetched: number;
  updated: number;
  errors: string[];
}

export async function backfillPaymentGateways(
  storeId: string,
  admin: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<GatewayBackfillReport> {
  const report: GatewayBackfillReport = { candidates: 0, fetched: 0, updated: 0, errors: [] };
  const limit = opts.limit ?? BACKFILL_BATCH;
  const creds = await getStoreCreds(storeId, admin);
  if (!creds?.shopify_token) return report;

  // Primero los vivos: son los que pueden cobrar mal. Se pregunta al Master por
  // la etapa y a `orders` por el dato que falta.
  const { data: vivos, error: vivosErr } = await admin
    .from("order_master")
    .select("order_id")
    .eq("store_id", storeId)
    .eq("financial_status", "paid")
    .in("macro_stage", ETAPAS_VIVAS)
    .order("order_created_at", { ascending: false })
    .limit(500);
  if (vivosErr) {
    report.errors.push(`master: ${vivosErr.message}`);
    return report;
  }
  const ids = ((vivos ?? []) as { order_id: string }[]).map((r) => r.order_id);
  if (!ids.length) return report;

  const { data: pendientes, error: pendErr } = await admin
    .from("orders")
    .select("id,shopify_order_id")
    .in("id", ids)
    .is("payment_gateway", null)
    // Sin la lista de pasarelas en el payload guardado: los que ya se
    // preguntaron la tienen (aunque venga vacía) y no se repiten.
    .is("raw->paymentGatewayNames", null)
    .is("raw->payment_gateway_names", null)
    .limit(limit);
  if (pendErr) {
    report.errors.push(`orders: ${pendErr.message}`);
    return report;
  }
  const rows = (pendientes ?? []) as { id: string; shopify_order_id: string }[];
  report.candidates = rows.length;

  const updated: string[] = [];
  for (const row of rows) {
    try {
      const fresh = await fetchOrderById({
        domain: creds.shopify_domain,
        token: creds.shopify_token,
        storeId,
        orderGid: `gid://shopify/Order/${row.shopify_order_id}`,
      });
      report.fetched++;
      if (!fresh) continue;
      await upsertOrders(admin, [fresh]);
      updated.push(row.id);
    } catch (e) {
      report.errors.push(`${row.shopify_order_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  report.updated = updated.length;
  if (updated.length) await recomputeOrderMasterSafe(admin, updated);
  return report;
}
