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
import type { GeneralStatus } from "@/lib/order-status";

export type MasterView = "todos" | GeneralStatus;

export const MASTER_VIEWS: { key: MasterView; label: string }[] = [
  { key: "todos", label: "Todos" },
  { key: "pendiente", label: "Pendiente" },
  { key: "en_proceso", label: "En proceso" },
  { key: "entregado", label: "Entregado" },
  { key: "anulado", label: "Anulado" },
  { key: "devuelto", label: "Devuelto" },
];

export function isMasterView(v: string | undefined | null): v is MasterView {
  return !!v && MASTER_VIEWS.some((s) => s.key === v);
}

const MASTER_COLUMNS =
  "id,store_id,order_id,order_name,shopify_order_id,order_created_at,customer_name," +
  "customer_phone,region,province,district,address,reference,latitude,longitude,geo_source," +
  "shipping_mode,order_total,general_status," +
  "operational_status,status_since,status_source,status_locked,current_courier,last_courier," +
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

  const base = () => {
    let q = sb.from("order_master").select(MASTER_COLUMNS).in("store_id", storeIds);
    if (view !== "todos") q = q.eq("general_status", view);
    return q
      // Lo que más importa operativamente es qué se movió (o dejó de moverse)
      // hace más tiempo; los que nunca se movieron van primero.
      .order("last_movement_at", { ascending: false, nullsFirst: true })
      .order("order_created_at", { ascending: false })
      // Desempate estable. Entre filas con la misma fecha de movimiento Y de
      // creación, Postgres no garantiza un orden fijo entre consultas, así que una
      // podía salir en dos tramos y otra en ninguno. Hoy son 8 filas en toda la
      // tabla, pero pedir los tramos en paralelo lo vuelve obligatorio: sin un
      // orden total no hay paginación que valga.
      .order("id", { ascending: true });
  };

  // Cuántas hay, para saber cuántos tramos pedir. Es una consulta `head`: no
  // trae filas.
  let countQuery = sb
    .from("order_master")
    .select("id", { count: "exact", head: true })
    .in("store_id", storeIds);
  if (view !== "todos") countQuery = countQuery.eq("general_status", view);
  const { count, error: countError } = await countQuery;
  if (countError) return [];

  const total = Math.min(count ?? 0, cap);
  if (total === 0) return [];

  // EN PARALELO, no en cadena. PostgREST corta cada respuesta en 1.000 filas, así
  // que 10.000 pedidos son once viajes; encadenados se pagan once latencias de
  // red seguidas (segundos), y en paralelo se paga una. La base tarda 20 ms por
  // tramo: lo que se estaba pagando era la ida y vuelta, no el trabajo.
  const pages = await Promise.all(
    Array.from({ length: Math.ceil(total / PAGE) }, (_, i) =>
      base()
        .range(i * PAGE, i * PAGE + PAGE - 1)
        .then(({ data, error }) => (error ? [] : ((data ?? []) as unknown as OrderMasterRow[]))),
    ),
  );
  return pages.flat();
}

export interface MasterCounts {
  todos: number;
  pendiente: number;
  en_proceso: number;
  entregado: number;
  anulado: number;
  devuelto: number;
}

/** Conteos exactos por pestaña, con consultas `head` (no traen filas). */
export async function getOrderMasterCounts(storeIds: string[]): Promise<MasterCounts> {
  const empty: MasterCounts = {
    todos: 0,
    pendiente: 0,
    en_proceso: 0,
    entregado: 0,
    anulado: 0,
    devuelto: 0,
  };
  if (!storeIds.length) return empty;
  const sb = await createServerSupabase();

  const countFor = async (status: GeneralStatus | null): Promise<number> => {
    let query = sb
      .from("order_master")
      .select("id", { count: "exact", head: true })
      .in("store_id", storeIds);
    if (status) query = query.eq("general_status", status);
    const { count, error } = await query;
    return error ? 0 : (count ?? 0);
  };

  const [todos, pendiente, en_proceso, entregado, anulado, devuelto] = await Promise.all([
    countFor(null),
    countFor("pendiente"),
    countFor("en_proceso"),
    countFor("entregado"),
    countFor("anulado"),
    countFor("devuelto"),
  ]);
  return { todos, pendiente, en_proceso, entregado, anulado, devuelto };
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
  // 0061: el código corto que Shalom muestra junto al nº de orden, y el id con
  // el que sirve el rótulo PDF. Sin ellos el drawer no puede ni identificar el
  // envío en su panel ni ofrecer el rótulo.
  "suggested_order_name,created_at,updated_at,shalom_codigo,shalom_ose_id";

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
