import { createServerSupabase } from "@/lib/db";
import { getAccessibleStores, getAdminOrgs } from "@/lib/access";
import { EmptyState } from "@/components/ui";
import { FenixStockEditor } from "@/components/fenix-stock";
import { buildFenixDemand, type DemandShipment } from "@/lib/fenix-demand";
import type { FenixStockRowDb, OrderLineItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function FenixStockPage() {
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("fenix_stock")
    .select("id,org_id,city,product,sku,quantity,updated_by,updated_at,created_at")
    .order("city")
    .order("product");
  const rows = (data as FenixStockRowDb[]) ?? [];

  const adminOrgs = await getAdminOrgs();
  const canEdit = adminOrgs.some((m) => m.role === "owner" || m.role === "admin");

  if (!rows.length && !canEdit) {
    return <EmptyState title="Sin stock de Fenix registrado" />;
  }

  // stores only source the product catalog for the picker (stock stays org-level)
  const stores = await getAccessibleStores();
  const storeIds = stores.map((s) => s.id);

  // Demand report: pending guides (what customers are asking for per province)
  // crossed with stock. Product identity prefers the linked Shopify order's
  // primary line item (same catalog the stock is keyed on).
  let demand: ReturnType<typeof buildFenixDemand> = [];
  if (storeIds.length) {
    const { data: pend } = await sb
      .from("shipments")
      .select("city,product,order_id")
      .in("store_id", storeIds)
      .eq("status_category", "pending");
    const pending = (pend as { city: string | null; product: string | null; order_id: string | null }[]) ?? [];

    const orderIds = Array.from(new Set(pending.map((p) => p.order_id).filter((v): v is string => !!v)));
    const primaryByOrder = new Map<string, { title: string | null; sku: string | null }>();
    for (let i = 0; i < orderIds.length; i += 300) {
      const { data: orders } = await sb
        .from("orders")
        .select("id,line_items")
        .in("id", orderIds.slice(i, i + 300));
      for (const o of (orders as { id: string; line_items: OrderLineItem[] | null }[]) ?? []) {
        const li = o.line_items?.[0];
        if (li) primaryByOrder.set(o.id, { title: li.title ?? null, sku: li.sku ?? null });
      }
    }

    const demandShipments: DemandShipment[] = pending.map((p) => ({
      city: p.city,
      product: p.product,
      orderProduct: p.order_id ? primaryByOrder.get(p.order_id) ?? null : null,
    }));
    demand = buildFenixDemand(rows, demandShipments);
  }

  return <FenixStockEditor rows={rows} canEdit={canEdit} stores={stores} demand={demand} />;
}
