// Lecturas del Master de Pedidos, con RLS. Espeja lib/shipments-access.ts:
// listado por vista, conteos por pestaña y un cargador de detalle que arma la
// línea de tiempo completa.
//
// El listado sale de UNA sola tabla (`order_master`) porque ahí está todo
// denormalizado; el detalle sí lee tres tablas por `order_id` y las mezcla en
// TypeScript — son tres consultas pequeñas de un solo pedido, no hacen falta
// joins (que PostgREST tampoco daría).

import { createServerSupabase } from "@/lib/db";
import { chunk } from "@/lib/access";
import { resolveEmails } from "@/lib/productivity";
import { shopifyShippingAddress } from "@/lib/shopify-address";
import { evaluateDirectFenixStock, type FenixStockRow } from "@/lib/fenix";
import { deriveFenixCoverageCity } from "@/lib/shipments";
import {
  buildOrderRoutePlan,
  type OrderRoutePlan,
  type SwaypRouteCheck,
} from "@/lib/order-route-plan";
import type { AgencySummary } from "@/lib/order-master-filters";
import type {
  OrderEventRow,
  OrderLineItem,
  OrderMasterRow,
  ShipmentCallRow,
  ShipmentRow,
} from "@/lib/types";
import {
  ORDER_MACRO_STAGES,
  classifyOperation,
  type MacroSubstage,
  type OperationKind,
  type OrderMacroStage,
} from "@/lib/order-macro-stage";

export type MasterView = "todos" | OrderMacroStage;

export const MASTER_VIEWS: readonly { key: MasterView; label: string }[] = [
  { key: "todos", label: "Todos" },
  ...ORDER_MACRO_STAGES.map((stage) => ({ key: stage.code, label: stage.label })),
];

export function isMasterView(v: string | undefined | null): v is MasterView {
  return !!v && MASTER_VIEWS.some((s) => s.key === v);
}

const MASTER_COLUMNS =
  "id,store_id,order_id,order_name,shopify_order_id,order_created_at,customer_name," +
  "customer_phone,region,province,district,address,reference,latitude,longitude,geo_source," +
  "shipping_mode,order_total,general_status,operational_status," +
  "macro_stage,macro_substage,macro_reasons,macro_operation,macro_version,macro_since," +
  "status_since,status_source,status_locked,current_courier,last_courier," +
  "courier_count,attempt_count,guide_code,dispatched_at,delivered_at,delivered_courier," +
  "returned_at,last_movement_at,comment_count,logistics_cost,pickup_state,payment_state," +
  "key_state,agency_branch,agency_arrived_at,agency_expires_at,recomputed_at,updated_at";

/** Cantidad máxima que el navegador recibe y renderiza en una sola página. */
export const MASTER_PAGE_SIZE = 100;

/**
 * Cola del Master para las tiendas accesibles. Igual que en Repro Provincia, la
 * consulta abarca TODAS las tiendas accesibles y el filtro por tienda se aplica
 * en el board (es multi-selección y se combina con el resto).
 */
