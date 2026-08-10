// Lecturas del Master de Pedidos, con RLS. Espeja lib/shipments-access.ts:
// listado por vista, conteos por pestaña y un cargador de detalle que arma la
// línea de tiempo completa.
//
// El listado sale de UNA sola tabla (`order_master`) porque ahí está todo
// denormalizado; el detalle sí lee tres tablas por `order_id` y las mezcla en
// TypeScript — son tres consultas pequeñas de un solo pedido, no hacen falta
// joins (que PostgREST tampoco daría).

import { unstable_cache } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { chunk } from "@/lib/access";
import { resolveEmails } from "@/lib/productivity";
import { shopifyShippingAddress } from "@/lib/shopify-address";
import type { AliclikHealthState } from "@/lib/aliclik-health";
import { loadAliclikHealthState } from "@/lib/aliclik-health-access";
import { codCouriersFor, isNonMetroLimaLocation } from "@/lib/order-coverage";
import { limaTodayKey } from "@/lib/shipments";
import type { CostTariff } from "@/lib/costs";
import {
  confirmationRisk,
  duplicateCandidates,
  summarizeOutcomes,
  summarizeProducts,
  type ConfirmationRisk,
  type OutcomeCounts,
  type PriorOrderSnapshot,
} from "@/lib/order-confirmation-brief";
import { parseLabelLineItems } from "@/lib/labels/line-items";
import {
  confirmationAttemptDetail,
  type ConfirmationAttemptDetail,
} from "@/lib/order-confirmation";
import { evaluateDirectFenixStock, type FenixStockRow } from "@/lib/fenix";
import { deriveFenixCoverageCity } from "@/lib/shipments";
import {
  buildOrderRoutePlan,
  type OrderRoutePlan,
  type SwaypRouteCheck,
} from "@/lib/order-route-plan";
import type {
  OrderEventRow,
  OrderLineItem,
  OrderMasterRow,
  ShipmentCallRow,
  ShipmentRow,
} from "@/lib/types";
import {
  AGENCY_AVAILABLE_STATES,
  emptyFilters,
  type AgencySummary,
  type MasterFilters,
  type MasterSortKey,
} from "@/lib/order-master-filters";
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
  "coverage," +
  "shipping_mode,order_total,general_status," +
  "operational_status,macro_stage,macro_substage,macro_reasons,macro_operation,macro_version,macro_since," +
  "status_since,status_locked,current_courier,last_courier," +
  "courier_count,attempt_count,guide_code,dispatched_at,delivered_at,delivered_courier,returned_at," +
  "last_movement_at,comment_count,logistics_cost,pickup_state,payment_state," +
  // El panel de Aliclik decide con estas dos si enseña "el pedido ya tiene
  // coordenada" o "obligatoria, el pedido no la tiene". Sin traerlas llegaban
  // como `undefined` y el panel decía SIEMPRE que faltaba, también en pedidos
  // que sí la tenían — con la operadora pegando pines a mano sin necesidad.
  // La acción del servidor nunca se vio afectada: `authorize` hace `select("*")`.
  "latitude,longitude," +
  "key_state,agency_branch,agency_arrived_at,agency_expires_at";

// Columnas exclusivas del DRAWER. La tabla las omite por peso, pero el detalle
// necesita los datos materializados por `order-master.ts` desde Shopify, Aliclik
// o una corrección manual. Mantener este select separado evita volver a enviar
// dirección y referencia miles de veces sin dejar el drawer incompleto.
export const MASTER_DETAIL_EXTRA_COLUMNS = [
  "shopify_order_id",
  "address",
  "reference",
  "geo_source",
  "status_source",
] as const;
const MASTER_DETAIL_COLUMNS =
  `${MASTER_COLUMNS},${MASTER_DETAIL_EXTRA_COLUMNS.join(",")}`;

