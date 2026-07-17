// RLS-scoped reads for the Envíos module. Mirrors lib/leads-access.ts: queue
// listing by view, counts, and a shipment + call-history detail loader.

import { createServerSupabase } from "@/lib/db";
import type { ShipmentCallRow, ShipmentOrderDetail, ShipmentRow } from "@/lib/types";
import { evaluateFenix, type FenixStockRow } from "@/lib/fenix";
import { limaCalendarDayBounds } from "@/lib/shipments";

// The manual-review queue: guides that didn't auto-link to an order AND still
// need a human. We exclude terminal states (delivered/closed) and rows dismissed
// as "sin pedido" (match_method='dismissed'). Driven off `shipments` so it
// dedupes by guide and reflects the latest re-import.
const REVIEW_CATEGORIES = ["pending", "in_route"];

export type ShipmentView =
  | "pendiente"
  | "en_ruta"
  | "entregado"
  | "anulado"
  | "transferido"
  | "revision";

export const SHIPMENT_VIEWS: { key: ShipmentView; label: string }[] = [
  { key: "pendiente", label: "Pendiente" },
  { key: "en_ruta", label: "En ruta" },
  { key: "entregado", label: "Entregado" },
  { key: "anulado", label: "Anulado" },
  { key: "transferido", label: "Transferido" },
  { key: "revision", label: "Revisión" },
];

export function isShipmentView(v: string | undefined | null): v is ShipmentView {
  return !!v && SHIPMENT_VIEWS.some((s) => s.key === v);
}

const SHIPMENT_COLUMNS =
  "id,store_id,courier,guide_code,delivery_status,status_category,order_id,matched,match_method,order_name,customer_name,customer_phone,product,district,city,region,fenix_eligible,fenix_shipment_id,delivered_source,reroute_attempts,reroute_outcome,claimed_by,claimed_at,next_followup_at,source_batch_id,last_report_at,suggested_order_gid,suggested_store_id,suggested_order_name,created_at,updated_at";

const SHIPMENT_LIST_COLUMNS = `${SHIPMENT_COLUMNS},shipment_calls(count)`;

type ShipmentWithCallCount = ShipmentRow & {
  shipment_calls?: { count: number | null }[] | null;
};

function withContactCount(row: ShipmentWithCallCount): ShipmentRow {
  const { shipment_calls: calls, ...shipment } = row;
  return { ...shipment, contact_count: calls?.[0]?.count ?? 0 };
}

/** Attach today's team-wide call count to each queue row. This is deliberately
 * a separate read from the lifetime nested count so both filters can coexist. */
async function withTodayContactCount(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  rows: ShipmentRow[],
  storeIds: string[],
): Promise<ShipmentRow[]> {
  if (!rows.length) return rows;
  const { startIso, endIso } = limaCalendarDayBounds();
  const countByShipment = new Map<string, number>();

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("shipment_calls")
      .select("id,shipment_id")
      .in("store_id", storeIds)
      .eq("kind", "call")
      .gte("occurred_at", startIso)
      .lt("occurred_at", endIso)
      .order("occurred_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) {
      // Conservative fallback: avoid duplicate calls if the daily read fails.
      return rows.map((row) => ({
        ...row,
        today_contact_count: row.contact_count ?? 0,
      }));
    }

    const calls = (data as { id: string; shipment_id: string }[]) ?? [];
    for (const call of calls) {
      countByShipment.set(call.shipment_id, (countByShipment.get(call.shipment_id) ?? 0) + 1);
    }
    if (calls.length < PAGE) break;
  }

  return rows.map((row) => ({
    ...row,
    today_contact_count: countByShipment.get(row.id) ?? 0,
  }));
}

/** Resolve eligibility from current stock for every returned pending guide.
 * The database flag remains useful as a cache, but reads must not show a stale
 * “Elegible” after stock reaches zero or is deleted. Stock is grouped by org so
 * users with access to more than one organization never cross-match inventory. */
