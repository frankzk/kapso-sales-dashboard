// Liquidaciones 2 — lecturas para la pantalla del motorizado (MOM §30.9).
// Server-only. La hoja del motorizado se localiza por `sheets.config.rider_id`;
// las filas y observaciones se leen con la sesión del usuario (RLS 0171 le
// acota a su hoja) y los datos del pedido con el service role, acotados a los
// pedidos de SUS filas.

import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { shopifyShippingAddress } from "@/lib/shopify-address";
import { normalizeAlias } from "./statuses";
import { puntoOrder } from "./rider-cuaderno";
import type { DomainStatusRow, ObservationReason, ObservationRow, StatusAliasRow, StoredRow } from "./types";

export interface RiderSheet {
  id: string;
  org_id: string;
  domain_id: string;
  key: string;
  name: string;
  config: Record<string, unknown>;
}

export interface RiderOrderInfo {
  order_id: string;
  order_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  district: string | null;
  address: string | null;
  order_total: number | null;
  general_status: string;
  store_name: string | null;
}

export interface RiderDay {
  fecha: string;
  rows: StoredRow[];
  orders: Record<string, RiderOrderInfo>;
  openObservations: ObservationRow[];
}

export interface RiderVocabulary {
  statuses: DomainStatusRow[];
  /** Sugerencias para el datalist: etiquetas del dominio y alias con equivalente. */
  suggestions: string[];
  reasons: ObservationReason[];
}

/** La hoja de Reparto propio cuya ficha es este motorizado. Null si no hay. */
export async function getRiderSheet(riderId: string): Promise<RiderSheet | null> {
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("sheets")
    .select("id,org_id,domain_id,key,name,config")
    .eq("active", true)
    .filter("config->>rider_id", "eq", riderId)
    .limit(1)
    .maybeSingle();
  return (data as RiderSheet | null) ?? null;
}

export async function loadRiderDay(sheet: RiderSheet, fecha: string): Promise<RiderDay> {
  const sb = await createServerSupabase();
  const { data, error } = await sb
    .from("sheet_rows")
    .select("id,sheet_id,order_id,row_key,values,source,updated_at")
    .eq("sheet_id", sheet.id)
    .filter("values->>fecha", "eq", fecha)
    .limit(500);
  if (error) throw new Error(`No se pudo leer tu cuaderno: ${error.message}`);
  const rows = ((data ?? []) as StoredRow[]).sort(
    (a, b) => puntoOrder(a.values.punto as string) - puntoOrder(b.values.punto as string),
  );
  const orderIds = [...new Set(rows.map((r) => r.order_id).filter((id): id is string => Boolean(id)))];
  const [orders, observations] = await Promise.all([
    loadRiderOrders(orderIds),
    rows.length
      ? sb
          .from("sheet_observations")
          .select("*")
          .eq("sheet_id", sheet.id)
          .eq("status", "abierta")
          .in("row_id", rows.map((r) => r.id))
      : Promise.resolve({ data: [] as ObservationRow[] }),
  ]);
  return { fecha, rows, orders, openObservations: ((observations.data ?? []) as ObservationRow[]) };
}

/** Datos del pedido para pintar el punto. Service role, solo por ids conocidos. */
export async function loadRiderOrders(orderIds: readonly string[]): Promise<Record<string, RiderOrderInfo>> {
  const out: Record<string, RiderOrderInfo> = {};
  if (!orderIds.length) return out;
  const admin = createAdminSupabase();
  for (let i = 0; i < orderIds.length; i += 200) {
    const ids = orderIds.slice(i, i + 200);
    const [{ data: master }, { data: orders }] = await Promise.all([
      admin
        .from("order_master")
        .select("order_id,order_name,customer_name,customer_phone,district,order_total,general_status,stores(name)")
        .in("order_id", ids),
      admin.from("orders").select("id,raw").in("id", ids),
    ]);
    const rawById = new Map(((orders ?? []) as { id: string; raw: unknown }[]).map((o) => [o.id, o.raw]));
    for (const m of (master ?? []) as unknown as {
      order_id: string;
      order_name: string | null;
      customer_name: string | null;
      customer_phone: string | null;
      district: string | null;
      order_total: number | null;
      general_status: string;
      stores: { name: string } | null;
    }[]) {
      const addr = shopifyShippingAddress(rawById.get(m.order_id));
      out[m.order_id] = {
        order_id: m.order_id,
        order_name: m.order_name,
        customer_name: m.customer_name,
        customer_phone: m.customer_phone,
        district: m.district,
        address: addr ? [addr.address1, addr.address2].filter(Boolean).join(" ") || null : null,
        order_total: m.order_total === null ? null : Number(m.order_total),
        general_status: m.general_status,
        store_name: m.stores?.name ?? null,
      };
    }
  }
  return out;
}

