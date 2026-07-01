// RLS-scoped reads for the Envíos module. Mirrors lib/leads-access.ts: queue
// listing by view, counts, and a shipment + call-history detail loader.

import { createServerSupabase } from "@/lib/db";
import type { ShipmentCallRow, ShipmentRow } from "@/lib/types";

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
  | "revision";

export const SHIPMENT_VIEWS: { key: ShipmentView; label: string }[] = [
  { key: "pendiente", label: "Pendiente" },
  { key: "en_ruta", label: "En ruta" },
  { key: "entregado", label: "Entregado" },
  { key: "anulado", label: "Anulado" },
  { key: "revision", label: "Revisión" },
];

export function isShipmentView(v: string | undefined | null): v is ShipmentView {
  return !!v && SHIPMENT_VIEWS.some((s) => s.key === v);
}

const SHIPMENT_COLUMNS =
  "id,store_id,courier,guide_code,delivery_status,status_category,order_id,matched,match_method,order_name,customer_name,customer_phone,product,district,city,region,fenix_eligible,fenix_shipment_id,delivered_source,reroute_attempts,reroute_outcome,claimed_by,claimed_at,next_followup_at,source_batch_id,last_report_at,suggested_order_gid,suggested_store_id,suggested_order_name,created_at,updated_at";

// Each view maps to a status_category filter. Every non-delivered guide lands in
// "pendiente"; fenix_eligible is shown as a per-row indicator, it does NOT split
// the queue.
const VIEW_CATEGORIES: Record<ShipmentView, string[]> = {
  pendiente: ["pending"],
  en_ruta: ["in_route"],
  entregado: ["delivered"],
  anulado: ["closed"],
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
      .select(SHIPMENT_COLUMNS)
      .in("store_id", storeIds)
      .in("status_category", cats);
    // pending is the single managed queue: soonest follow-up first; others recent
    q =
      view === "pendiente"
        ? q.order("next_followup_at", { ascending: true, nullsFirst: true }).order("updated_at", { ascending: false })
        : q.order("updated_at", { ascending: false });
    const { data } = await q.range(from, from + PAGE - 1);
    const rows = (data as ShipmentRow[]) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
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
    revision: 0,
  };
  if (!storeIds.length) return out;
  const sb = await createServerSupabase();
  const { count: revision } = await sb
    .from("shipments")
    .select("id", { count: "exact", head: true })
    .in("store_id", storeIds)
    .eq("matched", false)
    .in("status_category", REVIEW_CATEGORIES)
    .or("match_method.is.null,match_method.neq.dismissed");
  const [pendiente, en_ruta, entregado, anulado] = await Promise.all([
    countByCategory(sb, storeIds, ["pending"]),
    countByCategory(sb, storeIds, ["in_route"]),
    countByCategory(sb, storeIds, ["delivered"]),
    countByCategory(sb, storeIds, ["closed"]),
  ]);
  return { pendiente, en_ruta, entregado, anulado, revision: revision ?? 0 };
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
  return (data as ShipmentRow[]) ?? [];
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
  return (data as ShipmentRow[]) ?? [];
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
): Promise<{ shipment: ShipmentRow; calls: ShipmentCallRow[] } | null> {
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
  return { shipment: shipment as ShipmentRow, calls: (calls as ShipmentCallRow[]) ?? [] };
}
