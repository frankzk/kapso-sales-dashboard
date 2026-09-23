// Despacho del día (MOM §29.13): lo puro de la pantalla de dos pasos.
// Sin base ni React, probado en test/dispatch-day.test.ts.

import { courierKey, dispatchProgress } from "@/lib/dispatch";
import { MACRO_SUBSTAGES_BY_STAGE, ORDER_MACRO_STAGES, type OrderMacroStage } from "@/lib/order-macro-stage";

export interface DayItem {
  id: string;
  shipment_id: string;
  removed_at?: string | null;
  removal_reason?: string | null;
  office_checked_at?: string | null;
  pickup_checked_at?: string | null;
  /** 0182: el motorizado no lo recogió de su caja. */
  pickup_declined_at?: string | null;
  pickup_declined_reason?: string | null;
  shipment?: { order_id: string | null; order_name: string | null; customer_name: string | null; district: string | null; output_code: string | null; guide_code: string | null; preparation_state?: string | null } | null;
}

export interface DayManifest {
  id: string;
  courier: string;
  route_date: string;
  state: string;
  rider_id?: string | null;
  driver_name: string | null;
  load_number?: number;
  items: DayItem[];
}

export interface RiderBox {
  riderId: string | null;
  riderName: string;
  loads: DayManifest[];
  assigned: number;
  /** Con la salida armada por Almacén (`shipments.preparation_state = listo_despacho`). */
  armed: number;
  officeChecked: number;
  pickupChecked: number;
  declined: number;
  /** El estado de la carga más reciente: es la que se está trabajando. */
  state: string;
}

/** Las cajas de motorizados propios de un día, agrupadas por motorizado. */
export function dayBoxes(manifests: readonly DayManifest[], day: string): RiderBox[] {
  const byRider = new Map<string, RiderBox>();
  for (const m of manifests) {
    if (courierKey(m.courier) !== "propio" || m.route_date !== day || m.state === "cancelled") continue;
    const key = m.rider_id ?? `sin-ficha:${m.driver_name ?? m.id}`;
    const box = byRider.get(key) ?? {
      riderId: m.rider_id ?? null,
      riderName: m.driver_name ?? "Motorizado sin nombre",
      loads: [],
      assigned: 0,
      armed: 0,
      officeChecked: 0,
      pickupChecked: 0,
      declined: 0,
      state: m.state,
    };
    box.loads.push(m);
    const progress = dispatchProgress(m.items);
    box.assigned += progress.total;
    box.armed += m.items.filter((item) => !item.removed_at && isArmed(item)).length;
    box.officeChecked += progress.officeChecked;
    box.pickupChecked += progress.pickupChecked;
    box.declined += m.items.filter((item) => !!item.pickup_declined_at).length;
    byRider.set(key, box);
  }
  for (const box of byRider.values()) {
    box.loads.sort((a, b) => (b.load_number ?? 1) - (a.load_number ?? 1));
    box.state = box.loads[0]?.state ?? box.state;
  }
  return [...byRider.values()].sort((a, b) => a.riderName.localeCompare(b.riderName, "es"));
}

export interface DeclinedPackage {
  manifestId: string;
  shipmentId: string;
  riderId: string | null;
  riderName: string;
  reason: string;
  orderName: string | null;
  customerName: string | null;
  district: string | null;
  orderId: string | null;
}

/** Paquetes que un motorizado no recogió de su caja hoy: los que hay que reasignar. */
export function declinedPackages(boxes: readonly RiderBox[]): DeclinedPackage[] {
  const out: DeclinedPackage[] = [];
  for (const box of boxes) {
    for (const load of box.loads) {
      for (const item of load.items) {
        if (!item.pickup_declined_at) continue;
        out.push({
          manifestId: load.id,
          shipmentId: item.shipment_id,
          riderId: box.riderId,
          riderName: box.riderName,
          reason: item.pickup_declined_reason ?? "sin motivo",
          orderName: item.shipment?.order_name ?? null,
          customerName: item.shipment?.customer_name ?? null,
          district: item.shipment?.district ?? null,
          orderId: item.shipment?.order_id ?? null,
        });
      }
    }
  }
  return out;
}

