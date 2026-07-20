// RLS-scoped reads for the Envíos module. Mirrors lib/leads-access.ts: queue
// listing by view, counts, and a shipment + call-history detail loader.

import { createServerSupabase } from "@/lib/db";
import type {
  LinkedShipmentSummary,
  ShipmentCallRow,
  ShipmentHistoryGuide,
  ShipmentOrderDetail,
  ShipmentRow,
} from "@/lib/types";
import { evaluateFenix, type FenixStockRow } from "@/lib/fenix";
import {
  computeReprogramStats,
  limaCalendarDayBounds,
  type ReprogramChildRow,
  type ReprogramStats,
} from "@/lib/shipments";
import { chunk } from "@/lib/access";
import { resolveEmails } from "@/lib/productivity";
import { shopifyShippingAddress } from "@/lib/shopify-address";
import {
  buildShipmentLineage,
  type ShipmentLineageNode,
} from "@/lib/shipment-lineage";

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
  "id,store_id,courier,guide_code,delivery_status,status_category,order_id,matched,match_method,order_name,customer_name,customer_phone,product,district,province,city,region,delivery_address,delivery_reference,latitude,longitude,address_override,address_updated_at,address_updated_by,fenix_eligible,fenix_shipment_id,delivered_source,aliclik_attempts,aliclik_service_date,reroute_attempts,reroute_outcome,claimed_by,claimed_at,next_followup_at,source_batch_id,last_report_at,suggested_order_gid,suggested_store_id,suggested_order_name,created_at,updated_at";

// Deployment safety: application deploys and database migrations are separate
// operations in production. Keep queue reads alive while 0038 is being applied;
// otherwise PostgREST rejects the whole select and every tab appears empty even
// though the count queries still show rows.
const LEGACY_SHIPMENT_COLUMNS =
  "id,store_id,courier,guide_code,delivery_status,status_category,order_id,matched,match_method,order_name,customer_name,customer_phone,product,district,city,region,fenix_eligible,fenix_shipment_id,delivered_source,reroute_attempts,reroute_outcome,claimed_by,claimed_at,next_followup_at,source_batch_id,last_report_at,suggested_order_gid,suggested_store_id,suggested_order_name,created_at,updated_at";

const SHIPMENT_LIST_COLUMNS = `${SHIPMENT_COLUMNS},shipment_calls(count)`;
const LEGACY_SHIPMENT_LIST_COLUMNS = `${LEGACY_SHIPMENT_COLUMNS},shipment_calls(count)`;

type ShipmentWithCallCount = ShipmentRow & {
  shipment_calls?: { count: number | null }[] | null;
};

function withContactCount(row: ShipmentWithCallCount): ShipmentRow {
  const { shipment_calls: calls, ...shipment } = row;
  return withEnhancementDefaults({ ...shipment, contact_count: calls?.[0]?.count ?? 0 });
}

function withEnhancementDefaults(row: Partial<ShipmentRow>): ShipmentRow {
  return {
    delivery_address: null,
    delivery_reference: null,
    latitude: null,
    longitude: null,
    address_override: false,
    address_updated_at: null,
    address_updated_by: null,
    aliclik_attempts: null,
    aliclik_service_date: null,
    ...row,
    province: row.province ?? row.region ?? null,
  } as ShipmentRow;
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
    );
    return {
      ...shipment,
      fenix_eligible: current.eligible,
      fenix_reason: current.reason,
    };
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
    const fetchPage = (columns: string) => {
      let query = sb
        .from("shipments")
        .select(columns)
        .in("store_id", storeIds)
        .in("status_category", cats)
        .eq("shipment_calls.kind", "call");
      query =
        view === "pendiente"
          ? query.order("next_followup_at", { ascending: true, nullsFirst: true }).order("updated_at", { ascending: false })
          : query.order("updated_at", { ascending: false });
      return query.range(from, from + PAGE - 1);
    };
    let page = await fetchPage(SHIPMENT_LIST_COLUMNS);
    if (page.error) page = await fetchPage(LEGACY_SHIPMENT_LIST_COLUMNS);
    if (page.error) break;
    const rows = ((page.data as unknown as ShipmentWithCallCount[]) ?? []).map(withContactCount);
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
    withEligibility.map((shipment) => [shipment.id, {
      eligible: shipment.fenix_eligible,
      reason: shipment.fenix_reason,
    }]),
  );
  return withTodayCalls.map((shipment) => {
    const eligibility = eligibilityById.get(shipment.id);
    return {
      ...shipment,
      fenix_eligible: eligibility?.eligible ?? shipment.fenix_eligible,
      fenix_reason: eligibility?.reason,
    };
  });
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
  const fetchRows = (columns: string) => sb
    .from("shipments")
    .select(columns)
    .in("store_id", storeIds)
    .eq("matched", false)
    .in("status_category", REVIEW_CATEGORIES)
    .or("match_method.is.null,match_method.neq.dismissed")
    .order("created_at", { ascending: false })
    .limit(1000);
  let result = await fetchRows(SHIPMENT_COLUMNS);
  if (result.error) result = await fetchRows(LEGACY_SHIPMENT_COLUMNS);
  const rows = ((result.data as unknown as ShipmentRow[]) ?? []).map(withEnhancementDefaults);
  return withCurrentFenixEligibility(sb, rows);
}

