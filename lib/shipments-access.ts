// RLS-scoped reads for the Envíos module. Mirrors lib/leads-access.ts: queue
// listing by view, counts, and a shipment + call-history detail loader.

import { createServerSupabase } from "@/lib/db";
import type { ShipmentCallRow, ShipmentRow } from "@/lib/types";

// The manual-review queue: guides that didn't auto-link to an order AND still
// need a human. We exclude terminal states (delivered/closed) and rows dismissed
// as "sin pedido" (match_method='dismissed'). Driven off `shipments` so it
// dedupes by guide and reflects the latest re-import.
const REVIEW_CATEGORIES = ["pending", "in_route"];

function isReviewShipment(r: {
  matched: boolean;
  status_category: string;
  match_method: string | null;
}): boolean {
  return (
    !r.matched &&
    r.match_method !== "dismissed" &&
    REVIEW_CATEGORIES.includes(r.status_category)
  );
}

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
  "id,store_id,courier,guide_code,delivery_status,status_category,order_id,matched,match_method,order_name,customer_name,customer_phone,product,district,city,region,fenix_eligible,fenix_shipment_id,delivered_source,reroute_attempts,reroute_outcome,claimed_by,claimed_at,next_followup_at,source_batch_id,last_report_at,created_at,updated_at";

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

/** Shipments for a view across the given (accessible) stores. */
export async function getStoreShipments(
  storeIds: string[],
  view: ShipmentView,
): Promise<ShipmentRow[]> {
  if (!storeIds.length || view === "revision") return [];
  const sb = await createServerSupabase();
  const cats = VIEW_CATEGORIES[view];
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
  const { data } = await q.limit(2000);
  return (data as ShipmentRow[]) ?? [];
}

/** Tally shipments into the view buckets (for tab badges). */
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
  const { data } = await sb
    .from("shipments")
    .select("status_category,matched,match_method")
    .in("store_id", storeIds)
    .limit(20000);
  for (const r of (data as { status_category: string; matched: boolean; match_method: string | null }[]) ?? []) {
    if (r.status_category === "pending") out.pendiente += 1;
    else if (r.status_category === "in_route") out.en_ruta += 1;
    else if (r.status_category === "delivered") out.entregado += 1;
    else if (r.status_category === "closed") out.anulado += 1;
    // revisión: unmatched, non-terminal guides still needing a human
    if (isReviewShipment(r)) out.revision += 1;
  }
  return out;
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