export interface AssignSplit {
  /** Pedidos disponibles: hay que tomarlos y asignarlos en una sola acción. */
  orderIds: string[];
  /** Solicitudes ya tomadas sin ruta: solo asignar. */
  requestIds: string[];
}

/**
 * Una sola selección mezcla disponibles y tomados sin ruta. Cada uno va por
 * su acción, pero para quien asigna es un solo botón.
 */
export function splitAssignment(
  selected: ReadonlySet<string>,
  available: readonly { orderId: string }[],
  accepted: readonly { orderId: string; requestId: string; route: unknown | null; shipmentId: string | null }[],
): AssignSplit {
  const availableIds = new Set(available.map((o) => o.orderId));
  const orderIds: string[] = [];
  const requestIds: string[] = [];
  for (const id of selected) {
    const taken = accepted.find((o) => o.orderId === id && !o.route && o.shipmentId);
    if (taken) requestIds.push(taken.requestId);
    else if (availableIds.has(id)) orderIds.push(id);
  }
  return { orderIds, requestIds };
}

/** Qué le falta a una caja para que el motorizado pueda salir. */
export function boxNextStep(box: Pick<RiderBox, "assigned" | "officeChecked" | "pickupChecked" | "state">): string {
  if (box.state === "in_custody") return "En poder del motorizado";
  if (!box.assigned) return "Sin paquetes";
  if (box.officeChecked < box.assigned) return `Cotejar ${box.assigned - box.officeChecked} en oficina`;
  if (box.pickupChecked < box.assigned) return `Esperando que el motorizado reciba ${box.assigned - box.pickupChecked}`;
  return "Lista";
}

// ---------------------------------------------------------------------------
// La cola de «Desde la lista» y su filtrado (lo que aportaban las pestañas
// «Pedidos disponibles» y «Pedidos tomados», ahora dentro de Despacho).
// ---------------------------------------------------------------------------

export interface QueueRow {
  orderId: string;
  orderName: string;
  storeName: string;
  customerName: string;
  customerPhone: string | null;
  district: string;
  orderTotal: number;
  /** ISO del pedido en Shopify; null si no se conoce. */
  createdAt: string | null;
  scheduledFor: string;
  tariffAmount: number;
  /** Ya tomado (solicitud sin ruta) o disponible. */
  taken: boolean;
  requestId: string | null;
  /** Solo los tomados: si Almacén ya lo armó. */
  armed: boolean | null;
  observation: string | null;
  /** Tuvo una salida física previa y volvió: «Con salida previa». */
  hasPriorDispatch: boolean;
  /** Macroetapa y subetapa del MOM en el Master (`order_master`); null si no se conoce. */
  macroStage: string | null;
  macroSubstage: string | null;
  /**
   * Si se puede asignar desde la lista (disponible o tomado sin caja). Los
   * demás son pedidos de Grupo GF que ya salieron: se listan para seguimiento
   * cuando se elige su etapa, sin casilla.
   */
  assignable: boolean;
  /** La caja del motorizado, para los que ya salieron. */
  route: QueueRoute | null;
}

export interface QueueRoute {
  riderName: string;
  routeDate: string;
  loadNumber: number;
  state: string;
  officeCheckedAt: string | null;
  pickupCheckedAt: string | null;
  /** «No entregado» y todavía en la caja: se recibe en oficina para reprogramarlo. */
  undeliveredReason?: string | null;
}

/** Un «No entregado» que sigue en la caja del motorizado: se ve en la cola para recibirlo en oficina. */
export function isReturnable(row: Pick<QueueRow, "route">): boolean {
  return Boolean(row.route?.undeliveredReason);
}

export type CreatedWindow = "hoy" | "ayer" | "7d" | "todo";

/** Plazo de la fecha pactada de salida respecto de hoy. */
export type ScheduledBucket = "vencido" | "hoy" | "proximo";

export interface QueueFilters {
  query: string;
  store: string;
  district: string;
  secondAttempt: boolean;
  armedOnly: boolean;
  takenOnly: boolean;
  created: CreatedWindow;
  /** Macroetapas del MOM encendidas (cualquiera de ellas); vacío es «todas». */
  stages: readonly string[];
  /** Subetapas del MOM encendidas (cualquiera de ellas); vacío es «todas». */
  substages: readonly string[];
  /** Plazos de la fecha pactada encendidos (cualquiera de ellos); vacío es «todos». */
  due: readonly ScheduledBucket[];
}