/** Global search across all accessible shipments (RLS-scoped) by guide code
 *  (aliclik OR fenix), order name (#KP…) or customer phone. */
export async function searchShipmentsQuery(query: string): Promise<ShipmentRow[]> {
  const q = query.trim().replace(/[,()*%]/g, ""); // strip chars that break the or() filter
  if (q.length < 2) return [];
  const sb = await createServerSupabase();
  const like = `%${q}%`;
  const fetchRows = (columns: string) => sb
    .from("shipments")
    .select(columns)
    .or(`guide_code.ilike.${like},order_name.ilike.${like},customer_phone.ilike.${like}`)
    .order("updated_at", { ascending: false })
    .limit(50);
  let result = await fetchRows(SHIPMENT_COLUMNS);
  if (result.error) result = await fetchRows(LEGACY_SHIPMENT_COLUMNS);
  const rows = ((result.data as unknown as ShipmentRow[]) ?? []).map(withEnhancementDefaults);
  return withCurrentFenixEligibility(sb, rows);
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
const LINEAGE_COLUMNS =
  "id,courier,guide_code,delivery_status,status_category,fenix_shipment_id,created_at";

function toLineageNode(shipment: ShipmentRow): ShipmentLineageNode {
  return {
    id: shipment.id,
    courier: shipment.courier,
    guide_code: shipment.guide_code,
    delivery_status: shipment.delivery_status,
    status_category: shipment.status_category,
    fenix_shipment_id: shipment.fenix_shipment_id,
    created_at: shipment.created_at ?? null,
  };
}

async function getShipmentLineage(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  shipment: ShipmentRow,
): Promise<ShipmentLineageNode[]> {
  let candidates: ShipmentLineageNode[] = [];
  let candidateLookupSucceeded = false;
  if (shipment.order_id) {
    const { data, error } = await sb
      .from("shipments")
      .select(LINEAGE_COLUMNS)
      .eq("order_id", shipment.order_id)
      .limit(100);
    candidates = (data as ShipmentLineageNode[]) ?? [];
    candidateLookupSucceeded = !error;
  } else if (shipment.order_name) {
    const { data, error } = await sb
      .from("shipments")
      .select(LINEAGE_COLUMNS)
      .eq("store_id", shipment.store_id)
      .eq("order_name", shipment.order_name)
      .limit(100);
    candidates = (data as ShipmentLineageNode[]) ?? [];
    candidateLookupSucceeded = !error;
  }

  const currentNode = toLineageNode(shipment);
  if (!candidates.some((candidate) => candidate.id === currentNode.id)) {
    candidates.push(currentNode);
  }
  let lineage = buildShipmentLineage(candidates, shipment.id);
  if (lineage.length > 1 || candidateLookupSucceeded) return lineage;

  // Rare unmatched rows can have neither an order id nor an order name. Follow
  // their explicit links directly; the chain is capped to avoid malformed loops.
  const seen = new Set<string>([shipment.id]);
  const ancestors: ShipmentLineageNode[] = [];
  let childId = shipment.id;
  for (let depth = 0; depth < 29; depth += 1) {
    const { data } = await sb
      .from("shipments")
      .select(LINEAGE_COLUMNS)
      .eq("fenix_shipment_id", childId)
      .limit(1);
    const parent = ((data as ShipmentLineageNode[]) ?? [])[0];
    if (!parent || seen.has(parent.id)) break;
    ancestors.unshift(parent);
    seen.add(parent.id);
    childId = parent.id;
  }

  const descendants: ShipmentLineageNode[] = [];
  let cursor = currentNode;
  for (let depth = 0; depth < 29 - ancestors.length; depth += 1) {
    if (!cursor.fenix_shipment_id || seen.has(cursor.fenix_shipment_id)) break;
    const { data } = await sb
      .from("shipments")
      .select(LINEAGE_COLUMNS)
      .eq("id", cursor.fenix_shipment_id)
      .maybeSingle();
    const child = data as ShipmentLineageNode | null;
    if (!child) break;
    descendants.push(child);
    seen.add(child.id);
    cursor = child;
  }
  lineage = [...ancestors, currentNode, ...descendants];
  return lineage;
}

export async function getShipmentWithCalls(
  shipmentId: string,
): Promise<{
  shipment: ShipmentRow;
  calls: ShipmentCallRow[];
  guideHistory: ShipmentHistoryGuide[];
  order: ShipmentOrderDetail | null;
  linkedFenixShipment: LinkedShipmentSummary | null;
} | null> {
  const sb = await createServerSupabase();
  const fetchShipment = (columns: string) => sb
    .from("shipments")
    .select(columns)
    .eq("id", shipmentId)
    .maybeSingle();
  let shipmentResult = await fetchShipment(SHIPMENT_COLUMNS);
  if (shipmentResult.error) shipmentResult = await fetchShipment(LEGACY_SHIPMENT_COLUMNS);
  const shipment = shipmentResult.data;
  if (!shipment) return null;
  const shipmentRow = withEnhancementDefaults(shipment as Partial<ShipmentRow>);
  const lineage = await getShipmentLineage(sb, shipmentRow);
  const lineageIds = lineage.map((guide) => guide.id);
  const { data: historyCalls } = await sb
    .from("shipment_calls")
    .select("id,shipment_id,store_id,agent,kind,new_status,note,next_followup_at,occurred_at")
    .in("shipment_id", lineageIds)
    .order("occurred_at", { ascending: true });
  const callsByShipment = new Map<string, ShipmentCallRow[]>();
  for (const call of (historyCalls as ShipmentCallRow[]) ?? []) {
    const guideCalls = callsByShipment.get(call.shipment_id) ?? [];
    guideCalls.push(call);
    callsByShipment.set(call.shipment_id, guideCalls);
  }
  const guideHistory: ShipmentHistoryGuide[] = lineage.map((guide) => ({
    id: guide.id,
    courier: guide.courier,
    guide_code: guide.guide_code,
    delivery_status: guide.delivery_status,
    status_category: guide.status_category,
    fenix_shipment_id: guide.fenix_shipment_id,
    created_at: guide.created_at ?? null,
    is_current: guide.id === shipmentId,
    calls: callsByShipment.get(guide.id) ?? [],
  }));
  const calls = [...(callsByShipment.get(shipmentId) ?? [])].reverse();
  let order: ShipmentOrderDetail | null = null;
  let linkedFenixShipment: LinkedShipmentSummary | null = null;
  if (shipmentRow.order_id) {
    const { data } = await sb
      .from("orders")
      .select("name,shopify_order_id,line_items,raw")
      .eq("id", shipmentRow.order_id)
      .maybeSingle();
    const orderRow = data as (Omit<ShipmentOrderDetail, "shipping_address"> & { raw?: unknown }) | null;
    if (orderRow) {
      let shippingAddress = shopifyShippingAddress(orderRow.raw);
      // COD apps often create a DraftOrder first. Older order syncs could omit
      // shippingAddress when Shopify rejected protected phone fields, while the
      // completed draft still retained the full destination locally.
      if (!shippingAddress && orderRow.shopify_order_id) {
        const { data: draft } = await sb
          .from("draft_orders")
          .select("address1,referencia,district,province,customer_name,customer_phone")
          .eq("order_gid", `gid://shopify/Order/${orderRow.shopify_order_id}`)
          .maybeSingle();
        const draftAddress = draft as {
          address1?: string | null;
          referencia?: string | null;
          district?: string | null;
          province?: string | null;
          customer_name?: string | null;
          customer_phone?: string | null;
        } | null;
        if (draftAddress?.address1) {
          shippingAddress = {
            address1: draftAddress.address1,
            address2: draftAddress.referencia ?? null,
            city: draftAddress.district ?? null,
            province: draftAddress.province ?? null,
            name: draftAddress.customer_name ?? null,
            phone: draftAddress.customer_phone ?? null,
          };
        }
      }
      order = {
        name: orderRow.name,
        shopify_order_id: orderRow.shopify_order_id,
        line_items: orderRow.line_items ?? [],
        shipping_address: shippingAddress,
      };
    }
  }
  if (shipmentRow.fenix_shipment_id) {
    const child = lineage.find((guide) => guide.id === shipmentRow.fenix_shipment_id);
    linkedFenixShipment = child
      ? {
          id: child.id,
          courier: child.courier,
          guide_code: child.guide_code,
          delivery_status: child.delivery_status,
          status_category: child.status_category,
        }
      : null;
  }
  const [currentShipment] = await withCurrentFenixEligibility(sb, [shipmentRow]);
  return {
    shipment: currentShipment ?? shipmentRow,
    calls,
    guideHistory,
    order,
    linkedFenixShipment,
  };
}


/**
 * Métricas de reprogramación Kapso→Fénix: junta las guías Fénix HIJAS (las que
 * nació cada reprogramación confirmada en el dashboard, vía fenix_shipment_id)
 * y las agrega con computeReprogramStats. RLS-scoped; paginado + chunked para
 * ser inmune al tope de ~1000 filas de PostgREST.
 */
/** Filas crudas de las guías Fénix hijas (reprogramaciones) con su asesor +
 *  nombres resueltos, para recomputar cortes por rango en el cliente. */
export async function getReprogramRows(
  storeIds: string[],
): Promise<{ rows: ReprogramChildRow[]; asesorNames: Record<string, string> }> {
  const built = await buildReprogramRows(storeIds);
  return built;
}

export async function getReprogramStats(storeIds: string[]): Promise<ReprogramStats> {
  const { rows, asesorNames } = await buildReprogramRows(storeIds);
  const stats = computeReprogramStats(rows, Date.now());
  stats.asesorNames = asesorNames;
  return stats;
}

async function buildReprogramRows(
  storeIds: string[],
): Promise<{ rows: ReprogramChildRow[]; asesorNames: Record<string, string> }> {
  const sb = await createServerSupabase();
  // Padres con guía Fénix: id (para atribuir el asesor) + child id (métricas).
  const parentToChild = new Map<string, string>(); // parentId → childId
  for (let from = 0; from < 20_000; from += 1000) {
    const { data, error } = await sb
      .from("shipments")
      .select("id, fenix_shipment_id")
      .in("store_id", storeIds)
      .not("fenix_shipment_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) break;
    const batch = (data as { id: string; fenix_shipment_id: string | null }[]) ?? [];
    for (const r of batch) if (r.fenix_shipment_id) parentToChild.set(r.id, r.fenix_shipment_id);
    if (batch.length < 1000) break;
  }
  const childIds = [...parentToChild.values()];
  const childToParent = new Map<string, string>();
  for (const [p, c] of parentToChild) childToParent.set(c, p);

  // Asesor que confirmó cada reprogramación: el log kind='reroute' ("Guía Fénix
  // creada") queda en el PADRE con el agente. Un padre puede tener más de un log
  // (reintentos); nos quedamos con el primero con agente.
  const agentByParent = new Map<string, string>();
  for (const part of chunk([...parentToChild.keys()], 300)) {
    const { data } = await sb
      .from("shipment_calls")
      .select("shipment_id, agent, occurred_at")
      .in("shipment_id", part)
      .eq("kind", "reroute")
      .not("agent", "is", null)
      .order("occurred_at", { ascending: true });
    for (const r of (data as { shipment_id: string; agent: string | null }[]) ?? []) {
      if (r.agent && !agentByParent.has(r.shipment_id)) agentByParent.set(r.shipment_id, r.agent);
    }
  }

  const rows: ReprogramChildRow[] = [];
  for (const part of chunk(childIds, 300)) {
    const { data } = await sb
      .from("shipments")
      .select("id, store_id, created_at, delivery_status")
      .in("id", part);
    for (const r of (data as { id: string; store_id: string | null; created_at: string | null; delivery_status: string }[]) ?? []) {
      const parentId = childToParent.get(r.id);
      rows.push({
        storeId: r.store_id,
        createdAt: r.created_at,
        status: r.delivery_status,
        agent: parentId ? agentByParent.get(parentId) ?? null : null,
      });
    }
  }

  // Resolver nombres de los asesores presentes (emails, como en Productividad).
  const agentIds = [...new Set(rows.map((r) => r.agent).filter((a): a is string => !!a))];
  let asesorNames: Record<string, string> = {};
  if (agentIds.length) {
    const emails = await resolveEmails(agentIds);
    asesorNames = Object.fromEntries(agentIds.map((id) => [id, emails.get(id) ?? id]));
  }
  return { rows, asesorNames };
}