export async function getOrderMasterRows(
  storeIds: string[],
  view: MasterView = "todos",
  opts: { limit?: number; offset?: number; substage?: MacroSubstage | null } = {},
): Promise<OrderMasterRow[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const limit = Math.max(1, Math.min(opts.limit ?? MASTER_PAGE_SIZE, MASTER_PAGE_SIZE));
  const offset = Math.max(0, opts.offset ?? 0);
  let query = sb.from("order_master").select(MASTER_COLUMNS).in("store_id", storeIds);
  if (view !== "todos") query = query.eq("macro_stage", view);
  if (opts.substage) query = query.eq("macro_substage", opts.substage);

  const { data, error } = await query
    // Regla única del Master: pedidos más nuevos primero en todas las vistas.
    // `order_id` desempata para que la paginación no cambie entre consultas.
    .order("order_created_at", { ascending: false })
    .order("order_id", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return [];
  return (data ?? []) as unknown as OrderMasterRow[];
}

export interface MasterCounts {
  todos: number;
  por_confirmar: number;
  preparacion: number;
  por_despachar: number;
  en_curso: number;
  por_cerrar: number;
  finalizado: number;
}

export interface MasterMomCounts {
  stages: MasterCounts;
  substages: Partial<Record<MacroSubstage, number>>;
}

interface MasterCountRow {
  macro_stage: string | null;
  macro_substage: string | null;
  total: number | string;
}

function emptyMasterCounts(): MasterCounts {
  return {
    todos: 0,
    por_confirmar: 0,
    preparacion: 0,
    por_despachar: 0,
    en_curso: 0,
    por_cerrar: 0,
    finalizado: 0,
  };
}

/** Reduce el resultado agrupado del RPC a los contadores que consume la UI. */
export function reduceMasterMomCounts(rows: readonly MasterCountRow[]): MasterMomCounts {
  const stages = emptyMasterCounts();
  const substages: Partial<Record<MacroSubstage, number>> = {};
  for (const row of rows) {
    const total = Number(row.total) || 0;
    if (row.macro_stage && row.macro_stage in stages && row.macro_stage !== "todos") {
      stages[row.macro_stage as OrderMacroStage] += total;
      stages.todos += total;
    }
    if (row.macro_substage) {
      const key = row.macro_substage as MacroSubstage;
      substages[key] = (substages[key] ?? 0) + total;
    }
  }
  return { stages, substages };
}

/** Conteos exactos por pestaña, con consultas `head` (no traen filas). */
export async function getOrderMasterCounts(storeIds: string[]): Promise<MasterCounts> {
  const empty = emptyMasterCounts();
  if (!storeIds.length) return empty;
  const sb = await createServerSupabase();

  const countFor = async (stage: OrderMacroStage | null): Promise<number> => {
    let query = sb
      .from("order_master")
      .select("id", { count: "exact", head: true })
      .in("store_id", storeIds);
    if (stage) query = query.eq("macro_stage", stage);
    const { count, error } = await query;
    return error ? 0 : (count ?? 0);
  };

  const [todos, por_confirmar, preparacion, por_despachar, en_curso, por_cerrar, finalizado] = await Promise.all([
    countFor(null),
    countFor("por_confirmar"),
    countFor("preparacion"),
    countFor("por_despachar"),
    countFor("en_curso"),
    countFor("por_cerrar"),
    countFor("finalizado"),
  ]);
  return { todos, por_confirmar, preparacion, por_despachar, en_curso, por_cerrar, finalizado };
}

/**
 * Conteos exactos de todas las macroetapas y subetapas en una sola consulta.
 * Si la migración todavía no llegó al entorno, conserva los totales principales
 * con el mecanismo anterior para que el Master no deje de abrir.
 */
export async function getOrderMasterMomCounts(storeIds: string[]): Promise<MasterMomCounts> {
  if (!storeIds.length) return { stages: emptyMasterCounts(), substages: {} };
  const sb = await createServerSupabase();
  const { data, error } = await sb.rpc("order_master_mom_counts", { p_store_ids: storeIds });
  if (!error) return reduceMasterMomCounts((data ?? []) as MasterCountRow[]);
  return { stages: await getOrderMasterCounts(storeIds), substages: {} };
}

/** Resumen exacto de agencia, independiente de la página de 100 filas. */
export async function getOrderMasterAgencySummary(storeIds: string[]): Promise<AgencySummary> {
  const empty: AgencySummary = {
    total: 0,
    disponibles: 0,
    proximosAVencer: 0,
    retornoIniciado: 0,
    devueltos: 0,
  };
  if (!storeIds.length) return empty;
  const sb = await createServerSupabase();
  const { data, error } = await sb.rpc("order_master_agency_summary", { p_store_ids: storeIds });
  if (error || !Array.isArray(data) || !data[0]) return empty;
  const row = data[0] as Record<string, number | string | null>;
  return {
    total: Number(row.total) || 0,
    disponibles: Number(row.disponibles) || 0,
    proximosAVencer: Number(row.proximos_a_vencer) || 0,
    retornoIniciado: Number(row.retorno_iniciado) || 0,
    devueltos: Number(row.devueltos) || 0,
  };
}

/** Búsqueda global (código, guía, teléfono, cliente), fuera de la pestaña activa. */
export async function searchOrderMaster(query: string, limit = 50): Promise<OrderMasterRow[]> {
  const q = query.trim().replace(/^#/, "");
  if (q.length < 2) return [];
  const sb = await createServerSupabase();
  const like = `%${q}%`;
  const { data, error } = await sb
    .from("order_master")
    .select(MASTER_COLUMNS)
    .or(
      `order_name.ilike.${like},guide_code.ilike.${like},customer_phone.ilike.${like},customer_name.ilike.${like}`,
    )
    .order("order_created_at", { ascending: false })
    .order("order_id", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []) as unknown as OrderMasterRow[];
}

// ---------------------------------------------------------------------------
// Detalle: la línea de tiempo completa (§15)
// ---------------------------------------------------------------------------

/** Un movimiento ya normalizado para pintar la línea de tiempo. */
export interface TimelineEntry {
  id: string;
  occurredAt: string;
  kind: string;
  /** shopify | aliclik | fenix | shalom | olva | repro_provincia | report | manual | system */
  source: string;
  courier: string | null;
  guideCode: string | null;
  previousStatus: string | null;
  newStatus: string | null;
  note: string | null;
  reason: string | null;
  actorName: string | null;
  /** De dónde salió la entrada: el propio Master o una gestión de Repro Provincia. */
  origin: "master" | "gestion";
}

export interface OrderMasterDetail {
  row: OrderMasterRow;
  guides: ShipmentRow[];
  timeline: TimelineEntry[];
  lineItems: OrderLineItem[];
  address: ReturnType<typeof shopifyShippingAddress>;
  routePlan: OrderRoutePlan;
}

const GUIDE_COLUMNS =
  "id,store_id,courier,guide_code,delivery_status,status_category,order_id,matched," +
  "match_method,order_name,customer_name,customer_phone,product,district,province,city,region," +
  "delivery_address,delivery_reference,latitude,longitude,address_override,address_updated_at," +
  "address_updated_by,fenix_eligible,fenix_shipment_id,created_via,delivered_source," +
  "shalom_codigo,shalom_ose_id,shalom_order_id,shalom_serie,shalom_raw," +
  "aliclik_attempts,aliclik_service_date,reroute_attempts,reroute_outcome,claimed_by,claimed_at," +
  "next_followup_at,source_batch_id,last_report_at,suggested_order_gid,suggested_store_id," +
  "suggested_order_name,output_number,output_code,qr_token,preparation_state,custody_state," +
  "ready_at,ready_by,custody_transferred_at,custody_transferred_by,label_url,created_at,updated_at";

async function swaypRouteCheck(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  row: OrderMasterRow,
  lineItems: OrderLineItem[],
): Promise<SwaypRouteCheck> {
  const { data: store, error: storeError } = await sb
    .from("stores")
    .select("org_id")
    .eq("id", row.store_id)
    .maybeSingle();
  const orgId = (store as { org_id?: string } | null)?.org_id;
  if (storeError || !orgId) return { known: false };

  const { data, error } = await sb
    .from("fenix_stock")
    .select("city,product,sku,quantity")
    .eq("org_id", orgId);
  if (error) return { known: false };

  const city = deriveFenixCoverageCity(row.district, row.region);
  const check = evaluateDirectFenixStock(
    city,
    ((data ?? []) as FenixStockRow[]),
    lineItems.map((item) => ({
      title: item.title,
      sku: item.sku ?? null,
      quantity: item.quantity,
    })),
  );
  return {
    known: true,
    city: check.city,
    covered: check.reason !== "sin_cobertura",
    stockOk: check.ok,
    uncovered: check.uncovered,
  };
}

function operationOf(row: OrderMasterRow, guides: ShipmentRow[]): OperationKind {
  if (["lima", "provincia_cod", "agencia"].includes(row.macro_operation ?? "")) {
    return row.macro_operation as OperationKind;
  }
  return classifyOperation(row, guides);
}

/**
 * Detalle de un pedido: su fila del Master, sus guías, la línea de tiempo
 * cronológica y los productos. La línea de tiempo MEZCLA `order_events` (lo del
 * Master) con `shipment_calls` (las gestiones de Repro Provincia) — por eso el
 * Master no necesita duplicar las gestiones en una tabla propia.
 */
export async function getOrderMasterDetail(orderId: string): Promise<OrderMasterDetail | null> {
  const sb = await createServerSupabase();

  const { data: rowData } = await sb
    .from("order_master")
    .select(MASTER_COLUMNS)
    .eq("order_id", orderId)
    .maybeSingle();
  if (!rowData) return null;
  const row = rowData as unknown as OrderMasterRow;

  const [orderRes, guidesRes, eventsRes] = await Promise.all([
    sb.from("orders").select("line_items,raw").eq("id", orderId).maybeSingle(),
    sb.from("shipments").select(GUIDE_COLUMNS).eq("order_id", orderId).order("created_at"),
    sb
      .from("order_events")
      .select("*")
      .eq("order_id", orderId)
      .order("occurred_at", { ascending: true }),
  ]);

  const guides = (guidesRes.data ?? []) as unknown as ShipmentRow[];
  const events = (eventsRes.data ?? []) as unknown as OrderEventRow[];

  let calls: ShipmentCallRow[] = [];
  if (guides.length) {
    const ids = guides.map((g) => g.id);
    for (const batch of chunk(ids, 200)) {
      const { data } = await sb
        .from("shipment_calls")
        .select("*")
        .in("shipment_id", batch)
        .order("occurred_at", { ascending: true });
      calls = calls.concat((data ?? []) as unknown as ShipmentCallRow[]);
    }
  }

  // Un solo mapa de nombres para las dos fuentes de actores.
  const actorIds = [
    ...new Set(
      [...events.map((e) => e.actor), ...calls.map((c) => c.agent)].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      ),
    ),
  ];
  const names = await resolveEmails(actorIds);
  const guideById = new Map(guides.map((g) => [g.id, g]));

  const fromEvents: TimelineEntry[] = events.map((e) => ({
    id: `event:${e.id}`,
    occurredAt: e.occurred_at,
    kind: e.kind,
    source: e.source,
    courier: e.courier,
    guideCode: e.guide_code,
    previousStatus: e.previous_status,
    newStatus: e.new_status,
    note: e.note,
    reason: e.reason,
    actorName: e.actor ? (names.get(e.actor) ?? null) : null,
    origin: "master",
  }));

  const fromCalls: TimelineEntry[] = calls.map((c) => {
    const guide = guideById.get(c.shipment_id);
    return {
      id: `call:${c.id ?? `${c.shipment_id}-${c.occurred_at}`}`,
      occurredAt: c.occurred_at ?? "",
      kind: c.kind,
      source: "repro_provincia",
      courier: guide?.courier ?? null,
      guideCode: guide?.guide_code ?? null,
      previousStatus: null,
      newStatus: c.new_status,
      note: c.note,
      reason: null,
      actorName: c.agent ? (names.get(c.agent) ?? null) : null,
      origin: "gestion",
    };
  });

  const timeline = [...fromEvents, ...fromCalls]
    .filter((t) => t.occurredAt)
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));

  const orderRow = orderRes.data as { line_items?: OrderLineItem[]; raw?: unknown } | null;
  const lineItems = orderRow?.line_items ?? [];
  const swayp = await swaypRouteCheck(sb, row, lineItems);
  return {
    row,
    guides,
    timeline,
    lineItems,
    address: shopifyShippingAddress(orderRow?.raw),
    routePlan: buildOrderRoutePlan({
      operation: operationOf(row, guides),
      paymentState: row.payment_state,
      swayp,
      outputs: guides.map((guide) => ({
        id: guide.id,
        courier: guide.courier,
        deliveryStatus: guide.delivery_status,
        custodyState: guide.custody_state,
        attempts: guide.aliclik_attempts ?? guide.reroute_attempts,
      })),
    }),
  };
}
