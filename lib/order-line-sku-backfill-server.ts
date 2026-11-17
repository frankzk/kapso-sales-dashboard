// Completa el SKU de los pedidos abiertos con el catálogo vivo (MOM §38.12,
// 17-11-2026). La regla está en lib/order-line-sku-backfill.ts; aquí solo se
// lee y se escribe.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BACKFILL_DAYS,
  BACKFILL_STAGES,
  backfillLineSkus,
  lineSkuBackfillNote,
  type CatalogVariantRef,
  type StoredOrderLine,
} from "@/lib/order-line-sku-backfill";

const PAGE = 1000;
const ID_BATCH = 200;

export interface LineSkuBackfillResult {
  /** Pedidos a los que se les completó al menos una línea. */
  orders: string[];
  errors: string[];
}

/**
 * Los pedidos abiertos de la tienda (las etapas donde todavía se crea una guía,
 * de los últimos `BACKFILL_DAYS` días) con alguna línea sin SKU que el catálogo
 * resuelve sin dudas. Escribe la línea completada y deja la nota en el
 * historial del pedido. Un error no corta la sincronización: se informa.
 */
export async function backfillOpenOrderLineSkus(
  admin: SupabaseClient,
  storeId: string,
  catalog: readonly CatalogVariantRef[],
  sourceName: string,
): Promise<LineSkuBackfillResult> {
  const out: LineSkuBackfillResult = { orders: [], errors: [] };
  if (!catalog.some((ref) => (ref.shopifySku ?? "").trim() && (ref.variantId || ref.productId))) return out;

  const since = new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString();
  const ids: string[] = [];
  for (let from = 0; from < 50_000; from += PAGE) {
    const { data, error } = await admin
      .from("order_master")
      .select("order_id")
      .eq("store_id", storeId)
      .in("macro_stage", [...BACKFILL_STAGES])
      .gte("order_created_at", since)
      .order("order_id")
      .range(from, from + PAGE - 1);
    if (error) {
      out.errors.push(`SKU de pedidos: ${error.message}`);
      return out;
    }
    const rows = (data ?? []) as { order_id: string }[];
    ids.push(...rows.map((r) => r.order_id));
    if (rows.length < PAGE) break;
  }

  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const { data, error } = await admin
      .from("orders")
      .select("id,line_items")
      .in("id", ids.slice(i, i + ID_BATCH));
    if (error) {
      out.errors.push(`SKU de pedidos: ${error.message}`);
      continue;
    }
    for (const order of (data ?? []) as { id: string; line_items: unknown }[]) {
      if (!Array.isArray(order.line_items)) continue;
      const lines = order.line_items as StoredOrderLine[];
      if (!lines.some((l) => !String(l?.sku ?? "").trim())) continue;
      const { lines: next, filled } = backfillLineSkus(lines, catalog);
      if (!filled.length) continue;
      const { error: writeError } = await admin.from("orders").update({ line_items: next }).eq("id", order.id);
      if (writeError) {
        out.errors.push(`SKU de pedidos: ${writeError.message}`);
        continue;
      }
      await admin.from("order_events").insert({
        store_id: storeId,
        order_id: order.id,
        kind: "comment",
        occurred_at: new Date().toISOString(),
        source: "system",
        note: lineSkuBackfillNote(filled, sourceName),
        payload: { sku_backfill: filled },
      });
      out.orders.push(order.id);
    }
  }
  return out;
}