async function withCurrentFenixEligibility(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  rows: ShipmentRow[],
): Promise<ShipmentRow[]> {
  const pending = rows.filter((s) => s.status_category === "pending");
  if (!pending.length) return rows;

  const storeIds = Array.from(new Set(pending.map((s) => s.store_id)));
  const { data: stores, error: storesError } = await sb
    .from("stores")
    .select("id,org_id")
    .in("id", storeIds);
  if (storesError) return rows;
  const orgByStore = new Map(
    ((stores as { id: string; org_id: string }[]) ?? []).map((s) => [s.id, s.org_id]),
  );
  const orgIds = Array.from(new Set(orgByStore.values()));
  if (!orgIds.length) return rows;

  const stockPromise = sb
    .from("fenix_stock")
    .select("org_id,city,product,sku,quantity")
    .in("org_id", orgIds);
  const orderIds = Array.from(
    new Set(pending.map((s) => s.order_id).filter((id): id is string => !!id)),
  );
  const orderParts = Array.from(
    { length: Math.ceil(orderIds.length / 300) },
    (_, index) => orderIds.slice(index * 300, index * 300 + 300),
  );
  const orderPagesPromise = Promise.all(
    orderParts.map((part) =>
      sb.from("orders").select("id,line_items").in("id", part),
    ),
  );
  const [{ data: stock, error: stockError }, orderPages] = await Promise.all([
    stockPromise,
    orderPagesPromise,
  ]);
  if (stockError || orderPages.some((page) => !!page.error)) return rows;

  const stockByOrg = new Map<string, FenixStockRow[]>();
  for (const item of (stock as (FenixStockRow & { org_id: string })[]) ?? []) {
    const group = stockByOrg.get(item.org_id) ?? [];
    group.push(item);
    stockByOrg.set(item.org_id, group);
  }

  const productsByOrder = new Map<
    string,
    { title?: string | null; sku?: string | null }[]
  >();
  for (const { data: orders } of orderPages) {
    for (const order of
      (orders as {
        id: string;
        line_items: { title?: string | null; sku?: string | null }[] | null;
      }[]) ?? []) {
      productsByOrder.set(
        order.id,
        (order.line_items ?? []).map((item) => ({
          title: item.title ?? null,
          sku: item.sku ?? null,
        })),
      );
    }
  }

  return rows.map((shipment) => {
    if (shipment.status_category !== "pending") return shipment;
    const orgId = orgByStore.get(shipment.store_id);
    const current = evaluateFenix(
      shipment,
      orgId ? stockByOrg.get(orgId) ?? [] : [],
      shipment.order_id ? productsByOrder.get(shipment.order_id) : undefined,
    ).eligible;
    return current === shipment.fenix_eligible
      ? shipment
      : { ...shipment, fenix_eligible: current };
  });
}

// Each view maps to a status_category filter. Every non-delivered guide lands in
// "pendiente"; fenix_eligible is shown as a per-row indicator, it does NOT split
// the queue.
const VIEW_CATEGORIES: Record<ShipmentView, string[]> = {
  pendiente: ["pending"],
  en_ruta: ["in_route"],
  entregado: ["delivered"],
  anulado: ["closed"],
  transferido: ["transferred"],
  revision: [], // special-cased: unmatched guides
};

// PostgREST caps a single response at its `db-max-rows` (1000 on Supabase by
// default), so we paginate with .range() instead of a big .limit().
const PAGE = 1000;
const MAX_LIST = 5000;

