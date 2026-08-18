// Recálculo del read-model del Master (`order_master`, 0045).
//
// El Master no guarda una verdad propia: la DERIVA de las fuentes que ya
// existen — `orders` (Shopify), `shipments` + `shipment_calls` (Repro Provincia
// y los reportes de couriers) y `order_events` (lo manual y lo que no cuelga de
// una guía) — y la materializa en una fila por pedido para que el listado sea
// UNA consulta a UNA tabla. Ver la cabecera de 0045 para el porqué.
//
// Se invoca desde:
//   * la ingesta de pedidos de Shopify (lib/ingest.ts),
//   * cada acción de Repro Provincia que toca `shipments`,
//   * la ingesta de reportes de couriers,
//   * las acciones manuales del propio Master,
//   * y un barrido de reconciliación en el cron, como red de seguridad.
//
// SERVER-ONLY: recibe siempre el cliente service-role, como lib/aliclik-ingest.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { chunk } from "@/lib/access";
import { normalizeDistrict } from "@/lib/shipments";
import { shopifyShippingAddress } from "@/lib/shopify-address";
import { keyState, paymentState, type PaymentSnapshot } from "@/lib/pickup-key";
import { computeLogisticsCost, costDay, type CostTariff } from "@/lib/costs";
import {
  CONFIRMATION_CONTACT_KINDS,
  CONFIRMATION_FOLLOWUP_KINDS,
  confirmationDayCount,
} from "@/lib/order-confirmation";
import { classifyOrderCoverage, type OrderCoverage } from "@/lib/order-coverage";
import {
  MOM_RESOLUTION_VERSION,
  resolveMacroStage,
  type MacroGuideSnapshot,
} from "@/lib/order-macro-stage";
import {
  isGeneralStatus,
  isOperationalStatus,
  resolveOrderState,
  type GuideSnapshot,
  type OrderEventSnapshot,
  type StatusOverride,
} from "@/lib/order-status";

const ORDER_COLUMNS =
  "id,store_id,shopify_order_id,name,created_at,cancelled_at,financial_status,shipping_mode,customer_phone,total_amount,raw";

// Las columnas de gestión (assigned_at … agency_expires_at) las añade 0047. El
// código se despliega antes que la migración, así que se intenta el conjunto
// completo y se cae al básico — el mismo "column step-down" que usan
// lib/access.ts y lib/shipments-access.ts.
const SHIPMENT_BASE_COLUMNS =
  "id,order_id,store_id,courier,guide_code,delivery_status,status_category," +
  "aliclik_attempts,reroute_attempts,delivered_source,district,province,region," +
  "delivery_address,delivery_reference,latitude,longitude," +
  "customer_name,customer_phone,created_at,updated_at";
const SHIPMENT_GESTION_COLUMNS =
  ",assigned_at,dispatched_at,out_for_delivery_at,rescheduled_at,closed_at," +
  "returned_at,pickup_state,agency_branch,agency_arrived_at,agency_expires_at";
// Lo que Aliclik cotizó para esta guía concreta (0054). Va en su propio escalón
// porque el costo real solo lo tienen las guías creadas por API: si la columna
// aún no existe, el cálculo sigue funcionando con las tarifas de siempre.
const SHIPMENT_COST_COLUMNS = ",quoted_delivery_cost,quoted_return_cost,created_via";
const SHIPMENT_MOM_COLUMNS =
  ",output_number,output_code,qr_token,preparation_state,custody_state," +
  "ready_at,ready_by,custody_transferred_at,custody_transferred_by";
const SHIPMENT_COLUMN_SETS = [
  SHIPMENT_BASE_COLUMNS + SHIPMENT_GESTION_COLUMNS + SHIPMENT_COST_COLUMNS + SHIPMENT_MOM_COLUMNS,
  SHIPMENT_BASE_COLUMNS + SHIPMENT_GESTION_COLUMNS + SHIPMENT_COST_COLUMNS,
  SHIPMENT_BASE_COLUMNS + SHIPMENT_GESTION_COLUMNS + SHIPMENT_MOM_COLUMNS,
  SHIPMENT_BASE_COLUMNS + SHIPMENT_GESTION_COLUMNS,
  SHIPMENT_BASE_COLUMNS,
];

/** Numérico utilizable, o null. Supabase devuelve los `numeric` como string. */
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** PostgREST corta la respuesta en 1000 filas; se pagina siempre. */
const PAGE = 1000;
/** Tamaño de lote para los `.in(...)`: URLs demasiado largas fallan. */
const ID_BATCH = 200;
/** Límite del backfill de versión por tienda y cron para no competir con la operación. */
const VERSION_RECONCILE_PAGE = 250;
/**
 * Guías tocadas que se miran por pasada para detectar pedidos con la etapa
 * vieja. Cubre de sobra una escritura masiva —el backfill del 09-08 tocó 502
 * guías en una sentencia— sin arrastrar el histórico: las que ya se recalcularon
 * dejan de aparecer, así que un atraso se drena en pasadas sucesivas.
 */
const SHIPMENT_STALE_PAGE = 2000;

/**
 * Cuánto reloj le toca a la tienda que viene ahora.
 *
 * POR QUÉ EXISTE ESTA FUNCIÓN, que son cuatro líneas. Hasta hoy el barrido del
 * Master era la ÚLTIMA sentencia de `runStoreSync`, y las tiendas se recorrían en
 * serie bajo un solo `maxDuration`:
 *
 *     for (const id of storeIds) await runStoreSync(id, admin);
 *
 * Sin reparto, la segunda tienda hereda lo que la primera no gastó, y lo primero
 * que muere cuando se acaba el reloj es la última línea de la segunda. Medido en
 * producción el 17-08-2026: Aurela sin un solo pedido desfasado y Kenku con 207,
 * con **50 horas de desfase medio**. La regla del barrido era correcta —el atraso
 * bajó de 955 a ~200 en cuanto se desplegó— pero a una de las dos tiendas no le
 * llegaba nunca.
 *
 * Es el mismo desperfecto que documenta `aliclik-close/route.ts`: un trabajo
 * colgado del final de otro más largo no tiene garantía de ejecutarse jamás. Se
 * arregla igual —reloj propio y repartido— y se deja escrito como función aparte
 * para poder AFIRMAR sobre ella: lo que hay que demostrar es que la última tienda
 * de la cola recibe tiempo, y eso no se ve mirando el bucle.
 */
export function budgetShareMs(remainingMs: number, storesLeft: number): number {
  if (storesLeft <= 0) return 0;
  return Math.max(0, remainingMs) / storesLeft;
}

interface OrderRecord {
  id: string;
  store_id: string;
  shopify_order_id: string;
  name: string | null;
  created_at: string | null;
  cancelled_at: string | null;
  financial_status: string | null;
  shipping_mode: string | null;
  customer_phone: string | null;
  total_amount: number | null;
  raw: unknown;
}

interface ShipmentRecord {
  id: string;
  order_id: string | null;
  store_id: string;
  courier: string;
  guide_code: string | null;
  delivery_status: string;
  status_category: string;
  aliclik_attempts: number | null;
  reroute_attempts: number | null;
  delivered_source: string | null;
  district: string | null;
  province: string | null;
  region: string | null;
  delivery_address: string | null;
  delivery_reference: string | null;
  latitude: number | null;
  longitude: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  created_at: string | null;
  updated_at: string | null;
  assigned_at?: string | null;
  dispatched_at?: string | null;
  out_for_delivery_at?: string | null;
  rescheduled_at?: string | null;
  closed_at?: string | null;
  returned_at?: string | null;
  pickup_state?: string | null;
  agency_branch?: string | null;
  agency_arrived_at?: string | null;
  agency_expires_at?: string | null;
  quoted_delivery_cost?: number | null;
  quoted_return_cost?: number | null;
  created_via?: string | null;
  output_number?: number | null;
  output_code?: string | null;
  qr_token?: string | null;
  preparation_state?: string | null;
  custody_state?: string | null;
  ready_at?: string | null;
  ready_by?: string | null;
  custody_transferred_at?: string | null;
  custody_transferred_by?: string | null;
}