export const EMPTY_QUEUE_FILTERS: QueueFilters = {
  query: "",
  store: "",
  district: "",
  secondAttempt: false,
  armedOnly: false,
  takenOnly: false,
  created: "todo",
  stages: [],
  substages: [],
  due: [],
};

/** Clave de la subetapa de una fila; sin dato en el Master, «sin_subetapa». */
export const NO_SUBSTAGE = "sin_subetapa";
/** Clave de la macroetapa de una fila; sin dato en el Master, «sin_etapa». */
export const NO_STAGE = "sin_etapa";

export function rowSubstage(row: Pick<QueueRow, "macroSubstage">): string {
  return row.macroSubstage || NO_SUBSTAGE;
}

export function rowStage(row: Pick<QueueRow, "macroStage">): string {
  return row.macroStage || NO_STAGE;
}

/**
 * Vencido, hoy o próximo según la fecha pactada de salida (YYYY-MM-DD) frente
 * al día de Lima. Un tomado días atrás cuya salida ya pasó es «vencido».
 */
export function scheduledBucket(scheduledFor: string, today: string): ScheduledBucket {
  const day = scheduledFor.slice(0, 10);
  if (day < today) return "vencido";
  if (day === today) return "hoy";
  return "proximo";
}

export const SCHEDULED_BUCKET_LABEL: Record<ScheduledBucket, string> = {
  vencido: "Vencidos",
  hoy: "Hoy",
  proximo: "Próximos",
};

export const SCHEDULED_BUCKETS: readonly ScheduledBucket[] = ["vencido", "hoy", "proximo"];

/** Enciende o apaga un valor en un grupo de chips de selección múltiple. */
export function toggleInList<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** Solo dígitos, para comparar teléfonos escritos con espacios, «+» o guiones. */
export function phoneDigits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D+/g, "");
}

/** Fecha Lima (YYYY-MM-DD) de un ISO, o null. */
export function limaDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso.slice(0, 10) || null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(parsed);
  return parts;
}

function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d! + delta));
  return date.toISOString().slice(0, 10);
}

/** Si la fecha de creación cae en la ventana elegida (hoy, ayer, últimos 7 días). */
export function inCreatedWindow(createdAt: string | null | undefined, window: CreatedWindow, today: string): boolean {
  if (window === "todo") return true;
  const day = limaDay(createdAt);
  if (!day) return false;
  if (window === "hoy") return day === today;
  if (window === "ayer") return day === shiftDay(today, -1);
  return day >= shiftDay(today, -6) && day <= today;
}

/**
 * Tienda × distrito × salida previa × armados × tomados × fecha × etapas ×
 * subetapas × plazo × texto (pedido, cliente, distrito o teléfono). Dentro de
 * un grupo de chips basta con cumplir uno; entre grupos se exigen todos.
 *
 * Sin ninguna etapa elegida la lista es la cola de asignación (solo
 * `assignable`): es para lo que está la pantalla. Elegir una etapa abre esa
 * etapa entera, también los pedidos que ya salieron, para seguimiento.
 * `includeTracked` fuerza mirar todos, para contar las etapas.
 */
export function filterQueue(rows: readonly QueueRow[], filters: QueueFilters, today: string, opts: { includeTracked?: boolean } = {}): QueueRow[] {
  const needle = filters.query.trim().toLocaleLowerCase("es");
  const digits = phoneDigits(needle);
  const byPhone = digits.length >= 4 && digits.length === needle.replace(/[\s+\-().]/g, "").length;
  const onlyAssignable = !filters.stages.length && !opts.includeTracked;
  return rows.filter((q) => {
    if (onlyAssignable && !q.assignable && !isReturnable(q)) return false;
    if (filters.store && q.storeName !== filters.store) return false;
    if (filters.district && q.district !== filters.district) return false;
    if (filters.secondAttempt && !q.hasPriorDispatch) return false;
    if (filters.armedOnly && !q.armed) return false;
    if (filters.takenOnly && !q.taken) return false;
    if (!inCreatedWindow(q.createdAt, filters.created, today)) return false;
    if (filters.stages.length && !filters.stages.includes(rowStage(q))) return false;
    if (filters.substages.length && !filters.substages.includes(rowSubstage(q))) return false;
    if (filters.due.length && !filters.due.includes(scheduledBucket(q.scheduledFor, today))) return false;
    if (!needle) return true;
    if (byPhone && phoneDigits(q.customerPhone).includes(digits)) return true;
    return `${q.orderName} ${q.customerName} ${q.district} ${q.storeName} ${q.customerPhone ?? ""}`.toLocaleLowerCase("es").includes(needle);
  });
}

