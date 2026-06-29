// RLS-scoped reads for the Envíos module. Mirrors lib/leads-access.ts: queue
// listing by view, counts, and a shipment + call-history detail loader.

import { createServerSupabase } from "@/lib/db";
import type { ImportRowRow, ShipmentCallRow, ShipmentRow } from "@/lib/types";

export type ShipmentView =
  | "por_reprogramar"
  | "en_transito"
  | "entregados"
  | "devueltos"
  | "revision";

export const SHIPMENT_VIEWS: { key: ShipmentView; label: string }[] = [
  { key: "por_reprogramar", label: "Por reprogramar" },
  { key: "en_transito", label: "En tránsito" },
  { key: "entregados", label: "Entregados" },
  { key: "devueltos", label: "Devueltos" },
  { key: "revision", label: "Revisión" },
];

export function isShipmentView(v: string | undefined | null): v is ShipmentView {
  return !!v && SHIPMENT_VIEWS.some((s) => s.key === v);
}

const SHIPMENT_COLUMNS =
  "id,store_id,courier,guide_code,delivery_status,status_category,order_id,matched,match_method,order_name,customer_name,customer_phone,product,district,city,region,fenix_eligible,fenix_shipment_id,reroute_attempts,reroute_outcome,claimed_by,claimed_at,next_followup_at,source_batch_id,last_report_at,created_at,updated_at";

// Each view maps to a status_category filter (plus ordering). "por_reprogramar"
// covers the active failure + rerouting queue.
const VIEW_CATEGORIES: Record<ShipmentView, string[]> = {
  por_reprogramar: ["failure", "rerouting"],
  en_transito: ["in_transit"],
  entregados: ["delivered"],
  devueltos: ["closed"],
  revision: [], // special-cased: unresolved import rows
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
  // re-route queue: surface soonest follow-up first; others most recent first
  q =
    view === "por_reprogramar"
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
    por_reprogramar: 0,
    en_transito: 0,
    entregados: 0,
    devueltos: 0,
    revision: 0,
  };
  if (!storeIds.length) return out;
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("shipments")
    .select("status_category")
    .in("store_id", storeIds)
    .limit(20000);
  for (const r of (data as { status_category: string }[]) ?? []) {
    if (r.status_category === "failure" || r.status_category === "rerouting") out.por_reprogramar += 1;
    else if (r.status_category === "in_transit") out.en_transito += 1;
    else if (r.status_category === "delivered") out.entregados += 1;
    else if (r.status_category === "closed") out.devueltos += 1;
  }
  // revisión: import rows still needing a human
  const { count } = await sb
    .from("import_rows")
    .select("id", { count: "exact", head: true })
    .in("store_id", storeIds)
    .in("match_status", ["review", "unmatched"]);
  out.revision = count ?? 0;
  return out;
}

/** Import rows awaiting manual review/match. */
export async function getReviewRows(storeIds: string[]): Promise<ImportRowRow[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("import_rows")
    .select("id,batch_id,store_id,row_index,raw,parsed,match_status,shipment_id,error,created_at")
    .in("store_id", storeIds)
    .in("match_status", ["review", "unmatched"])
    .order("created_at", { ascending: false })
    .limit(1000);
  return (data as ImportRowRow[]) ?? [];
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
