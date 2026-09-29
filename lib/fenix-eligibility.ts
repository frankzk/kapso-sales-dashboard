// Recalcula `shipments.fenix_eligible` de las guías pendientes contra el stock
// Swayp actual. Vive aquí, sin sesión, para que lo llamen tanto la acción del
// panel (que antes verifica que sea un admin) como el cron del sync de
// inventario, que corre sin usuario.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  coverageInputOf,
  evaluateFenix,
  FENIX_COVERAGE_COLUMNS,
  type FenixCoverageRow,
  type FenixStockRow,
} from "@/lib/fenix";

/** Qué falló, en el vocabulario del panel; el detalle técnico va al log. */
export class ElegibilidadError extends Error {
  constructor(
    readonly accion: string,
    readonly causa: { message?: string; code?: string } | null,
  ) {
    super(`No se pudo ${accion}.`);
    this.name = "ElegibilidadError";
  }
}

/**
 * Reevalúa cada guía pendiente de `storeIds` contra el stock de `orgId` y
 * cambia sólo las que no coinciden. Devuelve cuántas cambió. Lanza
 * `ElegibilidadError` si una lectura o escritura falla.
 */
export async function recalcularElegibilidadFenix(
  admin: SupabaseClient,
  orgId: string,
  storeIds: string[],
): Promise<number> {
  if (!storeIds.length) return 0;

  const { data: stock, error: stockError } = await admin
    .from("fenix_stock")
    .select("city,product,sku,quantity,unlimited")
    .eq("org_id", orgId);
  if (stockError) throw new ElegibilidadError("consultar el stock Swayp", stockError);
  const stockRows = (stock as FenixStockRow[]) ?? [];

  // Only pending guides carry eligibility; re-evaluate each and flip the ones
  // whose stored flag no longer matches. Paginate past Supabase's 1,000-row
  // response cap so a large queue is never only partially synchronized.
  type PendingShipment = FenixCoverageRow & {
    id: string;
    product: string | null;
    order_id: string | null;
    fenix_eligible: boolean;
  };
  const shipments: PendingShipment[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data: rows, error: rowsError } = await admin
      .from("shipments")
      .select(`id,${FENIX_COVERAGE_COLUMNS},product,order_id,fenix_eligible`)
      .in("store_id", storeIds)
      .eq("status_category", "pending")
      .range(from, from + pageSize - 1);
    if (rowsError) throw new ElegibilidadError("leer las guías", rowsError);
    const page = (rows as PendingShipment[]) ?? [];
    shipments.push(...page);
    if (page.length < pageSize) break;
  }

  // Pull the linked orders' line items so eligibility can match against the
  // Shopify catalog (title + SKU) — the same source the stock sheet is keyed
  // on — instead of the Aliclik report's free-text product.
  const orderIds = Array.from(new Set(shipments.map((s) => s.order_id).filter((v): v is string => !!v)));
  const productsByOrder = new Map<string, { title?: string | null; sku?: string | null }[]>();
  for (let i = 0; i < orderIds.length; i += 300) {
    const { data: orders, error: ordersError } = await admin
      .from("orders")
      .select("id,line_items")
      .in("id", orderIds.slice(i, i + 300));
    if (ordersError) throw new ElegibilidadError("leer los pedidos", ordersError);
    for (const o of (orders as { id: string; line_items: { title?: string | null; sku?: string | null }[] | null }[]) ?? []) {
      productsByOrder.set(
        o.id,
        (o.line_items ?? []).map((li) => ({ title: li.title ?? null, sku: li.sku ?? null })),
      );
    }
  }

  const toEligible: string[] = [];
  const toIneligible: string[] = [];
  for (const s of shipments) {
    const orderProducts = s.order_id ? productsByOrder.get(s.order_id) : undefined;
    const eligible = evaluateFenix(coverageInputOf(s), stockRows, orderProducts).eligible;
    if (eligible !== s.fenix_eligible) {
      (eligible ? toEligible : toIneligible).push(s.id);
    }
  }

  // Update in bounded groups instead of one network round-trip per guide.
  for (const [eligible, ids] of [
    [true, toEligible],
    [false, toIneligible],
  ] as const) {
    for (let i = 0; i < ids.length; i += 150) {
      const { error: updateError } = await admin
        .from("shipments")
        .update({ fenix_eligible: eligible })
        .in("id", ids.slice(i, i + 150));
      if (updateError) throw new ElegibilidadError("recalcular la cobertura Swayp", updateError);
    }
  }
  return toEligible.length + toIneligible.length;
}
