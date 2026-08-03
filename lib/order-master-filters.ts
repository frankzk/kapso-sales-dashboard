// Filtros y orden del listado del Master. Puro + testeado, igual que
// lib/shipment-sort.ts: el board de React solo compone estado; la decisión de
// qué fila entra y en qué orden vive aquí, donde se puede probar.
//
// Todos los filtros son combinables (§13) y los de dimensión (tienda, estado,
// courier, región, provincia, distrito, modalidad) son multi-selección:
// un conjunto VACÍO significa "todas", nunca "ninguna".

import type { OrderMasterRow } from "@/lib/types";

export interface MasterFilters {
  stores: Set<string>;
  generalStatuses: Set<string>;
  operationalStatuses: Set<string>;
  couriers: Set<string>;
  shippingModes: Set<string>;
  regions: Set<string>;
  provinces: Set<string>;
  districts: Set<string>;
  coverages: Set<string>;
  /** YYYY-MM-DD; extremos inclusive, vacío = sin límite. */
  createdFrom: string;
  createdTo: string;
  dispatchedFrom: string;
  dispatchedTo: string;
  movementFrom: string;
  movementTo: string;
  deliveredFrom: string;
  deliveredTo: string;
  withComments: boolean;
  /** Sin movimientos en los últimos `staleDays` días. 0 = filtro apagado. */
  staleDays: number;
  multiCourier: boolean;
  multiAttempt: boolean;
  /** Sub-estados del flujo de agencia (§10). Vacío = no filtra. */
  pickupStates: Set<string>;
  /** Solo pedidos en agencia con el plazo de recojo a punto de vencer. */
  expiringSoon: boolean;
  /** Búsqueda libre sobre código, cliente, teléfono y guía. */
  search: string;
}

export function emptyFilters(): MasterFilters {
  return {
    stores: new Set(),
    generalStatuses: new Set(),
    operationalStatuses: new Set(),
    couriers: new Set(),
    shippingModes: new Set(),
    regions: new Set(),
    provinces: new Set(),
    districts: new Set(),
    coverages: new Set(),
    createdFrom: "",
    createdTo: "",
    dispatchedFrom: "",
    dispatchedTo: "",
    movementFrom: "",
    movementTo: "",
    deliveredFrom: "",
    deliveredTo: "",
    withComments: false,
    staleDays: 0,
    multiCourier: false,
    multiAttempt: false,
    pickupStates: new Set(),
    expiringSoon: false,
    search: "",
  };
}

/** ¿Hay algún filtro activo? Para poder ofrecer "limpiar filtros". */
export function hasActiveFilters(f: MasterFilters): boolean {
  return (
    f.stores.size > 0 ||
    f.generalStatuses.size > 0 ||
    f.operationalStatuses.size > 0 ||
    f.couriers.size > 0 ||
    f.shippingModes.size > 0 ||
    f.regions.size > 0 ||
    f.provinces.size > 0 ||
    f.districts.size > 0 ||
    f.coverages.size > 0 ||
    Boolean(f.createdFrom || f.createdTo) ||
    Boolean(f.dispatchedFrom || f.dispatchedTo) ||
    Boolean(f.movementFrom || f.movementTo) ||
    Boolean(f.deliveredFrom || f.deliveredTo) ||
    f.withComments ||
    f.staleDays > 0 ||
    f.multiCourier ||
    f.multiAttempt ||
    f.pickupStates.size > 0 ||
    f.expiringSoon ||
    f.search.trim().length > 0
  );
}

/** Margen con el que un recojo se considera "próximo a vencer": 3 días. */
export const EXPIRING_WINDOW_MS = 3 * 86_400_000;

/** Un conjunto vacío no filtra; si no, la fila debe pertenecer al conjunto. */
function inSet(set: Set<string>, value: string | null | undefined): boolean {
  if (!set.size) return true;
  return value != null && set.has(value);
}