// PostgREST corta cada respuesta en `db-max-rows` (1000 en Supabase), así que se
// pagina con .range() en vez de pedir un .limit() grande.
const PAGE = 1000;
const MAX_LIST = 20_000;

/**
 * Cola del Master para las tiendas accesibles. Igual que en Repro Provincia, la
 * consulta abarca TODAS las tiendas accesibles y el filtro por tienda se aplica
 * en el board (es multi-selección y se combina con el resto).
 */
// `getOrderMasterRows` (el cargador de la tabla ENTERA) se retiró al paginar en
// el servidor: bajaba ~10.000 filas y 13 MB por carga. Si algún día hace falta
// un volcado completo, que sea para exportar y con su propia función, no para
// pintar una pantalla.

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

export async function getOrderMasterMomCounts(storeIds: string[]): Promise<MasterMomCounts> {
  if (!storeIds.length) return { stages: emptyMasterCounts(), substages: {} };
  const sb = await createServerSupabase();
  const { data, error } = await sb.rpc("order_master_mom_counts", { p_store_ids: storeIds });
  if (!error) return reduceMasterMomCounts((data ?? []) as MasterCountRow[]);
  return { stages: await getOrderMasterCounts(storeIds), substages: {} };
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
  /** Canal y resultado, cuando la entrada es un intento de confirmación. */
  confirmation: ConfirmationAttemptDetail | null;
}

export interface OrderMasterDetail {
  row: OrderMasterRow;
  guides: ShipmentRow[];
  timeline: TimelineEntry[];
  lineItems: OrderLineItem[];
  address: ReturnType<typeof shopifyShippingAddress>;
  routePlan: OrderRoutePlan;
  /** Foco de salud de la API de Aliclik, para el panel de crear guía. */
  aliclikHealth: AliclikHealthState;
}

const GUIDE_COLUMNS =
  "id,store_id,courier,guide_code,delivery_status,status_category,order_id,matched," +
  "match_method,order_name,customer_name,customer_phone,product,district,province,city,region," +
  "delivery_address,delivery_reference,latitude,longitude,address_override,address_updated_at," +
  "address_updated_by,fenix_eligible,fenix_shipment_id,created_via,delivered_source," +
  "shalom_codigo,shalom_ose_id,shalom_order_id,shalom_serie,shalom_raw," +
  "aliclik_attempts,aliclik_service_date,reroute_attempts,reroute_outcome,claimed_by,claimed_at," +
  "next_followup_at,source_batch_id,last_report_at,suggested_order_gid,suggested_store_id," +
  // 0061: el código corto que Shalom muestra junto al nº de orden, y el id con
  // el que sirve el rótulo PDF. Sin ellos el drawer no puede ni identificar el
  // envío en su panel ni ofrecer el rótulo.
  "suggested_order_name,output_number,output_code,qr_token,preparation_state,custody_state," +
  "ready_at,ready_by,custody_transferred_at,custody_transferred_by,returned_at,label_url," +
  "created_at,updated_at";

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
    (data ?? []) as FenixStockRow[],
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
  // Cobertura y courier son señales vivas. Ganan sobre `macro_operation`, que
  // puede conservar una clasificación anterior hasta el siguiente recálculo.
  const classified = classifyOperation(row, guides);
  if (classified !== "desconocida") return classified;
  if (["lima", "provincia_cod", "agencia"].includes(row.macro_operation ?? "")) {
    return row.macro_operation as OperationKind;
  }
  return "desconocida";
}

/**
 * Guard de lectura: corrige la cobertura materializada que se quedó vieja.
 *
 * Vale para las NUEVE provincias no metropolitanas de Lima, no solo para Cañete.
 * Con la comprobación limitada a Cañete, un pedido de Barranca enseñaba "Agencia"
 * en la mesa de ruta —que clasifica en vivo— y "Lima" en la ficha de cobertura,
 * que lee el campo guardado. Dos respuestas distintas a la misma pregunta en la
 * misma pantalla, y ninguna forma de saber cuál creer.
 */