/** Cuántos filtros están activos (el texto no cuenta: tiene su propio campo). Cada grupo de chips cuenta una vez. */
export function activeFilterCount(filters: QueueFilters): number {
  return [filters.store, filters.district, filters.secondAttempt, filters.armedOnly, filters.takenOnly, filters.created !== "todo", filters.stages.length > 0, filters.substages.length > 0, filters.due.length > 0].filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Chips de etapa, subetapa y fecha pactada en el picker de Filtros, como en
// el Master. Etapa cuenta TODOS los pedidos de Grupo GF (la cola más los que
// ya salieron); las subetapas solo aparecen con una etapa elegida y son las
// de esa etapa. Cada chip lleva su cantidad facetada: cuántas filas quedarían
// al tocarlo con el resto de filtros tal como están, sin contar los chips de
// su propio grupo. Así el número de un chip encendido coincide con «N en cola».
// ---------------------------------------------------------------------------

/** Subetapas que la cola admite, en el orden del MOM. */
export const QUEUE_ADMISSION_SUBSTAGES: readonly { stage: string; substage: string }[] = [
  { stage: "preparacion", substage: "por_generar_rotulo" },
  { stage: "preparacion", substage: "por_armar" },
  { stage: "por_despachar", substage: "listo_para_asignar" },
];

export interface QueueSubstageOption {
  stage: string | null;
  substage: string;
}

/**
 * Las subetapas a mostrar: ninguna sin etapa elegida; con etapas, las del
 * MOM de cada una en su orden (aunque estén en cero) y, detrás, cualquier
 * otra que traiga una fila de esa etapa (un dato viejo del Master).
 */
export function queueSubstageOptions(rows: readonly QueueRow[], stages: readonly string[]): QueueSubstageOption[] {
  if (!stages.length) return [];
  const out: QueueSubstageOption[] = [];
  const seen = new Set<string>();
  for (const stage of ORDER_MACRO_STAGES) {
    if (!stages.includes(stage.code)) continue;
    for (const substage of MACRO_SUBSTAGES_BY_STAGE[stage.code]) {
      out.push({ stage: stage.code, substage });
      seen.add(substage);
    }
  }
  const extra: QueueSubstageOption[] = [];
  for (const row of rows) {
    if (!stages.includes(rowStage(row))) continue;
    const key = rowSubstage(row);
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push({ stage: row.macroStage, substage: key });
  }
  extra.sort((a, b) => a.substage.localeCompare(b.substage, "es"));
  return [...out, ...extra];
}

/**
 * Cambiar las etapas encendidas apaga las subetapas que ya no están a la
 * vista: un chip encendido que no se ve no se puede apagar.
 */
export function setStages(filters: QueueFilters, stages: readonly string[]): QueueFilters {
  const canonical = new Set<string>();
  for (const stage of stages) {
    for (const substage of MACRO_SUBSTAGES_BY_STAGE[stage as OrderMacroStage] ?? []) canonical.add(substage);
  }
  const known = new Set<string>(Object.values(MACRO_SUBSTAGES_BY_STAGE).flat());
  const substages = stages.length
    ? filters.substages.filter((code) => canonical.has(code) || !known.has(code))
    : [];
  return { ...filters, stages: [...stages], substages };
}

export interface QueueFacetCounts {
  /** Filas que cumplen todo menos el grupo de etapas, por macroetapa. */
  stage: Record<string, number>;
  /** Filas que cumplen todo menos el grupo de subetapas; es el «Todas» del grupo. */
  substageTotal: number;
  substage: Record<string, number>;
  /** Filas que cumplen todo menos el grupo de plazos; es el «Todos los plazos». */
  dueTotal: number;
  due: Record<ScheduledBucket, number>;
}

export function queueFacetCounts(rows: readonly QueueRow[], filters: QueueFilters, today: string): QueueFacetCounts {
  const stage: Record<string, number> = {};
  // Etapa cuenta sobre todos los pedidos de Grupo GF, no solo la cola.
  for (const row of filterQueue(rows, { ...filters, stages: [] }, today, { includeTracked: true })) {
    const key = rowStage(row);
    stage[key] = (stage[key] ?? 0) + 1;
  }
  const forSubstage = filterQueue(rows, { ...filters, substages: [] }, today);
  const substage: Record<string, number> = {};
  for (const row of forSubstage) {
    const key = rowSubstage(row);
    substage[key] = (substage[key] ?? 0) + 1;
  }
  const forDue = filterQueue(rows, { ...filters, due: [] }, today);
  const due: Record<ScheduledBucket, number> = { vencido: 0, hoy: 0, proximo: 0 };
  for (const row of forDue) due[scheduledBucket(row.scheduledFor, today)] += 1;
  return { stage, substageTotal: forSubstage.length, substage, dueTotal: forDue.length, due };
}

export const CREATED_WINDOW_LABEL: Record<CreatedWindow, string> = {
  hoy: "creados hoy",
  ayer: "creados ayer",
  "7d": "últimos 7 días",
  todo: "cualquier fecha",
};

/** Por qué un pedido de Lima no entra en la cola («sin condiciones»). */
export type BlockedReason = "ya_en_caja" | "sin_salida" | "distrito_invalido" | "tarifa_faltante" | "servicio_pausado";

export const BLOCKED_REASON_LABEL: Record<BlockedReason, { label: string; fix: "tarifario" | "despacho" | "pedido" }> = {
  ya_en_caja: { label: "Ya está en una caja de despacho", fix: "despacho" },
  sin_salida: { label: "Sin salida armable en Almacén", fix: "pedido" },
  distrito_invalido: { label: "Distrito inválido o sin contrato", fix: "pedido" },
  tarifa_faltante: { label: "Tarifa faltante para el distrito", fix: "tarifario" },
  servicio_pausado: { label: "Servicio pausado en el distrito", fix: "tarifario" },
};

// ---------------------------------------------------------------------------
// Estado de cada paquete dentro de la caja (lo que separaban los segmentos de
// «Pedidos tomados»: por armar · armado · cotejado · confirmado · no lo llevó).
// ---------------------------------------------------------------------------

export function isArmed(item: Pick<DayItem, "shipment">): boolean {
  return item.shipment?.preparation_state === "listo_despacho";
}

export type PackageStage = "no_lo_llevo" | "confirmado" | "cotejado" | "armado" | "por_armar";

/** La etapa más avanzada del paquete; «no lo llevó» manda sobre todo. */
export function packageStage(item: Pick<DayItem, "pickup_declined_at" | "pickup_checked_at" | "office_checked_at" | "shipment">): PackageStage {
  if (item.pickup_declined_at) return "no_lo_llevo";
  if (item.pickup_checked_at) return "confirmado";
  if (item.office_checked_at) return "cotejado";
  if (isArmed(item)) return "armado";
  return "por_armar";
}

export const PACKAGE_STAGE_LABEL: Record<PackageStage, string> = {
  por_armar: "por armar",
  armado: "armado",
  cotejado: "cotejado",
  confirmado: "confirmado",
  no_lo_llevo: "no lo llevó",
};

export type BoxItemFilter = "todos" | "por_armar" | "listos_cotejo" | "sin_confirmar";

export const BOX_ITEM_FILTERS: ReadonlyArray<{ id: BoxItemFilter; label: string }> = [
  { id: "todos", label: "Todos" },
  { id: "por_armar", label: "Por armar" },
  { id: "listos_cotejo", label: "Listos para cotejo" },
  { id: "sin_confirmar", label: "Sin confirmar" },
];

/** Filtro rápido de la caja desplegada. Solo sobre los activos. */
export function filterBoxItems<T extends Pick<DayItem, "removed_at" | "pickup_declined_at" | "pickup_checked_at" | "office_checked_at" | "shipment">>(items: readonly T[], filter: BoxItemFilter): T[] {
  return items.filter((item) => {
    if (item.removed_at) return false;
    if (filter === "todos") return true;
    if (filter === "por_armar") return !isArmed(item);
    if (filter === "listos_cotejo") return isArmed(item) && !item.office_checked_at;
    return !item.pickup_checked_at;
  });
}

// ---------------------------------------------------------------------------
// Tiles de métricas encima de Asignar: cada una es un filtro con su cantidad.
// Misma fuente de verdad que el picker (`QueueFilters`) y el filtro rápido de
// las cajas (`BoxItemFilter`); aquí solo se decide qué toca cada tile.
// ---------------------------------------------------------------------------

export type QueueTile = "por_asignar" | "tomados_sin_caja" | "armados" | "segundo_intento";
export type BoxTile = "por_armar" | "listos_cotejo" | "sin_confirmar";

export const QUEUE_TILE_LABEL: Record<QueueTile, { label: string; hint: string }> = {
  por_asignar: { label: "Por asignar", hint: "Pedidos de Lima con condiciones para salir y sin caja: disponibles más tomados sin ruta. Quita los filtros de la lista." },
  tomados_sin_caja: { label: "Tomados sin caja", hint: "Ya tomados por Grupo GF (servicio y tarifa reservados) pero todavía sin motorizado." },
  armados: { label: "Armados", hint: "Tomados cuya salida ya armó Almacén (listo para despacho) y siguen sin caja." },
  segundo_intento: { label: "Con salida previa", hint: "Ya tuvieron al menos una salida física y volvieron: revísalos como reprogramaciones o recuperaciones antes de volver a tomarlos." },
};

export const BOX_TILE_LABEL: Record<BoxTile, { label: string; hint: string }> = {
  por_armar: { label: "Por armar", hint: "En una caja de hoy y Almacén todavía no lo armó." },
  listos_cotejo: { label: "Listos para cotejo", hint: "Armados por Almacén y todavía sin cotejar en oficina." },
  sin_confirmar: { label: "Sin confirmar", hint: "En una caja de hoy y el motorizado aún no dijo «Lo llevo»." },
};

export function queueTileCounts(rows: readonly QueueRow[]): Record<QueueTile, number> {
  return {
    por_asignar: rows.length,
    tomados_sin_caja: rows.filter((q) => q.taken).length,
    armados: rows.filter((q) => q.armed).length,
    segundo_intento: rows.filter((q) => q.hasPriorDispatch).length,
  };
}

export function boxTileCounts(boxes: readonly RiderBox[]): Record<BoxTile, number> {
  const items = boxes.flatMap((b) => b.loads.flatMap((l) => l.items));
  return {
    por_armar: filterBoxItems(items, "por_armar").length,
    listos_cotejo: filterBoxItems(items, "listos_cotejo").length,
    sin_confirmar: filterBoxItems(items, "sin_confirmar").length,
  };
}

/** Si la tile está «encendida» con los filtros actuales. */
export function queueTileActive(filters: QueueFilters, tile: QueueTile): boolean {
  if (tile === "por_asignar") return false;
  if (tile === "tomados_sin_caja") return filters.takenOnly;
  if (tile === "armados") return filters.armedOnly;
  return filters.secondAttempt;
}

/** Tocar una tile: enciende su filtro (o lo apaga si ya estaba); «Por asignar» limpia todos. */
export function toggleQueueTile(filters: QueueFilters, tile: QueueTile): QueueFilters {
  if (tile === "por_asignar") return { ...EMPTY_QUEUE_FILTERS, query: filters.query };
  if (tile === "tomados_sin_caja") return { ...filters, takenOnly: !filters.takenOnly };
  if (tile === "armados") return { ...filters, armedOnly: !filters.armedOnly };
  return { ...filters, secondAttempt: !filters.secondAttempt };
}

export function toggleBoxTile(current: BoxItemFilter, tile: BoxTile): BoxItemFilter {
  return current === tile ? "todos" : tile;
}