/** Rango de fechas sobre un timestamp ISO, comparando por día calendario. */
function inDateRange(iso: string | null | undefined, from: string, to: string): boolean {
  if (!from && !to) return true;
  if (!iso) return false;
  const day = iso.slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

/** Normaliza para la búsqueda libre: minúsculas y sin el `#` del código. */
function haystack(row: OrderMasterRow): string {
  return [row.order_name, row.customer_name, row.customer_phone, row.guide_code]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function matchesFilters(
  row: OrderMasterRow,
  f: MasterFilters,
  now: string = new Date().toISOString(),
): boolean {
  if (!inSet(f.stores, row.store_id)) return false;
  if (!inSet(f.generalStatuses, row.general_status)) return false;
  if (!inSet(f.operationalStatuses, row.operational_status)) return false;
  if (!inSet(f.shippingModes, row.shipping_mode)) return false;
  if (!inSet(f.regions, row.region)) return false;
  if (!inSet(f.provinces, row.province)) return false;
  if (!inSet(f.districts, row.district)) return false;
  if (!inSet(f.coverages, row.coverage)) return false;

  // El filtro de courier mira el actual Y el último: buscar "los pedidos que
  // tocó Fenix" no debe perder los que ya pasaron a otra guía.
  if (f.couriers.size) {
    const matches =
      (row.current_courier != null && f.couriers.has(row.current_courier)) ||
      (row.last_courier != null && f.couriers.has(row.last_courier));
    if (!matches) return false;
  }

  if (!inDateRange(row.order_created_at, f.createdFrom, f.createdTo)) return false;
  if (!inDateRange(row.dispatched_at, f.dispatchedFrom, f.dispatchedTo)) return false;
  if (!inDateRange(row.last_movement_at, f.movementFrom, f.movementTo)) return false;
  if (!inDateRange(row.delivered_at, f.deliveredFrom, f.deliveredTo)) return false;

  if (f.withComments && row.comment_count <= 0) return false;
  if (f.multiCourier && row.courier_count <= 1) return false;
  if (f.multiAttempt && row.attempt_count <= 1) return false;

  if (!inSet(f.pickupStates, row.pickup_state)) return false;

  if (f.expiringSoon) {
    // "Próximo a vencer" es lo que hay que trabajar HOY para que el paquete no
    // se devuelva: se incluye tanto lo que vence pronto como lo ya vencido.
    if (!row.agency_expires_at) return false;
    const left = Date.parse(row.agency_expires_at) - Date.parse(now);
    if (!Number.isFinite(left) || left > EXPIRING_WINDOW_MS) return false;
  }

  if (f.staleDays > 0) {
    // "Sin movimientos recientes": un pedido que nunca se movió también cuenta —
    // es justamente el que nadie está mirando.
    const cutoff = Date.parse(now) - f.staleDays * 86_400_000;
    const last = row.last_movement_at ? Date.parse(row.last_movement_at) : null;
    if (last !== null && Number.isFinite(last) && last > cutoff) return false;
  }

  const q = f.search.trim().toLowerCase().replace(/^#/, "");
  if (q && !haystack(row).includes(q)) return false;

  return true;
}

export function applyFilters(
  rows: readonly OrderMasterRow[],
  f: MasterFilters,
  now?: string,
): OrderMasterRow[] {
  return rows.filter((r) => matchesFilters(r, f, now));
}

export type MasterSortKey =
  | "created"
  | "movement"
  | "status_age"
  | "attempts"
  | "couriers"
  | "total";

/**
 * Orden del listado. El Master abre por "fecha de creación", que deja el
 * correlativo corrido; "último movimiento" está a un clic para detectar lo que
 * se quedó quieto. Los nulos van siempre al final: un pedido sin fecha no debe
 * encabezar la tabla por accidente.
 */
export function sortRows(
  rows: readonly OrderMasterRow[],
  key: MasterSortKey,
  direction: "asc" | "desc" = "desc",
): OrderMasterRow[] {
  const dir = direction === "asc" ? 1 : -1;
  const value = (r: OrderMasterRow): number | null => {
    switch (key) {
      case "created":
        return r.order_created_at ? Date.parse(r.order_created_at) : null;
      case "movement":
        return r.last_movement_at ? Date.parse(r.last_movement_at) : null;
      case "status_age":
        return r.status_since ? Date.parse(r.status_since) : null;
      case "attempts":
        return r.attempt_count;
      case "couriers":
        return r.courier_count;
      case "total":
        return r.order_total;
    }
  };
  return [...rows].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // nulos al final, en ambas direcciones
    if (bv === null) return -1;
    return av === bv ? 0 : (av < bv ? -1 : 1) * dir;
  });
}

/** Valores presentes en las filas, para poblar los selectores multi-opción. */
export function facetValues(
  rows: readonly OrderMasterRow[],
  field:
    | "region"
    | "province"
    | "district"
    | "current_courier"
    | "operational_status"
    | "pickup_state"
    | "agency_branch",
): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const v = r[field];
    if (typeof v === "string" && v) seen.add(v);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, "es"));
}

export interface AgencySummary {
  total: number;
  disponibles: number;
  proximosAVencer: number;
  retornoIniciado: number;
  devueltos: number;
}

/**
 * Sub-estados que cuentan como "disponible para recojo" en el resumen.
 *
 * SE EXPORTA PARA QUE NO HAYA DOS LISTAS. El resumen existe dos veces —acá en
 * cliente y en `getAgencySummary` de servidor— y allá se contaba
 * `pickup_state = 'disponible'`, un valor que no existe en el catálogo. No
 * fallaba: devolvía 0, y el panel enseñaba "0 disponibles para recojo" con 49
 * paquetes esperando en destino. Un contador equivocado que no rompe se lee
 * como "no hay nada que hacer".
 */
export const AGENCY_AVAILABLE_STATES = [
  "disponible_para_recojo",
  "pendiente_de_recojo",
] as const;

/**
 * Resumen del seguimiento de agencia (§10). Es la pantalla que evita la
 * devolución: entre el 5 % y el 6 % de estos pedidos termina devuelto por no
 * recogerse a tiempo, y lo que hay que mirar cada día es qué está disponible y
 * qué está a punto de vencer.
 */
export function agencySummary(
  rows: readonly OrderMasterRow[],
  now: string = new Date().toISOString(),
): AgencySummary {
  const nowMs = Date.parse(now);
  let total = 0;
  let disponibles = 0;
  let proximosAVencer = 0;
  let retornoIniciado = 0;
  let devueltos = 0;

  for (const r of rows) {
    const inAgency = Boolean(r.pickup_state) || r.shipping_mode === "agency";
    if (!inAgency) continue;
    total++;
    if (r.general_status === "devuelto") {
      devueltos++;
      continue;
    }
    if (r.pickup_state === "retorno_iniciado") retornoIniciado++;
    if (AGENCY_AVAILABLE_STATES.includes(r.pickup_state as (typeof AGENCY_AVAILABLE_STATES)[number])) {
      disponibles++;
    }
    if (r.agency_expires_at) {
      const left = Date.parse(r.agency_expires_at) - nowMs;
      if (Number.isFinite(left) && left <= EXPIRING_WINDOW_MS) proximosAVencer++;
    }
  }
  return { total, disponibles, proximosAVencer, retornoIniciado, devueltos };
}
