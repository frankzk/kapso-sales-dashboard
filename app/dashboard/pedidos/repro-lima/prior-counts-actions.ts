"use server";

// La etiqueta «¿tuvo pedidos antes?» del panel de Repro Lima (owner,
// 13-11-2026; MOM §8.1). Aparte de actions.ts porque también la ve Despacho,
// que entra solo a «Reintentos Aliclik» (`requireReproLima({ retries: true })`).

import { createAdminSupabase } from "@/lib/db";
import { requireReproLima } from "@/lib/repro-lima-access";
import { PRIOR_COUNTS_MAX_ORDERS, priorCountsByOrder, type PriorCounts } from "@/lib/customer-prior-counts";

/**
 * La etiqueta «¿tuvo pedidos antes?» de la lista (owner, 13-11-2026; MOM §8.1).
 * Solo de las filas que se ven (hasta `PRIOR_COUNTS_MAX_ORDERS`), después de
 * dibujar la tabla: contar el historial de miles de pendientes al abrir la
 * página la haría lenta. Solo lee, y solo en las tiendas de quien mira.
 */
export async function loadPriorOrderCounts(orderIds: readonly string[]): Promise<{ counts: Record<string, PriorCounts> } | { error: string }> {
  const scope = await requireReproLima({ retries: true });
  if ("error" in scope) return { error: scope.error };
  const ids = [...new Set(orderIds)].slice(0, PRIOR_COUNTS_MAX_ORDERS);
  if (!ids.length) return { counts: {} };
  const stores = [...scope.storeIds];
  const admin = createAdminSupabase();
  const { data: targets, error } = await admin
    .from("order_master")
    .select("order_id,customer_phone")
    .in("order_id", ids)
    .in("store_id", stores);
  if (error) return { error: error.message };
  const rows = (targets ?? []) as { order_id: string; customer_phone: string | null }[];
  const phones = [...new Set(rows.map((r) => (r.customer_phone ?? "").trim()).filter(Boolean))];
  const history: { order_id: string; customer_phone: string | null; general_status: string | null; macro_stage: string | null }[] = [];
  for (let i = 0; i < phones.length; i += 100) {
    const { data, error: histError } = await admin
      .from("order_master")
      .select("order_id,customer_phone,general_status,macro_stage")
      .in("customer_phone", phones.slice(i, i + 100))
      .in("store_id", stores)
      .limit(5000);
    if (histError) return { error: histError.message };
    history.push(...((data ?? []) as typeof history));
  }
  return { counts: Object.fromEntries(priorCountsByOrder(rows, history)) };
}