/** Shipments for a view across the given (accessible) stores. */
export async function getStoreShipments(
  storeIds: string[],
  view: ShipmentView,
): Promise<ShipmentRow[]> {
  if (!storeIds.length || view === "revision") return [];
  const sb = await createServerSupabase();
  const cats = VIEW_CATEGORIES[view];
  const out: ShipmentRow[] = [];
  for (let from = 0; from < MAX_LIST; from += PAGE) {
    let q = sb
      .from("shipments")
      .select(SHIPMENT_LIST_COLUMNS)
      .in("store_id", storeIds)
      .in("status_category", cats)
      .eq("shipment_calls.kind", "call");
    // pending is the single managed queue: soonest follow-up first; others recent
    q =
      view === "pendiente"
        ? q.order("next_followup_at", { ascending: true, nullsFirst: true }).order("updated_at", { ascending: false })
        : q.order("updated_at", { ascending: false });
    const { data } = await q.range(from, from + PAGE - 1);
    const rows = ((data as ShipmentWithCallCount[]) ?? []).map(withContactCount);
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  if (view !== "pendiente") return out;

  // Today's contacts and current Fenix eligibility are independent enrichments.
  // Run them together, then merge the one field produced by the stock read.
  const [withTodayCalls, withEligibility] = await Promise.all([
    withTodayContactCount(sb, out, storeIds),
    withCurrentFenixEligibility(sb, out),
  ]);
  const eligibilityById = new Map(
    withEligibility.map((shipment) => [shipment.id, shipment.fenix_eligible]),
  );
  return withTodayCalls.map((shipment) => ({
    ...shipment,
    fenix_eligible: eligibilityById.get(shipment.id) ?? shipment.fenix_eligible,
  }));
}

/** Count of shipments matching a category set (exact, not row-capped). */
async function countByCategory(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  storeIds: string[],
  cats: string[],
): Promise<number> {
  const { count } = await sb
    .from("shipments")
    .select("id", { count: "exact", head: true })
    .in("store_id", storeIds)
    .in("status_category", cats);
  return count ?? 0;
}

/** Tally shipments into the view buckets (for tab badges). Uses exact COUNT
 *  queries (head-only) so the totals are never truncated by the row cap. */
export async function getShipmentCounts(
  storeIds: string[],
): Promise<Record<ShipmentView, number>> {
  const out: Record<ShipmentView, number> = {
    pendiente: 0,
    en_ruta: 0,
    entregado: 0,
    anulado: 0,
    transferido: 0,
    revision: 0,
  };
  if (!storeIds.length) return out;
  const sb = await createServerSupabase();
  const [revision, pendiente, en_ruta, entregado, anulado, transferido] = await Promise.all([
    (async () => {
      const { count } = await sb
        .from("shipments")
        .select("id", { count: "exact", head: true })
        .in("store_id", storeIds)
        .eq("matched", false)
        .in("status_category", REVIEW_CATEGORIES)
        .or("match_method.is.null,match_method.neq.dismissed");
      return count ?? 0;
    })(),
    countByCategory(sb, storeIds, ["pending"]),
    countByCategory(sb, storeIds, ["in_route"]),
    countByCategory(sb, storeIds, ["delivered"]),
    countByCategory(sb, storeIds, ["closed"]),
    countByCategory(sb, storeIds, ["transferred"]),
  ]);
  return { pendiente, en_ruta, entregado, anulado, transferido, revision };
}

/** Unmatched shipments awaiting manual linking (the "Por revisar" queue). */
export async function getReviewShipments(storeIds: string[]): Promise<ShipmentRow[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("shipments")
    .select(SHIPMENT_COLUMNS)
    .in("store_id", storeIds)
    .eq("matched", false)
    .in("status_category", REVIEW_CATEGORIES)
    .or("match_method.is.null,match_method.neq.dismissed")
    .order("created_at", { ascending: false })
    .limit(1000);
  return withCurrentFenixEligibility(sb, (data as ShipmentRow[]) ?? []);
}

/** Global search across all accessible shipments (RLS-scoped) by guide code
 *  (aliclik OR fenix), order name (#KP…) or customer phone. */
export async function searchShipmentsQuery(query: string): Promise<ShipmentRow[]> {
  const q = query.trim().replace(/[,()*%]/g, ""); // strip chars that break the or() filter
  if (q.length < 2) return [];
  const sb = await createServerSupabase();
  const like = `%${q}%`;
  const { data } = await sb
    .from("shipments")
    .select(SHIPMENT_COLUMNS)
    .or(`guide_code.ilike.${like},order_name.ilike.${like},customer_phone.ilike.${like}`)
    .order("updated_at", { ascending: false })
    .limit(50);
  return withCurrentFenixEligibility(sb, (data as ShipmentRow[]) ?? []);
}

export interface OrderLinkCandidate {
  id: string;
  name: string | null;
  customer_phone: string | null;
  created_at: string | null;
}

/** Search accessible orders (RLS-scoped) by order name or phone, to manually
 *  link a shipment. `orders` has no customer-name column, so results are
 *  distinguished by order number + phone + date. */
export async function searchOrdersForLink(query: string): Promise<OrderLinkCandidate[]> {
  const q = query.trim().replace(/[,()*%]/g, "");
  if (q.length < 2) return [];
  const sb = await createServerSupabase();
  const like = `%${q}%`;
  const { data } = await sb
    .from("orders")
    .select("id,name,customer_phone,created_at")
    .or(`name.ilike.${like},customer_phone.ilike.${like}`)
    .order("created_at", { ascending: false })
    .limit(20);
  return (data as OrderLinkCandidate[]) ?? [];
}

/** A shipment + its call history (RLS-scoped). Drives the drawer. */
export async function getShipmentWithCalls(
  shipmentId: string,
): Promise<{
  shipment: ShipmentRow;
  calls: ShipmentCallRow[];
  order: ShipmentOrderDetail | null;
} | null> {
  const sb = await createServerSupabase();
  const { data: shipment } = await sb
    .from("shipments")
    .select(SHIPMENT_COLUMNS)
    .eq("id", shipmentId)
    .maybeSingle();
  if (!shipment) return null;
  const { data: calls } = await sb
    .from("shipment_calls")
    .select("id,shipment_id,store_id,agent,kind,new_status,note,next_followup_at,occurred_at")
    .eq("shipment_id", shipmentId)
    .order("occurred_at", { ascending: false });
  const shipmentRow = shipment as ShipmentRow;
  let order: ShipmentOrderDetail | null = null;
  if (shipmentRow.order_id) {
    const { data } = await sb
      .from("orders")
      .select("name,line_items")
      .eq("id", shipmentRow.order_id)
      .maybeSingle();
    const orderRow = data as ShipmentOrderDetail | null;
    if (orderRow) {
      order = { name: orderRow.name, line_items: orderRow.line_items ?? [] };
    }
  }
  const [currentShipment] = await withCurrentFenixEligibility(sb, [shipmentRow]);
  return {
    shipment: currentShipment ?? shipmentRow,
    calls: (calls as ShipmentCallRow[]) ?? [],
    order,
  };
}