function withRuntimeCoverage(row: OrderMasterRow): OrderMasterRow {
  return isNonMetroLimaLocation(row) ? { ...row, coverage: "agencia" } : row;
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
    .select(MASTER_DETAIL_COLUMNS)
    .eq("order_id", orderId)
    .maybeSingle();
  if (!rowData) return null;
  const row = withRuntimeCoverage(rowData as unknown as OrderMasterRow);

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
    confirmation: confirmationAttemptDetail(e.payload),
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
      confirmation: null,
    };
  });

  const timeline = [...fromEvents, ...fromCalls]
    .filter((t) => t.occurredAt)
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));

  const orderRow = orderRes.data as { line_items?: OrderLineItem[]; raw?: unknown } | null;
  const lineItems = orderRow?.line_items ?? [];
  const [swayp, aliclikHealth] = await Promise.all([
    swaypRouteCheck(sb, row, lineItems),
    loadAliclikHealthState(sb, row.store_id),
  ]);
  return {
    row,
    guides,
    timeline,
    lineItems,
    aliclikHealth,
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
        // Para que la mesa pueda NOMBRAR la salida que bloquea, en vez de
        // limitarse a decir que hay una.
        guideCode: guide.guide_code,
        shortCode: guide.shalom_codigo ?? null,
        pickupState: guide.pickup_state,
      })),
    }),
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
 * El término de búsqueda, normalizado. Vive aparte porque lo miran dos sitios:
 * quien arma el `or(...ilike...)` y quien decide que buscar ignora la pestaña.
 * Si cada uno lo normalizara por su cuenta, un día dejarían de coincidir y la
 * búsqueda volvería a acotarse sola en algún caso raro — el `#` es justo eso.
 */
function searchTerm(f: MasterFilters): string {
  return f.search.trim().replace(/^#/, "");
}

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
  if (f.coverages.size) q = q.in("coverage", [...f.coverages]);
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

  const term = searchTerm(f);
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
    substage?: MacroSubstage | null;
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
  const sort = SORT_COLUMN.created;

  // Buscar es buscar en TODO el Master. Quien teclea "#KP125285" quiere ESE
  // pedido, y por definición no sabe dónde está — si lo supiera no lo buscaría.
  // Cualquier recorte previo sólo sirve para esconderlo y dejar un "Sin
  // coincidencias" que se lee como "ese pedido no existe".
  //
  // Se ignoran la pestaña, la subetapa y TODOS los demás filtros, y no por
  // gusto: mientras hay búsqueda la pantalla oculta las pestañas y la barra de
  // filtros entera. Un filtro que sigue actuando pero no se ve ni se puede
  // quitar es una trampa — da igual que lo pusiera el usuario hace un rato.
  // Lo único que se mantiene es `store_id`, que no es un filtro sino el límite
  // de lo que esta persona puede ver.
  const searching = searchTerm(params.filters).length > 0;
  const effectiveFilters = searching
    ? { ...emptyFilters(), search: params.filters.search }
    : params.filters;

  const build = (select: string, opts?: { count: "exact"; head: true }) => {
    let q = opts
      ? sb.from("order_master").select(select, opts)
      : sb.from("order_master").select(select);
    q = q.in("store_id", storeIds) as typeof q;
    if (!searching && view !== "todos") q = q.eq("macro_stage", view) as typeof q;
    if (!searching && params.substage) q = q.eq("macro_substage", params.substage) as typeof q;
    return applyServerFilters(q, effectiveFilters, now);
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
    rows: ((rowsRes.data ?? []) as unknown as OrderMasterRow[]).map(withRuntimeCoverage),
    total: countRes.count ?? 0,
    page: params.page,
    pageSize,
  };
}

/** Opciones de los desplegables, calculadas en la base (0059). Unos kilobytes
 *  en vez de las 10.000 filas que hacían falta para deducirlas en el navegador. */