export async function loadRiderVocabulary(sheet: RiderSheet): Promise<RiderVocabulary> {
  const sb = await createServerSupabase();
  const [{ data: statuses }, { data: aliases }, { data: reasons }] = await Promise.all([
    sb.from("sheet_domain_statuses").select("*").eq("domain_id", sheet.domain_id).eq("active", true).order("position"),
    sb.from("sheet_status_aliases").select("*").eq("sheet_id", sheet.id).not("status_code", "is", null),
    sb.from("sheet_observation_reasons").select("*").order("position"),
  ]);
  const statusRows = (statuses ?? []) as DomainStatusRow[];
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const s of statusRows) {
    const key = normalizeAlias(s.label);
    if (!seen.has(key)) {
      seen.add(key);
      suggestions.push(s.label);
    }
  }
  for (const a of (aliases ?? []) as StatusAliasRow[]) {
    if (!seen.has(a.alias)) {
      seen.add(a.alias);
      suggestions.push(a.alias);
    }
  }
  return { statuses: statusRows, suggestions, reasons: (reasons ?? []) as ObservationReason[] };
}

export interface RiderOrderCandidate {
  order_id: string;
  order_name: string;
  customer_name: string | null;
  district: string | null;
  order_total: number | null;
  store_name: string | null;
  general_status: string;
}

/** Búsqueda de pedidos para añadir un punto: por número o por nombre, en las tiendas de la org. */
export async function searchRiderOrders(orgId: string, query: string, limit = 8): Promise<RiderOrderCandidate[]> {
  const term = query.replace(/[%,]/g, "").trim();
  if (term.length < 3) return [];
  const admin = createAdminSupabase();
  const { data: stores } = await admin.from("stores").select("id").eq("org_id", orgId);
  const storeIds = ((stores ?? []) as { id: string }[]).map((s) => s.id);
  if (!storeIds.length) return [];
  const withHash = term.startsWith("#") ? term : `#${term}`;
  const { data } = await admin
    .from("order_master")
    .select("order_id,order_name,customer_name,district,order_total,general_status,stores(name)")
    .in("store_id", storeIds)
    .or(`order_name.ilike.%${withHash}%,customer_name.ilike.%${term}%`)
    .order("order_created_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as unknown as {
    order_id: string;
    order_name: string;
    customer_name: string | null;
    district: string | null;
    order_total: number | null;
    general_status: string;
    stores: { name: string } | null;
  }[]).map((m) => ({
    order_id: m.order_id,
    order_name: m.order_name,
    customer_name: m.customer_name,
    district: m.district,
    order_total: m.order_total === null ? null : Number(m.order_total),
    store_name: m.stores?.name ?? null,
    general_status: m.general_status,
  }));
}

export interface ManifestPackage {
  order_id: string;
  order_name: string | null;
  customer_name: string | null;
  store_name: string | null;
  order_total: number | null;
}

/** Paquetes del manifiesto de despacho del motorizado para una fecha, si lo hay. */
export async function loadRiderManifestPackages(orgId: string, riderId: string, fecha: string): Promise<ManifestPackage[]> {
  const admin = createAdminSupabase();
  const { data: manifests } = await admin
    .from("dispatch_manifests")
    .select("id")
    .eq("org_id", orgId)
    .eq("rider_id", riderId)
    .eq("route_date", fecha)
    .neq("state", "cancelled");
  const ids = ((manifests ?? []) as { id: string }[]).map((m) => m.id);
  if (!ids.length) return [];
  const { data: items } = await admin
    .from("dispatch_manifest_items")
    .select("shipment_id,removed_at,shipments(order_id)")
    .in("manifest_id", ids)
    .is("removed_at", null);
  const orderIds = [
    ...new Set(
      ((items ?? []) as unknown as { shipments: { order_id: string | null } | null }[])
        .map((i) => i.shipments?.order_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const orders = await loadRiderOrders(orderIds);
  return orderIds.map((id) => ({
    order_id: id,
    order_name: orders[id]?.order_name ?? null,
    customer_name: orders[id]?.customer_name ?? null,
    store_name: orders[id]?.store_name ?? null,
    order_total: orders[id]?.order_total ?? null,
  }));
}
