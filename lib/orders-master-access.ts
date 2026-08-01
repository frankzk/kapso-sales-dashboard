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
import type {
  OrderEventRow,
  OrderLineItem,
  OrderMasterRow,
  ShipmentCallRow,
  ShipmentRow,
} from "@/lib/types";
import { ORDER_MACRO_STAGES, type OrderMacroStage } from "@/lib/order-macro-stage";

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

// PostgREST corta cada respuesta en `db-max-rows` (1000 en Supabase), así que se
// pagina con .range() en vez de pedir un .limit() grande.
const PAGE = 1000;
const MAX_LIST = 20_000;

/**
 * Cola del Master para las tiendas accesibles. Igual que en Repro Provincia, la
 * consulta abarca TODAS las tiendas accesibles y el filtro por tienda se aplica
 * en el board (es multi-selección y se combina con el resto).
 */
export async function getOrderMasterRows(
  storeIds: string[],
  view: MasterView = "todos",
  opts: { limit?: number } = {},
): Promise<OrderMasterRow[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const cap = opts.limit ?? MAX_LIST;
  const out: OrderMasterRow[] = [];

  for (let from = 0; from < cap; from += PAGE) {
    let query = sb.from("order_master").select(MASTER_COLUMNS).in("store_id", storeIds);
    if (view !== "todos") query = query.eq("macro_stage", view);
    const { data, error } = await query
      // Lo que más importa operativamente es qué se movió (o dejó de moverse)
      // hace más tiempo; los que nunca se movieron van primero.
      .order("last_movement_at", { ascending: false, nullsFirst: true })
      .order("order_created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) return out;
    const page = (data ?? []) as unknown as OrderMasterRow[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
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

/** Conteos exactos por pestaña, con consultas `head` (no traen filas). */
export async function getOrderMasterCounts(storeIds: string[]): Promise<MasterCounts> {
  const empty: MasterCounts = {
    todos: 0,
    por_confirmar: 0,
    preparacion: 0,
    por_despachar: 0,
    en_curso: 0,
    por_cerrar: 0,
    finalizado: 0,
  };
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
    .order("last_movement_at", { ascending: false })
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
}

const GUIDE_COLUMNS =
  "id,store_id,courier,guide_code,delivery_status,status_category,order_id,matched," +
  "match_method,order_name,customer_name,customer_phone,product,district,province,city,region," +
  "delivery_address,delivery_reference,latitude,longitude,address_override,address_updated_at," +
  "address_updated_by,fenix_eligible,fenix_shipment_id,created_via,delivered_source," +
  "aliclik_attempts,aliclik_service_date,reroute_attempts,reroute_outcome,claimed_by,claimed_at," +
  "next_followup_at,source_batch_id,last_report_at,suggested_order_gid,suggested_store_id," +
  "suggested_order_name,output_number,output_code,qr_token,preparation_state,custody_state," +
  "ready_at,ready_by,custody_transferred_at,custody_transferred_by,label_url,created_at,updated_at";

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
  return {
    row,
    guides,
    timeline,
    lineItems: orderRow?.line_items ?? [],
    address: shopifyShippingAddress(orderRow?.raw),
  };
}