/**
 * Lo que NO depende de lo que el usuario esté filtrando se calcula una vez y se
 * reutiliza durante un rato.
 *
 * Las opciones de los desplegables y el resumen de agencia son iguales escribas
 * lo que escribas en el buscador, pero se recalculaban en CADA tecla porque
 * viven en el mismo render de servidor que el listado. Eran ~25 ms de base y un
 * viaje de red por pulsación, para devolver exactamente lo mismo.
 *
 * Se usa el cliente admin y no el de sesión porque `unstable_cache` no puede
 * leer cookies. El alcance sigue siendo correcto: la clave del caché son las
 * tiendas, que el llamador ya autorizó antes de llegar aquí.
 */
const FACETS_TTL_SECONDS = 120;

async function loadFacets(storeIds: string[]) {
  const empty = { operational: [], courier: [], region: [], province: [], district: [], coverage: [], pickup: [] };
  if (!storeIds.length) return empty;
  const admin = createAdminSupabase();
  const { data, error } = await admin.rpc("master_facets", { p_store_ids: storeIds });
  if (error || !data) return empty;
  const d = data as Record<string, string[] | null>;
  const list = (k: string) => [...(d[k] ?? [])].sort((a, b) => a.localeCompare(b, "es"));
  return {
    operational: list("operational"),
    courier: list("courier"),
    region: list("region"),
    province: list("province"),
    district: list("district"),
    coverage: list("coverage"),
    pickup: list("pickup"),
  };
}

async function loadAgencySummary(storeIds: string[]): Promise<AgencySummary> {
  const empty: AgencySummary = {
    pendienteDeEnvio: 0,
    enTransito: 0,
    disponibles: 0,
    proximosAVencer: 0,
    retornoIniciado: 0,
  };
  if (!storeIds.length) return empty;
  const admin = createAdminSupabase();
  const now = new Date();
  const count = async (build: (q: any) => any): Promise<number> => {
    const base = admin
      .from("order_master")
      .select("id", { count: "exact", head: true })
      .in("store_id", storeIds);
    const { count: n, error } = await build(base);
    return error ? 0 : (n ?? 0);
  };
  // "En agencia" es tener sub-estado de recojo o ir por modo agencia, la misma
  // regla que usa `agencySummary` en cliente.
  //
  // OJO AL VOCABULARIO. Esto contaba `pickup_state = 'disponible'` y
  // `= 'devuelto'`, y NINGUNO DE LOS DOS EXISTE en el catálogo de sub-estados
  // (`lib/order-status.ts`). Devolvían 0 siempre, sin fallar — que es lo peor:
  // el panel enseñaba "93 en agencia · 0 disponibles para recojo" con 49
  // paquetes esperando en destino, y un cero se lee como "no hay nada que
  // hacer", justo en la pantalla que existe para evitar devoluciones.
  //
  // La lista viene de `AGENCY_AVAILABLE_STATES` a propósito: había TRES copias
  // de este resumen —cliente, esta, y una `getAgencySummary` que ya no llamaba
  // nadie—, y arreglar la que no se ejecutaba no cambió nada en pantalla.
  const inAgency = (q: any) => q.or("pickup_state.not.is.null,shipping_mode.eq.agency");
  const soon = new Date(now.getTime() + 2 * 86_400_000).toISOString();
  const [disponibles, proximosAVencer, retornoIniciado, pendienteDeEnvio, enTransito] =
    await Promise.all([
    count((q) => q.in("pickup_state", [...AGENCY_AVAILABLE_STATES])),
    count((q) => inAgency(q).not("agency_expires_at", "is", null).lte("agency_expires_at", soon)),
    count((q) => q.eq("pickup_state", "retorno_iniciado")),
    count((q) => q.eq("pickup_state", "pendiente_de_envio")),
    count((q) => q.eq("pickup_state", "en_transito")),
  ]);
  return { pendienteDeEnvio, enTransito, disponibles, proximosAVencer, retornoIniciado };
}