interface CallRecord {
  shipment_id: string;
  kind: string;
  new_status: string | null;
  occurred_at: string;
}

interface EventRecord {
  order_id: string;
  shipment_id: string | null;
  kind: string;
  occurred_at: string;
  actor: string | null;
  courier: string | null;
  new_status: string | null;
  new_operational: string | null;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
}

interface HistoricalGeoRow {
  order_id: string;
  store_id: string;
  customer_phone: string;
  region: string;
  province: string;
  district: string;
  geo_source: string | null;
  order_created_at: string | null;
}

/** Agrupa por una clave, saltando las filas sin clave. */
function groupBy<T>(rows: T[], key: (row: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (!k) continue;
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Fechas de la gestión derivadas del historial de llamadas, para las guías que
 * todavía no tienen las columnas explícitas de 0047. `shipment_calls` registra
 * cada transición de estado, así que el despacho es la PRIMERA vez que la guía
 * entró en "en_ruta" y el cierre la ÚLTIMA vez que entró en un estado terminal.
 * Cuando la columna explícita existe, manda ella.
 */
function derivedGuideDates(calls: CallRecord[]): {
  dispatched_at: string | null;
  rescheduled_at: string | null;
  closed_at: string | null;
  lastCallAt: string | null;
} {
  let dispatched: string | null = null;
  let rescheduled: string | null = null;
  let closed: string | null = null;
  let last: string | null = null;
  for (const c of calls) {
    if (!c.occurred_at) continue;
    if (!last || c.occurred_at > last) last = c.occurred_at;
    if (c.new_status === "en_ruta" && (!dispatched || c.occurred_at < dispatched)) {
      dispatched = c.occurred_at;
    }
    if (c.kind === "reroute" && (!rescheduled || c.occurred_at > rescheduled)) {
      rescheduled = c.occurred_at;
    }
    if (
      (c.new_status === "entregado" || c.new_status === "anulado" || c.new_status === "transferido") &&
      (!closed || c.occurred_at > closed)
    ) {
      closed = c.occurred_at;
    }
  }
  return { dispatched_at: dispatched, rescheduled_at: rescheduled, closed_at: closed, lastCallAt: last };
}

function toGuideSnapshot(s: ShipmentRecord, calls: CallRecord[]): GuideSnapshot {
  const derived = derivedGuideDates(calls);
  return {
    id: s.id,
    courier: s.courier,
    guide_code: s.guide_code,
    delivery_status: s.delivery_status,
    // Aliclik reporta los intentos reales; si no los trae, las reprogramaciones
    // que gestionó el equipo son la mejor aproximación disponible.
    attempts: s.aliclik_attempts ?? s.reroute_attempts ?? 0,
    assigned_at: s.assigned_at ?? s.created_at,
    dispatched_at: s.dispatched_at ?? derived.dispatched_at,
    out_for_delivery_at: s.out_for_delivery_at ?? null,
    rescheduled_at: s.rescheduled_at ?? derived.rescheduled_at,
    closed_at: s.closed_at ?? derived.closed_at,
    returned_at: s.returned_at ?? null,
    pickup_state: s.pickup_state ?? null,
    agency_branch: s.agency_branch ?? null,
    agency_arrived_at: s.agency_arrived_at ?? null,
    agency_expires_at: s.agency_expires_at ?? null,
    // `custody_transferred_at` es una de las guardas de la corrección de
    // registro: si la caja llegó a salir, no se toca el estado.
    custody_transferred_at: s.custody_transferred_at ?? null,
    created_at: s.created_at,
    // Una gestión registrada por el equipo también es un movimiento del pedido.
    updated_at:
      derived.lastCallAt && (!s.updated_at || derived.lastCallAt > s.updated_at)
        ? derived.lastCallAt
        : s.updated_at,
  };
}

function toMacroGuideSnapshot(s: ShipmentRecord, calls: CallRecord[]): MacroGuideSnapshot {
  const guide = toGuideSnapshot(s, calls);
  return {
    id: guide.id,
    courier: guide.courier,
    delivery_status: guide.delivery_status,
    attempts: guide.attempts,
    assigned_at: guide.assigned_at,
    dispatched_at: guide.dispatched_at,
    out_for_delivery_at: guide.out_for_delivery_at,
    rescheduled_at: guide.rescheduled_at,
    returned_at: guide.returned_at,
    pickup_state: guide.pickup_state,
    preparation_state: s.preparation_state ?? null,
    custody_state: s.custody_state ?? null,
  };
}

/** El último override manual: congela el estado frente al recálculo automático. */
function latestOverride(events: EventRecord[]): StatusOverride | null {
  let best: EventRecord | null = null;
  for (const e of events) {
    if (e.kind !== "status_override") continue;
    if (!best || e.occurred_at > best.occurred_at) best = e;
  }
  if (!best || !isGeneralStatus(best.new_status)) return null;
  return {
    general_status: best.new_status,
    operational_status: isOperationalStatus(best.new_operational) ? best.new_operational : null,
    occurred_at: best.occurred_at,
  };
}

async function fetchOrders(admin: SupabaseClient, ids: string[]): Promise<OrderRecord[]> {
  const out: OrderRecord[] = [];
  for (const batch of chunk(ids, ID_BATCH)) {
    const { data, error } = await admin.from("orders").select(ORDER_COLUMNS).in("id", batch);
    if (error) throw new Error(`order_master: no se pudieron leer los pedidos — ${error.message}`);
    out.push(...((data ?? []) as unknown as OrderRecord[]));
  }
  return out;
}

/**
 * Antecedentes de ubicación por tienda + teléfono.
 *
 * No se toma “el último y listo”: para poblar sin intervención tiene que haber
 * dos antecedentes completos que coincidan, o una corrección manual previa.
 * Si hay ubicaciones distintas, no se adivina y el pedido queda Por revisar.
 */
async function fetchHistoricalGeo(
  admin: SupabaseClient,
  orders: readonly OrderRecord[],
): Promise<Map<string, HistoricalGeoRow[]>> {
  const phones = [...new Set(orders.map((o) => o.customer_phone).filter((v): v is string => Boolean(v)))];
  const stores = [...new Set(orders.map((o) => o.store_id))];
  const out = new Map<string, HistoricalGeoRow[]>();
  if (!phones.length || !stores.length) return out;

  for (const phoneBatch of chunk(phones, 50)) {
    const { data, error } = await admin
      .from("order_master")
      .select("order_id,store_id,customer_phone,region,province,district,geo_source,order_created_at")
      .in("customer_phone", phoneBatch);
    if (error) return out;
    for (const row of (data ?? []) as unknown as HistoricalGeoRow[]) {
      if (!stores.includes(row.store_id)) continue;
      if (!row.region || !row.province || !row.district) continue;
      const key = `${row.store_id}|${row.customer_phone}`;
      const bucket = out.get(key);
      if (bucket) bucket.push(row);
      else out.set(key, [row]);
    }
  }
  return out;
}

function historicalGeoSuggestion(
  order: OrderRecord,
  history: Map<string, HistoricalGeoRow[]>,
): HistoricalGeoRow | null {
  if (!order.customer_phone) return null;
  const rows = (history.get(`${order.store_id}|${order.customer_phone}`) ?? []).filter(
    (row) =>
      row.order_id !== order.id &&
      (!order.created_at || !row.order_created_at || row.order_created_at < order.created_at),
  );
  if (!rows.length) return null;

  const key = (row: HistoricalGeoRow) =>
    [row.region, row.province, row.district]
      .map((v) => normalizeDistrict(v))
      .join("|");
  const distinct = new Set(rows.map(key));
  if (distinct.size !== 1) return null;
  const manual = rows.find((row) => row.geo_source === "manual");
  return manual ?? (rows.length >= 2 ? rows[0]! : null);
}

async function fetchShipments(admin: SupabaseClient, ids: string[]): Promise<ShipmentRecord[]> {
  const out: ShipmentRecord[] = [];
  let columnIndex = 0;
  for (const batch of chunk(ids, ID_BATCH)) {
    let data: unknown[] | null = null;
    for (; columnIndex < SHIPMENT_COLUMN_SETS.length; columnIndex++) {
      const res = await admin
        .from("shipments")
        .select(SHIPMENT_COLUMN_SETS[columnIndex]!)
        .in("order_id", batch);
      if (!res.error) {
        data = res.data ?? [];
        break;
      }
      // Última alternativa agotada: es un error real, no un desfase de migración.
      if (columnIndex === SHIPMENT_COLUMN_SETS.length - 1) {
        throw new Error(`order_master: no se pudieron leer las guías — ${res.error.message}`);
      }
    }
    out.push(...((data ?? []) as unknown as ShipmentRecord[]));
  }
  return out;
}

async function fetchCalls(admin: SupabaseClient, shipmentIds: string[]): Promise<CallRecord[]> {
  if (!shipmentIds.length) return [];
  const out: CallRecord[] = [];
  for (const batch of chunk(shipmentIds, ID_BATCH)) {
    const { data, error } = await admin
      .from("shipment_calls")
      .select("shipment_id,kind,new_status,occurred_at")
      .in("shipment_id", batch);
    if (error) throw new Error(`order_master: no se pudo leer el historial — ${error.message}`);
    out.push(...((data ?? []) as unknown as CallRecord[]));
  }
  return out;
}

async function fetchEvents(admin: SupabaseClient, ids: string[]): Promise<EventRecord[]> {
  const out: EventRecord[] = [];
  for (const batch of chunk(ids, ID_BATCH)) {
    const { data, error } = await admin
      .from("order_events")
      .select("order_id,shipment_id,kind,occurred_at,actor,courier,new_status,new_operational,reason,payload")
      .in("order_id", batch);
    if (error) throw new Error(`order_master: no se pudieron leer los eventos — ${error.message}`);
    out.push(...((data ?? []) as unknown as EventRecord[]));
  }
  return out;
}

interface CoverageProbe {
  order_id: string;
  store_id: string;
  region: string | null;
  province: string | null;
  district: string | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * Cobertura canónica desde la base (0104).
 *
 * `order_coverage_for` decide la cobertura COD por nombre de tarifa Y por
 * cercanía a un punto donde Aliclik ya entregó COD (0100). La versión de
 * TypeScript solo sabe lo primero, así que reimplementarla aquí producía filas
 * donde `coverage` decía `provincia_cod` y `macro_operation` decía `agencia`
 * —y el pedido se quedaba esperando un abono que su modalidad no pide—.
 *
 * Devuelve un mapa vacío si la 0104 todavía no está aplicada; quien llama cae
 * entonces a la clasificación por nombre, que es lo que había hasta ahora.
 */
async function fetchCanonicalCoverage(
  admin: SupabaseClient,
  probes: CoverageProbe[],
  day: string,
): Promise<Map<string, OrderCoverage>> {
  const out = new Map<string, OrderCoverage>();
  if (!probes.length) return out;
  for (const batch of chunk(probes, ID_BATCH)) {
    const { data, error } = await admin.rpc("order_coverage_batch", {
      p_rows: batch,
      p_day: day,
    });
    // Sin la migración no hay nada que reconciliar: se sigue con la reserva.
    if (error) return new Map();
    for (const row of (data ?? []) as { order_id: string; coverage: string | null }[]) {
      if (row.coverage) out.set(row.order_id, row.coverage as OrderCoverage);
    }
  }
  return out;
}

/**
 * Provincia por distrito (tabla de referencia 0046). Shopify Perú no entrega el
 * nivel intermedio del ubigeo, así que sin esto el filtro de provincia (§13)
 * solo funcionaría para los pedidos que pasaron por un Excel de Aliclik.
 */
async function fetchGeo(
  admin: SupabaseClient,
  districtKeys: string[],
): Promise<Map<string, { province: string; department: string | null }>> {
  const out = new Map<string, { province: string; department: string | null }>();
  if (!districtKeys.length) return out;
  for (const batch of chunk(districtKeys, ID_BATCH)) {
    const { data, error } = await admin
      .from("peru_districts")
      .select("district_key,province,department")
      .in("district_key", batch);
    // La tabla puede estar aún sin sembrar: el Master funciona igual, solo que
    // la provincia queda en blanco. No es motivo para abortar el recálculo.
    if (error) return out;
    for (const row of (data ?? []) as { district_key: string; province: string; department: string | null }[]) {
      out.set(row.district_key, { province: row.province, department: row.department });
    }
  }
  return out;
}

interface DraftAddress {
  district: string | null;
  province: string | null;
  region: string | null;
  customer_name: string | null;
  address1: string | null;
  referencia: string | null;
}

/** Dirección del pedido para los pedidos sin guía (Lima, sobre todo). */
async function fetchDraftAddresses(
  admin: SupabaseClient,
  orders: OrderRecord[],
): Promise<Map<string, DraftAddress>> {
  const out = new Map<string, DraftAddress>();
  const gids = orders.map((o) => `gid://shopify/Order/${o.shopify_order_id}`);
  if (!gids.length) return out;
  const byGid = new Map(orders.map((o) => [`gid://shopify/Order/${o.shopify_order_id}`, o.id]));
  for (const batch of chunk(gids, ID_BATCH)) {
    const { data, error } = await admin
      .from("draft_orders")
      .select("order_gid,district,province,region,customer_name,address1,referencia")
      .in("order_gid", batch);
    if (error) return out;
    for (const row of (data ?? []) as (DraftAddress & { order_gid: string })[]) {
      const orderId = byGid.get(row.order_gid);
      if (orderId) {
        out.set(orderId, {
          district: row.district,
          province: row.province,
          region: row.region,
          customer_name: row.customer_name,
          address1: row.address1,
          referencia: row.referencia,
        });
      }
    }
  }
  return out;
}

interface PaymentSignals {
  payments: PaymentSnapshot[];
  hasKey: boolean;
  shared: boolean;
}

/**
 * Señales de cobro y clave por pedido (§"Información visible en el Master").
 * Se leen aparte porque las tablas de la fase 3 pueden no existir todavía: si
 * fallan, el Master funciona igual y los indicadores quedan vacíos.
 */
async function fetchPaymentSignals(
  admin: SupabaseClient,
  ids: string[],
): Promise<Map<string, PaymentSignals>> {
  const out = new Map<string, PaymentSignals>();
  const ensure = (orderId: string): PaymentSignals => {
    const found = out.get(orderId);
    if (found) return found;
    const fresh: PaymentSignals = { payments: [], hasKey: false, shared: false };
    out.set(orderId, fresh);
    return fresh;
  };

  for (const batch of chunk(ids, ID_BATCH)) {
    const { data, error } = await admin
      .from("order_payments")
      .select("order_id,kind,validation_status,amount")
      .in("order_id", batch);
    if (error) return out; // la fase 3 aún no está aplicada
    for (const row of (data ?? []) as { order_id: string; kind: string; validation_status: string; amount: number | null }[]) {
      ensure(row.order_id).payments.push({
        kind: row.kind,
        validation_status: row.validation_status,
        order_id: row.order_id,
        amount: row.amount,
      });
    }
  }
  for (const batch of chunk(ids, ID_BATCH)) {
    const { data } = await admin.from("shalom_pickup_keys").select("order_id").in("order_id", batch);
    for (const row of (data ?? []) as { order_id: string }[]) ensure(row.order_id).hasKey = true;
  }
  for (const batch of chunk(ids, ID_BATCH)) {
    const { data } = await admin.from("pickup_key_shares").select("order_id").in("order_id", batch);
    for (const row of (data ?? []) as { order_id: string }[]) ensure(row.order_id).shared = true;
  }
  return out;
}

/**
 * Tarifas logísticas de las organizaciones implicadas (§17). Se congelan en la
 * fila del Master durante el recálculo en vez de resolverse en cada render: son
 * datos con vigencia, y recalcularlos al leer haría que un cambio de tarifa
 * moviera cifras históricas.
 */
async function fetchTariffs(
  admin: SupabaseClient,
  storeIds: string[],
): Promise<{
  tariffs: CostTariff[];
  orgByStore: Map<string, string>;
  confirmationActivationByStore: Map<string, string>;
}> {
  const orgByStore = new Map<string, string>();
  const confirmationActivationByStore = new Map<string, string>();
  const tariffs: CostTariff[] = [];
  if (!storeIds.length) return { tariffs, orgByStore, confirmationActivationByStore };

  for (const batch of chunk(storeIds, ID_BATCH)) {
    const { data, error } = await admin
      .from("stores")
      .select("id,org_id,confirmation_activation_date")
      .in("id", batch);
    let storeRows = (data ?? []) as unknown as {
      id: string;
      org_id: string;
      confirmation_activation_date?: string | null;
    }[];
    // Despliegue compatible: durante los segundos entre código y migración se
    // usa el corte acordado, sin detener la sincronización del Master.
    if (error) {
      const fallback = await admin.from("stores").select("id,org_id").in("id", batch);
      storeRows = (fallback.data ?? []) as unknown as {
        id: string;
        org_id: string;
        confirmation_activation_date?: string | null;
      }[];
    }
    for (const row of storeRows) {
      orgByStore.set(row.id, row.org_id);
      confirmationActivationByStore.set(
        row.id,
        row.confirmation_activation_date ?? "2026-06-01",
      );
    }
  }
  const orgIds = [...new Set(orgByStore.values())];
  if (!orgIds.length) return { tariffs, orgByStore, confirmationActivationByStore };

  const { data, error } = await admin
    .from("cost_tariffs")
    .select("id,org_id,store_id,courier,region,province,district,concept,amount,effective_from,effective_to")
    .in("org_id", orgIds);
  // La fase 4 puede no estar aplicada todavía: sin tarifas, el costo queda vacío.
  if (error) return { tariffs, orgByStore, confirmationActivationByStore };
  tariffs.push(...((data ?? []) as unknown as CostTariff[]));
  return { tariffs, orgByStore, confirmationActivationByStore };
}

function confirmationRollup(events: readonly EventRecord[]) {
  const contacts = new Set<string>(CONFIRMATION_CONTACT_KINDS);
  const followups = new Set<string>(CONFIRMATION_FOLLOWUP_KINDS);
  const latest = (allowed: Set<string>) =>
    events.reduce<EventRecord | null>(
      (best, event) =>
        allowed.has(event.kind) && (!best || event.occurred_at > best.occurred_at)
          ? event
          : best,
      null,
    );
  const contact = latest(contacts);
  const followup = latest(followups);
  const followupWins = Boolean(
    followup && (!contact || followup.occurred_at >= contact.occurred_at),
  );
  const nextContact = followupWins
    ? typeof followup?.payload?.next_contact_on === "string"
      ? followup.payload.next_contact_on
      : null
    : null;
  const reminderDue = !followupWins && contact
    ? typeof contact.payload?.reminder_due_at === "string"
      ? contact.payload.reminder_due_at
      : null
    : null;
  return {
    dayCount: confirmationDayCount(events),
    lastContactAt: contact?.occurred_at ?? null,
    nextContactOn: nextContact,
    reminderDueAt: reminderDue,
    lastActor: contact?.actor ?? null,
  };
}

interface GeoOverride {
  order_id: string;
  region: string | null;
  province: string | null;
  district: string | null;
  address: string | null;
  reference: string | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * Correcciones manuales de ubicación (0051). Ganan sobre Shopify, los reportes
 * de courier y el ubigeo: si alguien del equipo se tomó el trabajo de arreglar
 * una dirección, ninguna sincronización posterior la vuelve a romper.
 */
async function fetchGeoOverrides(
  admin: SupabaseClient,
  ids: string[],
): Promise<Map<string, GeoOverride>> {
  const out = new Map<string, GeoOverride>();
  for (const batch of chunk(ids, ID_BATCH)) {
    const { data, error } = await admin
      .from("order_geo_overrides")
      .select("order_id,region,province,district,address,reference,latitude,longitude")
      .in("order_id", batch);
    if (error) return out; // la migración puede no estar aplicada todavía
    for (const row of (data ?? []) as unknown as GeoOverride[]) out.set(row.order_id, row);
  }
  return out;
}

/**
 * Pedidos cuya guía se escribió después del último recálculo de su Master. Pura.
 *
 * Es la señal que faltaba, y funciona sin saber QUIÉN escribió: una ruta que
 * toca `shipments` y no recalcula deja siempre la misma huella —guía nueva,
 * Master viejo—, así que basta con leerla. Un Master ausente también entra: hay
 * guía y no hay fila que la refleje.
 *
 * La comparación es de cadenas ISO a propósito: vienen de Postgres en UTC con el
 * mismo formato, y `Date.parse` solo añadiría una forma de equivocarse con las
 * fechas raras. El empate NO cuenta como viejo — el recálculo que corre justo
 * después de escribir la guía comparte instante y ya está al día.
 */
export function staleByShipment(
  writes: readonly { order_id: string | null; updated_at: string | null }[],
  masters: readonly { order_id: string; recomputed_at: string | null }[],
): string[] {
  const lastWrite = new Map<string, string>();
  for (const w of writes) {
    if (!w.order_id || !w.updated_at) continue;
    const prev = lastWrite.get(w.order_id);
    if (!prev || w.updated_at > prev) lastWrite.set(w.order_id, w.updated_at);
  }

  const recomputed = new Map<string, string | null>();
  for (const m of masters) recomputed.set(m.order_id, m.recomputed_at);

  const out: string[] = [];
  for (const [orderId, wroteAt] of lastWrite) {
    if (!recomputed.has(orderId)) {
      out.push(orderId);
      continue;
    }
    const at = recomputed.get(orderId);
    if (!at || wroteAt > at) out.push(orderId);
  }
  return out;
}

export interface RecomputeResult {
  requested: number;
  written: number;
  /** Pedidos que no se pudieron recalcular. Solo lo llena el barrido, que va por
   *  tandas y sigue adelante en vez de abortar; si no es cero, quedan etapas
   *  viejas en pantalla y hay que mirar por qué. */
  failed?: number;
  /** Pedidos que no cupieron en el reloj de la pasada. Distinto de `failed`: no
   *  se intentaron, y vuelven solos en la siguiente. */
  deferred?: number;
}

/**
 * Recalcula `order_master` para los pedidos indicados. Idempotente: se puede
 * llamar tantas veces como haga falta con el mismo resultado.
 */
export async function recomputeOrderMaster(
  admin: SupabaseClient,
  orderIds: readonly string[],
  opts: { now?: string } = {},
): Promise<RecomputeResult> {
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (!ids.length) return { requested: 0, written: 0 };
  const now = opts.now ?? new Date().toISOString();

  const orders = await fetchOrders(admin, ids);
  if (!orders.length) return { requested: ids.length, written: 0 };

  const shipments = await fetchShipments(admin, ids);
  const calls = await fetchCalls(admin, shipments.map((s) => s.id));
  const events = await fetchEvents(admin, ids);
  const drafts = await fetchDraftAddresses(admin, orders);
  const geoOverrides = await fetchGeoOverrides(admin, ids);
  const signals = await fetchPaymentSignals(admin, ids);
  const { tariffs, orgByStore, confirmationActivationByStore } = await fetchTariffs(
    admin,
    [...new Set(orders.map((o) => o.store_id))],
  );
  const historicalGeo = await fetchHistoricalGeo(admin, orders);

  const shipmentsByOrder = groupBy(shipments, (s) => s.order_id);
  const callsByShipment = groupBy(calls, (c) => c.shipment_id);
  const eventsByOrder = groupBy(events, (e) => e.order_id);

  // Resolver provincia necesita un ida y vuelta más, así que primero se junta
  // el distrito de cada pedido y luego se consulta el ubigeo de una sola vez.
  const districtByOrder = new Map<string, string | null>();
  for (const order of orders) {
    const address = shopifyShippingAddress(order.raw);
    const guides = shipmentsByOrder.get(order.id) ?? [];
    const draft = drafts.get(order.id);
    const historical = historicalGeoSuggestion(order, historicalGeo);
    districtByOrder.set(
      order.id,
      geoOverrides.get(order.id)?.district ??
        text(address?.city) ??
        guides.find((g) => g.district)?.district ??
        draft?.district ??
        historical?.district ??
        null,
    );
  }
  const geo = await fetchGeo(
    admin,
    [...new Set([...districtByOrder.values()].map((d) => normalizeDistrict(d)).filter(Boolean))],
  );

  // Primera pasada: resolver la UBICACIÓN de cada pedido. Se corta aquí porque
  // la cobertura ya no se calcula en TypeScript —se le pregunta a la base—, y
  // para preguntarla hacen falta región, provincia, distrito y coordenada ya
  // resueltas. Ver `fetchCanonicalCoverage`.
  const geoContexts = orders.map((order) => {
    const guides = shipmentsByOrder.get(order.id) ?? [];
    const orderEvents = eventsByOrder.get(order.id) ?? [];
    const address = shopifyShippingAddress(order.raw);
    const draft = drafts.get(order.id);
    const historical = historicalGeoSuggestion(order, historicalGeo);

    const geoOverride = geoOverrides.get(order.id) ?? null;
    const district = districtByOrder.get(order.id) ?? null;
    const geoHit = geo.get(normalizeDistrict(district));

    // Prioridad de la ubicación, de mayor a menor:
    //   1. corrección manual del equipo (0051),
    //   2. lo que reportó el courier (conoce la zona mejor que el formulario),
    //   3. Shopify / el ubigeo / el draft order.
    const province =
      geoOverride?.province ??
      guides.find((g) => g.province)?.province ??
      geoHit?.province ??
      draft?.province ??
      historical?.province ??
      null;
    // Shopify llama `province` al DEPARTAMENTO (Perú no tiene un tercer nivel).
    const region =
      geoOverride?.region ??
      text(address?.province) ??
      guides.find((g) => g.region)?.region ??
      geoHit?.department ??
      draft?.region ??
      historical?.region ??
      null;
    const guideAddress = guides.find((g) => g.delivery_address);
    const streetAddress =
      geoOverride?.address ?? text(address?.address1) ?? guideAddress?.delivery_address ?? draft?.address1 ?? null;
    const reference =
      geoOverride?.reference ??
      text(address?.address2) ??
      guideAddress?.delivery_reference ??
      draft?.referencia ??
      null;
    // El punto del mapa, de más fiable a menos:
    //
    //   1. La corrección manual del equipo, que gana siempre.
    //   2. Lo que el courier geolocalizó al ir FÍSICAMENTE a la puerta. Es la
    //      verdad de campo: alguien estuvo ahí.
    //   3. Lo que Shopify geocodificó de la dirección escrita. Es una
    //      estimación a partir de texto, así que va después de las dos
    //      anteriores — pero llega desde el minuto cero del pedido, mientras
    //      que las otras dos solo existen después de un intento de entrega o de
    //      una corrección a mano.
    //
    // El punto 3 estuvo en `orders.raw` todo el tiempo sin usarse: la consulta
    // GraphQL no pedía `latitude`/`longitude`, así que solo lo traían los
    // pedidos que entraban por webhook. Es la coordenada que Aliclik exige para
    // cotizar y crear una guía.
    const geoPin = guides.find((g) => g.latitude != null && g.longitude != null);
    const latitude = geoOverride?.latitude ?? geoPin?.latitude ?? address?.latitude ?? null;
    const longitude = geoOverride?.longitude ?? geoPin?.longitude ?? address?.longitude ?? null;
    const geoSource = geoOverride
      ? "manual"
      : geoPin
        ? "courier"
        : address?.latitude != null
          ? "shopify"
          : guides.some((g) => g.province || g.district)
            ? "courier"
            : geoHit
              ? "ubigeo"
              : historical
                ? "history"
              : address
                ? "shopify"
                : draft
                  ? "draft"
                  : null;

    return {
      order,
      guides,
      orderEvents,
      address,
      draft,
      district,
      province,
      region,
      streetAddress,
      reference,
      latitude,
      longitude,
      geoSource,
    };
  });

  // La cobertura la decide `order_coverage_for` en la base, que es su
  // definición canónica: además del match por nombre de tarifa comprueba si el
  // pedido cae cerca de un punto donde Aliclik ya entregó COD (0100). Calcularla
  // aquí en TypeScript dejaba fuera esa regla y contradecía a la columna.
  const coverageByOrder = await fetchCanonicalCoverage(
    admin,
    geoContexts.map((ctx) => ({
      order_id: ctx.order.id,
      store_id: ctx.order.store_id,
      region: ctx.region,
      province: ctx.province,
      district: ctx.district,
      latitude: ctx.latitude,
      longitude: ctx.longitude,
    })),
    now.slice(0, 10),
  );

  const rows = geoContexts.map((ctx) => {
    const {
      order,
      guides,
      orderEvents,
      address,
      draft,
      district,
      province,
      region,
      streetAddress,
      reference,
      latitude,
      longitude,
      geoSource,
    } = ctx;

    const eventSnapshots: OrderEventSnapshot[] = orderEvents.map((e) => ({
      kind: e.kind,
      shipment_id: e.shipment_id,
      occurred_at: e.occurred_at,
      courier: e.courier,
      new_status: e.new_status,
      new_operational: e.new_operational,
    }));
    const override = latestOverride(orderEvents);

    const paymentSignals = signals.get(order.id) ?? null;
    const resolvedPaymentState = paymentSignals
      ? paymentState(paymentSignals.payments, order.total_amount)
      : null;
    // `classifyOrderCoverage` queda como reserva para el caso en que la 0104 no
    // esté aplicada todavía: resuelve solo por nombre, así que da el mismo
    // resultado que la base salvo en los destinos que dependen del mapa COD.
    const resolvedCoverage =
      coverageByOrder.get(order.id) ??
      classifyOrderCoverage(
        {
          storeId: order.store_id,
          orgId: orgByStore.get(order.store_id) ?? null,
          region,
          province,
          district,
        },
        tariffs,
        now.slice(0, 10),
      );

    const state = resolveOrderState({
      order: {
        created_at: order.created_at,
        cancelled_at: order.cancelled_at,
        financial_status: order.financial_status,
        shipping_mode: order.shipping_mode,
      },
      guides: guides.map((s) => toGuideSnapshot(s, callsByShipment.get(s.id) ?? [])),
      events: eventSnapshots,
      override,
      now,
    });
    const macro = resolveMacroStage({
      order: {
        created_at: order.created_at,
        confirmation_activation_date:
          confirmationActivationByStore.get(order.store_id) ?? "2026-06-01",
        cancelled_at: order.cancelled_at,
        financial_status: order.financial_status,
        shipping_mode: order.shipping_mode,
        coverage: resolvedCoverage,
        region,
        province,
        district,
      },
      guides: guides.map((s) => toMacroGuideSnapshot(s, callsByShipment.get(s.id) ?? [])),
      events: orderEvents.map((event) => ({
        kind: event.kind,
        occurred_at: event.occurred_at,
        shipment_id: event.shipment_id,
        reason: event.reason ?? null,
        payload: event.payload ?? null,
      })),
      legacy: {
        general: state.general,
        operational: state.operational,
        since: state.since,
      },
      paymentState: resolvedPaymentState,
    });

    // El costo REAL del envío, cuando el courier nos lo dijo. Solo lo tienen las
    // guías creadas por API: al cotizar, Aliclik devuelve lo que va a cobrar por
    // ESE destino concreto, y se guardó en la guía. Se usa el de la guía VIGENTE
    // —no la primera ni la más barata— porque es la que está entregando.
    //
    // Las tarifas de `cost_tariffs` son una aproximación por distrito que existe
    // porque históricamente el courier no nos daba el precio de cada guía; un
    // precio exacto siempre le gana, y además el margen deja de depender de que
    // alguien mantenga la tabla al día.
    const activeGuide = state.guideCode
      ? guides.find((g) => g.guide_code === state.guideCode)
      : undefined;
    const actualCost =
      activeGuide?.created_via === "aliclik_api"
        ? {
            delivery: num(activeGuide.quoted_delivery_cost),
            return: num(activeGuide.quoted_return_cost),
          }
        : null;

    return {
      store_id: order.store_id,
      order_id: order.id,
      order_name: order.name,
      shopify_order_id: order.shopify_order_id,
      order_created_at: order.created_at,
      customer_name:
        text(address?.name) ?? guides.find((g) => g.customer_name)?.customer_name ?? draft?.customer_name ?? null,
      customer_phone:
        order.customer_phone ?? guides.find((g) => g.customer_phone)?.customer_phone ?? null,
      region,
      province,
      district,
      // La cobertura la recalcula la base en un trigger (migración 0083) y este
      // valor se descarta: la columna es derivada y `order_coverage_for` es su
      // definición canónica. Se sigue mandando para que la fila quede completa
      // aunque el trigger no esté aplicado todavía.
      coverage: resolvedCoverage,
      address: streetAddress,
      reference,
      latitude,
      longitude,
      geo_source: geoSource,
      shipping_mode: order.shipping_mode,
      order_total: order.total_amount,
      general_status: state.general,
      operational_status: state.operational,
      macro_stage: macro.stage,
      macro_substage: macro.substage,
      macro_reasons: macro.reasons,
      macro_operation: macro.operation,
      macro_version: macro.version,
      macro_since: macro.since,
      status_since: state.since,
      status_source: state.source,
      status_locked: Boolean(override),
      current_courier: state.currentCourier,
      last_courier: state.lastCourier,
      courier_count: state.courierCount,
      attempt_count: state.attemptCount,
      guide_code: state.guideCode,
      dispatched_at: state.dispatchedAt,
      delivered_at: state.deliveredAt,
      delivered_courier: state.deliveredCourier,
      returned_at: state.returnedAt,
      last_movement_at: state.lastMovementAt,
      logistics_cost: tariffs.length || actualCost
        ? computeLogisticsCost(tariffs, {
            ctx: {
              storeId: order.store_id,
              courier: state.currentCourier,
              region,
              province,
              district,
            },
            attempts: state.attemptCount,
            generalStatus: state.general,
            agency: Boolean(state.pickupState) || order.shipping_mode === "agency",
            day: costDay({
              last_movement_at: state.lastMovementAt,
              order_created_at: order.created_at,
            }, now),
            actual: actualCost ?? undefined,
          }).total
        : null,
      comment_count: orderEvents.filter((e) => e.kind === "comment").length,
      payment_state: resolvedPaymentState,
      key_state: paymentSignals
        ? keyState({
            orderId: order.id,
            generalStatus: state.general,
            pickupState: state.pickupState,
            payments: paymentSignals.payments,
            orderTotal: order.total_amount,
            hasKey: paymentSignals.hasKey,
            shared: paymentSignals.shared,
          })
        : null,
      pickup_state: state.pickupState,
      agency_branch: state.agencyBranch,
      agency_arrived_at: state.agencyArrivedAt,
      agency_expires_at: state.agencyExpiresAt,
      recomputed_at: now,
      ...(() => {
        const confirmation = confirmationRollup(orderEvents);
        return {
          confirmation_active:
            macro.stage === "por_confirmar" && macro.substage !== "historico_sin_gestion",
          confirmation_day_count: confirmation.dayCount,
          confirmation_last_contact_at: confirmation.lastContactAt,
          confirmation_next_contact_on: confirmation.nextContactOn,
          confirmation_reminder_due_at: confirmation.reminderDueAt,
          confirmation_last_actor: confirmation.lastActor,
        };
      })(),
    };
  });

  let written = 0;
  for (const batch of chunk(rows, ID_BATCH)) {
    let { error } = await admin.from("order_master").upsert(batch, { onConflict: "order_id" });
    // Deploy compatible: si el código llega antes que 0059, el Master antiguo
    // continúa recalculándose. Tras aplicar la migración, el siguiente barrido
    // llena automáticamente las columnas MOM.
    if (
      error &&
      /(macro_(stage|substage|reasons|operation|version|since)|confirmation_(active|day_count|last_contact_at|next_contact_on|reminder_due_at|last_actor))/i.test(
        error.message,
      )
    ) {
      const legacyBatch = batch.map((row) => {
        const copy = { ...row } as Record<string, unknown>;
        delete copy.macro_stage;
        delete copy.macro_substage;
        delete copy.macro_reasons;
        delete copy.macro_operation;
        delete copy.macro_version;
        delete copy.macro_since;
        delete copy.confirmation_active;
        delete copy.confirmation_day_count;
        delete copy.confirmation_last_contact_at;
        delete copy.confirmation_next_contact_on;
        delete copy.confirmation_reminder_due_at;
        delete copy.confirmation_last_actor;
        return copy;
      });
      ({ error } = await admin.from("order_master").upsert(legacyBatch, { onConflict: "order_id" }));
    }
    if (error) throw new Error(`order_master: no se pudo escribir — ${error.message}`);
    written += batch.length;
  }

  // Las tareas son una proyección operativa. Cuando la fuente de verdad ya
  // movió el pedido, se cierran solas para no dejar trabajo fantasma en la cola.
  const leftConfirmation = rows
    .filter((row) => row.macro_stage !== "por_confirmar")
    .map((row) => row.order_id);
  for (const batch of chunk(leftConfirmation, ID_BATCH)) {
    await admin
      .from("order_tasks")
      .update({ status: "cancelled", resolution_note: "El pedido salió de Por confirmar." })
      .in("order_id", batch)
      .eq("status", "pending")
      .in("kind", ["confirmation_reminder", "confirmation_followup"]);
  }
  const cancelledOrders = orders.filter((order) => order.cancelled_at).map((order) => order.id);
  for (const batch of chunk(cancelledOrders, ID_BATCH)) {
    await admin
      .from("order_tasks")
      .update({
        status: "completed",
        completed_at: now,
        resolution_note: "Shopify reportó el pedido anulado.",
      })
      .in("order_id", batch)
      .eq("status", "pending")
      .eq("kind", "shopify_cancellation_review");
  }
  return { requested: ids.length, written };
}

/** Recalcula a partir de guías: resuelve sus pedidos y delega. */
export async function recomputeOrderMasterForShipments(
  admin: SupabaseClient,
  shipmentIds: readonly string[],
): Promise<RecomputeResult> {
  const ids = [...new Set(shipmentIds.filter(Boolean))];
  if (!ids.length) return { requested: 0, written: 0 };
  const orderIds: string[] = [];
  for (const batch of chunk(ids, ID_BATCH)) {
    const { data, error } = await admin.from("shipments").select("order_id").in("id", batch);
    if (error) throw new Error(`order_master: no se pudo resolver el pedido — ${error.message}`);
    for (const row of (data ?? []) as { order_id: string | null }[]) {
      if (row.order_id) orderIds.push(row.order_id);
    }
  }
  return recomputeOrderMaster(admin, orderIds);
}

/** Qué pasó con un recálculo best-effort. */
export interface RecomputeOutcome {
  requested: number;
  written: number;
  /** El mensaje del fallo si el recálculo lanzó; null si no lanzó. */
  error: string | null;
}

/**
 * ¿Quedaron pedidos sin refrescar?
 *
 * Las dos formas del desperfecto cuentan igual, y por eso no basta con mirar la
 * excepción: el recálculo puede **no lanzar** y aun así escribir menos filas de
 * las pedidas —un pedido que ya no está, una tanda que se quedó a medias— y el
 * resultado para quien mira el Master es idéntico: una fila con el estado viejo.
 */
export function recomputeFellShort(outcome: RecomputeOutcome): boolean {
  return Boolean(outcome.error) || outcome.written < outcome.requested;
}

/** La huella que se escribe cuando el recálculo se quedó corto. */
export function describeRecompute(outcome: RecomputeOutcome): string | null {
  if (!recomputeFellShort(outcome)) return null;
  if (outcome.error) {
    return `order_master: el recálculo falló para ${outcome.requested} pedido(s) — ${outcome.error}`;
  }
  const missing = outcome.requested - outcome.written;
  return `order_master: ${missing} de ${outcome.requested} pedido(s) no se refrescaron`;
}

/**
 * Recálculo best-effort: nunca lanza. Para los puntos donde el recálculo es un
 * efecto secundario y no debe tumbar la operación principal (una gestión
 * registrada no se pierde porque el Master no se haya podido refrescar; el
 * barrido del cron lo arreglará).
 *
 * BEST-EFFORT NO ES SIN RASTRO, y la diferencia costó dos meses. Este `catch`
 * vacío se tragó el recálculo de 42 pedidos de Aurela entregados entre el 19-06
 * y el 27-07-2026: sus guías decían «entregado» y su Master seguía en «Por
 * confirmar», así que la cola de llamadas siguió pidiendo confirmar pedidos que
 * el cliente ya tenía en casa. No hubo log, ni contador, ni fila que mirar.
 *
 * Sigue sin lanzar —esa parte era correcta— pero ahora DEVUELVE lo que pasó, y
 * quien lo llame decide dónde dejarlo escrito. `console.error` es el mínimo:
 * que el fallo llegue al menos a los logs de ejecución.
 *
 * Y VA POR TANDAS. Llamar con mil pedidos de una vez hace que uno solo que
 * reviente cueste los mil: todos se quedan con la etapa que tuvieran. Con tandas
 * un fallo cuesta `SAFE_BATCH`, y al reintentar la tanda rota en trozos
 * pequeños, `SAFE_RETRY_BATCH`. No es la causa del incidente del 09-08 —aquello
 * fue SQL a mano, que nunca pasa por aquí— sino el mismo riesgo por otra puerta:
 * el import de Aliclik llega a llamar con más de mil pedidos de golpe.
 */
export interface SafeRecomputeReport {
  requested: number;
  written: number;
  /** Pedidos que se quedaron sin recalcular. Si no es cero, hay etapas viejas. */
  failed: number;
  /** El primer fallo, para que el rastro diga POR QUÉ y no solo cuántos. */
  error: string | null;
  /** Pedidos que no cupieron en el reloj de esta pasada. No es un fallo: vuelven
   *  en la siguiente porque el barrido se ancla en el desfase, no en una lista.
   *  Si no baja nunca, el presupuesto se quedó corto y eso hay que mirarlo. */
  deferred: number;
}

/** Tamaño de tanda del recálculo best-effort. */
const SAFE_BATCH = 100;
/** Trozo del reintento cuando una tanda falla entera. */
const SAFE_RETRY_BATCH = 10;

/**
 * Recorre los ids por tandas y aísla los fallos. Separada de su único uso para
 * poder probarla: lo que hay que demostrar es que un id que revienta cuesta un
 * trozo y no la lista entera, y eso no se ve pasando por Supabase.
 */
export async function recomputeInBatches(
  ids: readonly string[],
  run: (batch: string[]) => Promise<number>,
  opts: { batch?: number; retry?: number; deadline?: number; now?: () => number } = {},
): Promise<SafeRecomputeReport> {
  const unique = [...new Set(ids.filter(Boolean))];
  const size = opts.batch ?? SAFE_BATCH;
  const retrySize = opts.retry ?? SAFE_RETRY_BATCH;
  const clock = opts.now ?? Date.now;
  const report: SafeRecomputeReport = {
    requested: unique.length,
    written: 0,
    failed: 0,
    error: null,
    deferred: 0,
  };
  const note = (error: unknown) => {
    if (report.error === null) {
      report.error = error instanceof Error ? error.message : String(error);
    }
  };

  let done = 0;
  for (const batch of chunk(unique, size)) {
    // El corte va ENTRE tandas, nunca dentro: una tanda a medias dejaría unos
    // recalculados y otros no sin que nadie sepa cuáles. Lo que no cupo se
    // cuenta en `deferred` y entra en la pasada siguiente — el barrido se ancla
    // en el desfase, así que lo aplazado vuelve solo.
    if (opts.deadline !== undefined && clock() > opts.deadline) {
      report.deferred = unique.length - done;
      break;
    }
    done += batch.length;
    try {
      report.written += await run(batch);
      continue;
    } catch (error) {
      // Cae al reintento en trozos: un solo pedido que reviente no debería
      // llevarse por delante a los otros de su tanda.
      note(error);
    }
    for (const small of chunk(batch, retrySize)) {
      try {
        report.written += await run(small);
      } catch (error) {
        note(error);
        report.failed += small.length;
      }
    }
  }

  return report;
}

export async function recomputeOrderMasterSafe(
  admin: SupabaseClient,
  orderIds: readonly string[],
): Promise<RecomputeOutcome> {
  const report = await recomputeInBatches(
    orderIds,
    async (batch) => (await recomputeOrderMaster(admin, batch)).written,
  );
  // `failed` no necesita viajar aparte: quien llama ya se entera por
  // `written < requested`, que es la misma pregunta —¿quedaron etapas viejas?—
  // y la que entienden `recomputeFellShort` y `describeRecompute`.
  const outcome: RecomputeOutcome = {
    requested: report.requested,
    written: report.written,
    error: report.error,
  };
  const trace = describeRecompute(outcome);
  if (trace) console.error(trace);
  return outcome;
}

export async function recomputeOrderMasterForShipmentsSafe(
  admin: SupabaseClient,
  shipmentIds: readonly string[],
): Promise<RecomputeOutcome> {
  const requested = new Set(shipmentIds.filter(Boolean)).size;
  try {
    const { requested: asked, written } = await recomputeOrderMasterForShipments(admin, shipmentIds);
    // `requested` aquí son GUÍAS y `asked` son los PEDIDOS a los que apuntan:
    // no son comparables, así que la cuenta que vale es la de pedidos.
    const outcome = { requested: asked, written, error: null };
    const trace = describeRecompute(outcome);
    if (trace) console.error(trace);
    return outcome;
  } catch (error) {
    const outcome = {
      requested,
      written: 0,
      error: error instanceof Error ? error.message : String(error),
    };
    console.error(describeRecompute(outcome));
    return outcome;
  }
}

/**
 * Barrido de reconciliación: pedidos cuya fila del Master falta o quedó vieja.
 * Es la red de seguridad frente a cualquier ruta que escriba en `shipments` sin
 * recalcular. Se ejecuta desde el cron de sincronización.
 *
 * QUÉ CUENTA COMO «VIEJA». Eran tres cosas —fila ausente, `recomputed_at`
 * anterior a un `staleBefore` que pasara quien llama, y versión del MOM
 * anticuada—, y ninguna miraba las guías. Un pedido con su fila puesta, la
 * versión vigente y una guía escrita DESPUÉS del último recálculo era invisible
 * por las tres a la vez. Como la lista de candidatos salía además de los pedidos
 * más recientes de la tienda, un pedido viejo que se moviera no tenía forma de
 * volver a entrar.
 *
 * LO QUE LO DESTAPÓ, Y POR QUÉ ESTA PUERTA ES LA QUE IMPORTA. El 09-08 se
 * enlazaron 71 guías huérfanas a sus pedidos con SQL a mano contra la base (53 a
 * las 19:24 y 18 a las 21:25, verificado en `pg_stat_statements`). Ninguna ruta
 * de la aplicación intervino, así que no hubo recálculo que pudiera fallar: esos
 * pedidos recibieron su PRIMERA guía y su Master siguió respondiendo lo que
 * habían calculado cuando no tenían ninguna — «Por confirmar · Sin llamar»—,
 * incluyendo pedidos con la guía ya ENTREGADA.
 *
 * Ahí está la lección: no basta con que cada ruta se acuerde de recalcular,
 * porque la escritura puede venir de fuera de la aplicación. El read-model tiene
 * que reconciliarse contra los DATOS. Por eso el ancla es el `updated_at` de la
 * guía y no una llamada: funciona igual si quien escribió fue un import, una
 * acción manual, un cron o una consola de SQL.
 */
export async function reconcileOrderMaster(
  admin: SupabaseClient,
  storeIds: readonly string[],
  opts: { limit?: number; staleBefore?: string; deadline?: number } = {},
): Promise<RecomputeResult> {
  if (!storeIds.length) return { requested: 0, written: 0 };
  const limit = opts.limit ?? PAGE;
  // Pedidos sin fila en el Master todavía. PostgREST no hace anti-joins, así que
  // se comparan los ids ya presentes contra los pedidos recientes de la tienda.
  const { data: orderRows, error: orderErr } = await admin
    .from("orders")
    .select("id")
    .in("store_id", storeIds as string[])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (orderErr) return { requested: 0, written: 0 };
  const candidateIds = ((orderRows ?? []) as { id: string }[]).map((r) => r.id);
  if (!candidateIds.length) return { requested: 0, written: 0 };

  const known = new Set<string>();
  for (const batch of chunk(candidateIds, ID_BATCH)) {
    const { data } = await admin
      .from("order_master")
      .select("order_id,recomputed_at")
      .in("order_id", batch);
    for (const row of (data ?? []) as { order_id: string; recomputed_at: string }[]) {
      if (!opts.staleBefore || row.recomputed_at >= opts.staleBefore) known.add(row.order_id);
    }
  }
  const pending = candidateIds.filter((id) => !known.has(id));

  // CUARTA PUERTA: guías escritas después del último recálculo de su pedido.
  //
  // Se ancla en la ESCRITURA de la guía y no en el pedido, que es lo que la hace
  // funcionar donde las otras tres fallan: alcanza a un pedido de hace tres
  // meses en cuanto su guía se mueve, sin depender de que esté entre los más
  // recientes de la tienda. Se piden las guías tocadas más recientemente porque
  // son las que llevan la etapa equivocada delante de alguien ahora mismo.
  const seenPending = new Set(pending);
  const roomForStale = Math.max(0, limit - pending.length);
  if (roomForStale > 0) {
    const { data: touched } = await admin
      .from("shipments")
      .select("order_id,updated_at")
      .in("store_id", storeIds as string[])
      .not("order_id", "is", null)
      .order("updated_at", { ascending: false })
      .limit(SHIPMENT_STALE_PAGE);

    const writes = (touched ?? []) as { order_id: string | null; updated_at: string | null }[];
    const masters: { order_id: string; recomputed_at: string | null }[] = [];
    const touchedIds = [...new Set(writes.map((w) => w.order_id).filter((v): v is string => Boolean(v)))];
    for (const batch of chunk(touchedIds, ID_BATCH)) {
      const { data } = await admin
        .from("order_master")
        .select("order_id,recomputed_at")
        .in("order_id", batch);
      masters.push(...((data ?? []) as { order_id: string; recomputed_at: string | null }[]));
    }

    for (const id of staleByShipment(writes, masters)) {
      if (seenPending.has(id) || pending.length >= limit) continue;
      pending.push(id);
      seenPending.add(id);
    }
  }

  // Una fase nueva puede cambiar el resultado aun cuando ninguna fuente del
  // pedido haya sido tocada. Recalcula por tandas las filas de versiones
  // anteriores; al escribir la versión vigente dejan de aparecer en el
  // siguiente cron. Así el histórico completo converge sin exponer secretos en
  // un backfill local ni bloquear una sincronización normal.
  // Había aquí una consulta por `macro_version is null` que no podía devolver
  // nada: la columna es NOT NULL en la base. Se quita en vez de dejarla como
  // adorno — una puerta que no abre es peor que no tenerla, porque se cuenta
  // como cobertura cuando se revisa por qué un pedido no se recalculó.
  const remaining = Math.min(VERSION_RECONCILE_PAGE, Math.max(0, limit - pending.length));
  if (remaining > 0) {
    const staleIds: string[] = [];
    {
      const { data: oldVersion } = await admin
        .from("order_master")
        .select("order_id")
        .in("store_id", storeIds as string[])
        .neq("macro_version", MOM_RESOLUTION_VERSION)
        .limit(remaining);
      staleIds.push(...((oldVersion ?? []) as { order_id: string }[]).map((row) => row.order_id));
    }
    const seen = new Set(pending);
    for (const id of staleIds) {
      if (!seen.has(id)) {
        pending.push(id);
        seen.add(id);
      }
    }
  }
  if (!pending.length) return { requested: 0, written: 0 };
  // Por tandas y sin abortar: el barrido es justamente lo que tiene que seguir
  // funcionando cuando un pedido concreto revienta, y hasta ahora un solo fallo
  // dejaba sin recalcular a los otros 999 de la pasada.
  const done = await recomputeInBatches(
    pending,
    async (batch) => (await recomputeOrderMaster(admin, batch)).written,
    { deadline: opts.deadline },
  );
  const trace = describeRecompute({
    requested: done.requested,
    written: done.written,
    error: done.error,
  });
  if (trace) console.error(trace);
  return {
    requested: pending.length,
    written: done.written,
    failed: done.failed,
    deferred: done.deferred,
  };
}
