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
import type { MasterFilters, MasterSortKey } from "@/lib/order-master-filters";

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

// Columnas del LISTADO. Deliberadamente más cortas que la fila completa: en un
// listado de 10.000 pedidos, cada columna se paga 10.000 veces — y no solo su
// valor, también su NOMBRE repetido en cada objeto JSON. Con las 43 columnas
// eran 13 MB por carga, de los que la mayor parte eran nombres de campo.
//
// Aquí solo van las que la tabla pinta o los filtros usan. Todo lo demás
// —dirección, referencia, coordenadas, origen de la geo— lo trae el detalle al
// abrir un pedido (`getOrderMasterDetail`, que sí lee la fila entera), que es
// exactamente cuando hace falta y para UN pedido, no para diez mil.
const MASTER_COLUMNS =
  "id,store_id,order_id,order_name,order_created_at,customer_name," +
  "customer_phone,region,province,district," +
  "shipping_mode,order_total,general_status," +
  "operational_status,status_since,status_locked,current_courier,last_courier," +
  "courier_count,attempt_count,guide_code,dispatched_at,delivered_at," +
  "last_movement_at,comment_count,logistics_cost,pickup_state,payment_state," +
  "key_state,agency_branch,agency_arrived_at,agency_expires_at";

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

// ---------------------------------------------------------------------------
// Listado paginado, con los filtros aplicados en la BASE.
// ---------------------------------------------------------------------------

/** Filas por página. 100 llena la pantalla y pesa ~100 KB, frente a los 9,5 MB
 *  que costaba bajar la tabla entera. */
export const MASTER_PAGE_SIZE = 100;

export interface MasterPage {
  rows: OrderMasterRow[];
  /** Cuántos hay en total con esos filtros, para paginar y para el contador. */
  total: number;
  page: number;
  pageSize: number;
}

/** Columna por la que ordena cada opción del selector, y si va descendente. */
const SORT_COLUMN: Record<MasterSortKey, { column: string; ascending: boolean }> = {
  created: { column: "order_created_at", ascending: false },
  movement: { column: "last_movement_at", ascending: false },
  status_age: { column: "status_since", ascending: true },
  attempts: { column: "attempt_count", ascending: false },
  couriers: { column: "courier_count", ascending: false },
  total: { column: "order_total", ascending: false },
};

/**
 * Traduce los filtros a la consulta. Cada uno se apoya en un índice que ya
 * existe (`order_master_store_district_idx`, `..._store_courier_idx`, los
 * parciales de multi_courier y multi_attempt…), así que filtrar en la base sale
 * más barato que traérselo todo y filtrarlo en el navegador — que es lo que se
 * hacía antes.
 *
 * `now` se pasa desde fuera para que "vence pronto" y "sin movimiento" sean
 * reproducibles y no dependan del reloj del servidor a mitad de una petición.
 */