export const getMasterFacetsCached = (storeIds: string[]) =>
  unstable_cache(
    async () => loadFacets(storeIds),
    ["master-facets", [...storeIds].sort().join(",")],
    { revalidate: FACETS_TTL_SECONDS },
  )();

export const getAgencySummaryCached = (storeIds: string[]) =>
  unstable_cache(
    async () => loadAgencySummary(storeIds),
    ["master-agency", [...storeIds].sort().join(",")],
    { revalidate: FACETS_TTL_SECONDS },
  )();

/**
 * Las filas de una SELECCIÓN concreta, para exportarla.
 *
 * No pasa por los filtros a propósito: quien marca casillas ya eligió: aplicar
 * encima el filtro de la pantalla podría dejar fuera un pedido que marcó antes
 * de cambiarlo, y eso es peor que no filtrar. `storeIds` sí se mantiene, porque
 * no es un filtro sino el límite de lo que esta persona puede ver, y la RLS
 * vuelve a imponerlo por debajo.
 *
 * El orden es el mismo del listado (creación, más recientes primero) para que
 * la hoja no salga barajada respecto a lo que se estaba mirando.
 */
export async function getOrderMasterRowsByIds(
  storeIds: string[],
  orderIds: string[],
): Promise<OrderMasterRow[]> {
  if (!storeIds.length || !orderIds.length) return [];
  const sb = await createServerSupabase();
  const out: OrderMasterRow[] = [];
  // Por lotes: una lista de miles de ids en un solo `in(...)` desborda la URL
  // que arma PostgREST.
  const CHUNK = 500;
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const slice = orderIds.slice(i, i + CHUNK);
    const { data, error } = await sb
      .from("order_master")
      .select(MASTER_COLUMNS)
      .in("store_id", storeIds)
      .in("order_id", slice)
      .order("order_created_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true });
    if (error) break;
    out.push(...((data ?? []) as unknown as OrderMasterRow[]).map(withRuntimeCoverage));
  }
  return out;
}

export async function getMasterFacets(storeIds: string[]): Promise<{
  operational: string[];
  courier: string[];
  region: string[];
  province: string[];
  district: string[];
  coverage: string[];
  pickup: string[];
}> {
  const empty = { operational: [], courier: [], region: [], province: [], district: [], coverage: [], pickup: [] };
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
    coverage: list("coverage"),
    pickup: list("pickup"),
  };
}


// ---------------------------------------------------------------------------
// Ficha previa a la llamada (MOM §8)
// ---------------------------------------------------------------------------

export interface OrderConfirmationBrief {
  /** Los otros pedidos del MISMO teléfono, del más nuevo al más viejo. */
  priors: PriorOrderSnapshot[];
  counts: OutcomeCounts;
  risk: ConfirmationRisk;
  /** Los que siguen abiertos y podrían ser este pedido otra vez. */
  duplicates: PriorOrderSnapshot[];
  /** Couriers con tarifa COD vigente para ese destino. Vacío = va por agencia. */
  codCouriers: string[];
  coverage: string | null;
  /**
   * Cuándo se creó el pedido que se está mirando, para saber cuáles del
   * historial son POSTERIORES: no todos los que se listan son anteriores.
   */
  orderCreatedAt: string | null;
  /** Qué lleva este pedido, para poder verlo repetido en el historial. */
  products: string | null;
}

/**
 * Lo que hay que mirar antes de marcar: historial del cliente, duplicados y
 * cobertura. Hasta ahora eso vivía en tres columnas del Excel y en la cabeza de
 * quien llamaba; el pedido en Kapta no decía nada de las tres.
 *
 * Se lee con el cliente de sesión, así que la RLS decide qué pedidos anteriores
 * son visibles: el historial de un teléfono nunca cruza a una tienda que quien
 * mira no puede ver.
 */
