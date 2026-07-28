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
const SHIPMENT_COLUMN_SETS = [
  SHIPMENT_BASE_COLUMNS + SHIPMENT_GESTION_COLUMNS + SHIPMENT_COST_COLUMNS,
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
}

interface CallRecord {
  shipment_id: string;
  kind: string;
  new_status: string | null;
  occurred_at: string;
}

interface EventRecord {
  order_id: string;
  kind: string;
  occurred_at: string;
  courier: string | null;
  new_status: string | null;
  new_operational: string | null;
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
    created_at: s.created_at,
    // Una gestión registrada por el equipo también es un movimiento del pedido.
    updated_at:
      derived.lastCallAt && (!s.updated_at || derived.lastCallAt > s.updated_at)
        ? derived.lastCallAt
        : s.updated_at,
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
      .select("order_id,kind,occurred_at,courier,new_status,new_operational")
      .in("order_id", batch);
    if (error) throw new Error(`order_master: no se pudieron leer los eventos — ${error.message}`);
    out.push(...((data ?? []) as unknown as EventRecord[]));
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
      .select("order_id,kind,validation_status")
      .in("order_id", batch);
    if (error) return out; // la fase 3 aún no está aplicada
    for (const row of (data ?? []) as { order_id: string; kind: string; validation_status: string }[]) {
      ensure(row.order_id).payments.push({
        kind: row.kind,
        validation_status: row.validation_status,
        order_id: row.order_id,
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
): Promise<{ tariffs: CostTariff[]; orgByStore: Map<string, string> }> {
  const orgByStore = new Map<string, string>();
  const tariffs: CostTariff[] = [];
  if (!storeIds.length) return { tariffs, orgByStore };

  for (const batch of chunk(storeIds, ID_BATCH)) {
    const { data } = await admin.from("stores").select("id,org_id").in("id", batch);
    for (const row of (data ?? []) as { id: string; org_id: string }[]) {
      orgByStore.set(row.id, row.org_id);
    }
  }
  const orgIds = [...new Set(orgByStore.values())];
  if (!orgIds.length) return { tariffs, orgByStore };

  const { data, error } = await admin
    .from("cost_tariffs")
    .select("id,store_id,courier,region,province,district,concept,amount,effective_from,effective_to")
    .in("org_id", orgIds);
  // La fase 4 puede no estar aplicada todavía: sin tarifas, el costo queda vacío.
  if (error) return { tariffs, orgByStore };
  tariffs.push(...((data ?? []) as unknown as CostTariff[]));
  return { tariffs, orgByStore };
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

export interface RecomputeResult {
  requested: number;
  written: number;
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
  const { tariffs } = await fetchTariffs(admin, [...new Set(orders.map((o) => o.store_id))]);

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
    districtByOrder.set(
      order.id,
      geoOverrides.get(order.id)?.district ??
        text(address?.city) ??
        guides.find((g) => g.district)?.district ??
        draft?.district ??
        null,
    );
  }
  const geo = await fetchGeo(
    admin,
    [...new Set([...districtByOrder.values()].map((d) => normalizeDistrict(d)).filter(Boolean))],
  );

  const rows = orders.map((order) => {
    const guides = shipmentsByOrder.get(order.id) ?? [];
    const orderEvents = eventsByOrder.get(order.id) ?? [];
    const address = shopifyShippingAddress(order.raw);
    const draft = drafts.get(order.id);

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
      null;
    // Shopify llama `province` al DEPARTAMENTO (Perú no tiene un tercer nivel).
    const region =
      geoOverride?.region ??
      text(address?.province) ??
      guides.find((g) => g.region)?.region ??
      geoHit?.department ??
      draft?.region ??
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
              : address
                ? "shopify"
                : draft
                  ? "draft"
                  : null;

    const eventSnapshots: OrderEventSnapshot[] = orderEvents.map((e) => ({
      kind: e.kind,
      occurred_at: e.occurred_at,
      courier: e.courier,
      new_status: e.new_status,
      new_operational: e.new_operational,
    }));
    const override = latestOverride(orderEvents);

    const paymentSignals = signals.get(order.id) ?? null;

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
      address: streetAddress,
      reference,
      latitude,
      longitude,
      geo_source: geoSource,
      shipping_mode: order.shipping_mode,
      order_total: order.total_amount,
      general_status: state.general,
      operational_status: state.operational,
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
      payment_state: paymentSignals
        ? paymentState(paymentSignals.payments)
        : null,
      key_state: paymentSignals
        ? keyState({
            orderId: order.id,
            generalStatus: state.general,
            pickupState: state.pickupState,
            payments: paymentSignals.payments,
            hasKey: paymentSignals.hasKey,
            shared: paymentSignals.shared,
          })
        : null,
      pickup_state: state.pickupState,
      agency_branch: state.agencyBranch,
      agency_arrived_at: state.agencyArrivedAt,
      agency_expires_at: state.agencyExpiresAt,
      recomputed_at: now,
    };
  });

  let written = 0;
  for (const batch of chunk(rows, ID_BATCH)) {
    const { error } = await admin.from("order_master").upsert(batch, { onConflict: "order_id" });
    if (error) throw new Error(`order_master: no se pudo escribir — ${error.message}`);
    written += batch.length;
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

/**
 * Recálculo best-effort: nunca lanza. Para los puntos donde el recálculo es un
 * efecto secundario y no debe tumbar la operación principal (una gestión
 * registrada no se pierde porque el Master no se haya podido refrescar; el
 * barrido del cron lo arreglará).
 */
export async function recomputeOrderMasterSafe(
  admin: SupabaseClient,
  orderIds: readonly string[],
): Promise<void> {
  try {
    await recomputeOrderMaster(admin, orderIds);
  } catch {
    // silencioso a propósito — ver el docblock
  }
}

export async function recomputeOrderMasterForShipmentsSafe(
  admin: SupabaseClient,
  shipmentIds: readonly string[],
): Promise<void> {
  try {
    await recomputeOrderMasterForShipments(admin, shipmentIds);
  } catch {
    // silencioso a propósito — ver recomputeOrderMasterSafe
  }
}

/**
 * Barrido de reconciliación: pedidos cuya fila del Master falta o quedó vieja.
 * Es la red de seguridad frente a cualquier ruta que escriba en `shipments` sin
 * recalcular. Se ejecuta desde el cron de sincronización.
 */
export async function reconcileOrderMaster(
  admin: SupabaseClient,
  storeIds: readonly string[],
  opts: { limit?: number; staleBefore?: string } = {},
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
  if (!pending.length) return { requested: 0, written: 0 };
  return recomputeOrderMaster(admin, pending);
}