function applyServerFilters<T>(query: T, f: MasterFilters, now: Date): T {
  // El tipo del query builder de PostgREST es encadenado; se trabaja sobre una
  // referencia suelta para no pelearse con los genéricos en cada línea.
  let q = query as any;

  if (f.stores.size) q = q.in("store_id", [...f.stores]);
  if (f.generalStatuses.size) q = q.in("general_status", [...f.generalStatuses]);
  if (f.operationalStatuses.size) q = q.in("operational_status", [...f.operationalStatuses]);
  if (f.shippingModes.size) q = q.in("shipping_mode", [...f.shippingModes]);
  if (f.regions.size) q = q.in("region", [...f.regions]);
  if (f.provinces.size) q = q.in("province", [...f.provinces]);
  if (f.districts.size) q = q.in("district", [...f.districts]);
  if (f.pickupStates.size) q = q.in("pickup_state", [...f.pickupStates]);

  // El courier mira el actual Y el último: buscar "los que tocó Fenix" no debe
  // perder los que ya pasaron a otra guía. Es la misma regla que tenía el filtro
  // en cliente, escrita como un OR de PostgREST.
  if (f.couriers.size) {
    const list = [...f.couriers].map((c) => `"${c.replace(/"/g, '""')}"`).join(",");
    q = q.or(`current_courier.in.(${list}),last_courier.in.(${list})`);
  }

  const range = (column: string, from: string, to: string) => {
    if (from) q = q.gte(column, `${from}T00:00:00.000Z`);
    // Extremo superior inclusive: el usuario que escribe "hasta el 24" espera
    // que entren los del 24, no que se corten a medianoche del 23.
    if (to) q = q.lte(column, `${to}T23:59:59.999Z`);
  };
  range("order_created_at", f.createdFrom, f.createdTo);
  range("dispatched_at", f.dispatchedFrom, f.dispatchedTo);
  range("last_movement_at", f.movementFrom, f.movementTo);
  range("delivered_at", f.deliveredFrom, f.deliveredTo);

  if (f.withComments) q = q.gt("comment_count", 0);
  if (f.multiCourier) q = q.gt("courier_count", 1);
  if (f.multiAttempt) q = q.gt("attempt_count", 1);

  if (f.expiringSoon) {
    // Incluye lo ya vencido: es justamente lo que hay que trabajar hoy para que
    // el paquete no se devuelva.
    const limit = new Date(now.getTime() + 2 * 86_400_000).toISOString();
    q = q.not("agency_expires_at", "is", null).lte("agency_expires_at", limit);
  }

  if (f.staleDays > 0) {
    // "Sin movimientos recientes". Un pedido que NUNCA se movió también cuenta:
    // es justamente el que nadie está mirando, así que se incluyen los nulos.
    const cutoff = new Date(now.getTime() - f.staleDays * 86_400_000).toISOString();
    q = q.or(`last_movement_at.is.null,last_movement_at.lte.${cutoff}`);
  }

  const term = f.search.trim().replace(/^#/, "");
  if (term) {
    const like = `*${term.replace(/[*,()]/g, "")}*`;
    q = q.or(
      `order_name.ilike.${like},guide_code.ilike.${like},customer_phone.ilike.${like},customer_name.ilike.${like}`,
    );
  }

  return q as T;
}

/**
 * Una página del Master, filtrada y ordenada en la base.
 *
 * Reemplaza al listado completo: antes se bajaban las ~10.000 filas al navegador
 * (13 MB, y otra vez enteras en cada cambio de pestaña) para filtrarlas en
 * memoria. Ahora viaja lo que se ve.
 */
export async function getOrderMasterPage(
  storeIds: string[],
  params: {
    view?: MasterView;
    filters: MasterFilters;
    sortKey: MasterSortKey;
    page: number;
    pageSize?: number;
    now?: Date;
  },
): Promise<MasterPage> {
  const pageSize = params.pageSize ?? MASTER_PAGE_SIZE;
  const empty: MasterPage = { rows: [], total: 0, page: 1, pageSize };
  if (!storeIds.length) return empty;

  const sb = await createServerSupabase();
  const view = params.view ?? "todos";
  const now = params.now ?? new Date();
  const sort = SORT_COLUMN[params.sortKey] ?? SORT_COLUMN.created;

  const build = (select: string, opts?: { count: "exact"; head: true }) => {
    let q = opts
      ? sb.from("order_master").select(select, opts)
      : sb.from("order_master").select(select);
    q = q.in("store_id", storeIds) as typeof q;
    if (view !== "todos") q = q.eq("general_status", view) as typeof q;
    return applyServerFilters(q, params.filters, now);
  };

  // El conteo va en paralelo con la página: es una consulta `head`, no trae
  // filas, y hace falta para poder paginar.
  const [countRes, rowsRes] = await Promise.all([
    build("id", { count: "exact", head: true }),
    (() => {
      const q = build(MASTER_COLUMNS) as any;
      const from = Math.max(0, (params.page - 1) * pageSize);
      return q
        .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
        // Desempate estable: sin un orden total, dos páginas pueden repetir o
        // saltarse una fila.
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
    })(),
  ]);

  if (rowsRes.error) return empty;
  return {
    rows: (rowsRes.data ?? []) as unknown as OrderMasterRow[],
    total: countRes.count ?? 0,
    page: params.page,
    pageSize,
  };
}

/** Opciones de los desplegables, calculadas en la base (0059). Unos kilobytes
 *  en vez de las 10.000 filas que hacían falta para deducirlas en el navegador. */
export async function getMasterFacets(storeIds: string[]): Promise<{
  operational: string[];
  courier: string[];
  region: string[];
  province: string[];
  district: string[];
  pickup: string[];
}> {
  const empty = { operational: [], courier: [], region: [], province: [], district: [], pickup: [] };
  if (!storeIds.length) return empty;
  const sb = await createServerSupabase();
  const { data, error } = await sb.rpc("master_facets", { p_store_ids: storeIds });
  if (error || !data) return empty;
  const d = data as Record<string, string[] | null>;
  const list = (k: string) => [...(d[k] ?? [])].sort((a, b) => a.localeCompare(b, "es"));
  return {
    operational: list("operational"),
    courier: list("courier"),
    region: list("region"),
    province: list("province"),
    district: list("district"),
    pickup: list("pickup"),
  };
}