export async function getOrderConfirmationBrief(
  orderId: string,
): Promise<OrderConfirmationBrief | null> {
  const sb = await createServerSupabase();
  const { data: rowData } = await sb
    .from("order_master")
    .select("order_id,store_id,customer_phone,region,province,district,coverage,order_created_at")
    .eq("order_id", orderId)
    .maybeSingle();
  if (!rowData) return null;
  const row = rowData as unknown as {
    order_id: string;
    store_id: string;
    customer_phone: string | null;
    region: string | null;
    province: string | null;
    district: string | null;
    coverage: string | null;
    order_created_at: string | null;
  };

  // Sin teléfono no hay historial que buscar: el teléfono ES la identidad del
  // cliente en esta operación (no hay cuenta ni documento en Shopify COD).
  const phone = (row.customer_phone ?? "").trim();
  let priors: PriorOrderSnapshot[] = [];
  if (phone) {
    const { data } = await sb
      .from("order_master")
      .select(
        "order_id,order_name,order_created_at,general_status,operational_status,macro_stage,order_total," +
          "guide_code,current_courier,last_courier,delivered_courier,attempt_count",
      )
      .eq("customer_phone", phone)
      .neq("order_id", orderId)
      .order("order_created_at", { ascending: false })
      .limit(50);
    priors = ((data ?? []) as unknown as PriorOrderSnapshot[]) ?? [];
  }

  // Qué lleva cada pedido. Vive en `orders.line_items`, no en el master, así que
  // es una lectura aparte — bajo el cliente de sesión, igual que el historial,
  // para que la RLS siga decidiendo qué se ve. Si falla, la ficha se muestra sin
  // productos: es contexto, no un dato del que dependa ninguna regla.
  const products = new Map<string, string>();
  const wanted = [row.order_id, ...priors.map((p) => p.order_id)];
  try {
    const { data: lines } = await sb.from("orders").select("id,line_items").in("id", wanted);
    for (const entry of (lines ?? []) as unknown as { id: string; line_items: unknown }[]) {
      const summary = summarizeProducts(parseLabelLineItems(entry.line_items));
      if (summary) products.set(entry.id, summary);
    }
  } catch {
    // Sin productos la ficha sigue sirviendo.
  }
  for (const prior of priors) prior.products = products.get(prior.order_id) ?? null;

  const counts = summarizeOutcomes(priors);

  // Las tarifas se leen con el service role: `cost_tariffs` es configuración de
  // la organización, no un dato del pedido, y la cobertura ya se calcula con
  // ellas en el servidor. Sin tarifas aplicadas, la lista sale vacía y la ficha
  // simplemente no afirma nada sobre cobertura.
  let codCouriers: string[] = [];
  try {
    const admin = createAdminSupabase();
    const { data: store } = await admin
      .from("stores")
      .select("org_id")
      .eq("id", row.store_id)
      .maybeSingle();
    const orgId = (store as { org_id?: string } | null)?.org_id ?? null;
    if (orgId) {
      const { data: tariffs } = await admin
        .from("cost_tariffs")
        .select("id,org_id,store_id,courier,region,province,district,concept,amount,effective_from,effective_to")
        .eq("org_id", orgId);
      codCouriers = codCouriersFor(
        (tariffs ?? []) as unknown as CostTariff[],
        {
          storeId: row.store_id,
          orgId,
          region: row.region,
          province: row.province,
          district: row.district,
        },
        limaTodayKey(),
      );
    }
  } catch {
    // La matriz de costos es opcional (Fase 4). Su ausencia no puede tumbar la
    // ficha entera: el historial y los duplicados siguen sirviendo sin ella.
    codCouriers = [];
  }

  return {
    priors,
    counts,
    risk: confirmationRisk(counts, priors),
    duplicates: duplicateCandidates(priors),
    codCouriers,
    coverage: row.coverage,
    orderCreatedAt: row.order_created_at,
    products: products.get(row.order_id) ?? null,
  };
}
