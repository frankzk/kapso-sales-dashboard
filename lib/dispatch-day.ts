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
  /**
   * Salió a reparto al menos una vez (`DEPARTURE_EVENT_KINDS`, parada
   * reportada o despacho de otro courier): apartado «Ya salieron».
   */
  hasPriorDispatch: boolean;
  /** Fecha de salida programada sin tomar el pedido (0199); null si no hay. */
  programmedFor: string | null;
  /** Motivo de la programación, para el `title` de la chapa. */
  programReason?: string | null;
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
  /**
   * Otro courier no lo entregó (v1.19, `lib/gf-retry.ts`): quién y si su caja
   * ya volvió. Al asignarlo se crea una salida nueva y Almacén arma otra caja.
   */
  failedOutput?: { courier: string; returned: boolean } | null;
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

/**
 * Etapas en que un pedido ya tomado deja de asignarse: está cerrándose o
 * cerrado (29-09-2026). #KP136160, #KP136100 y #KP136653 estaban anulados y
 * seguían con casilla en «Desde la lista». La solicitud no se cancela sola:
 * el MOM no lo dice y un pedido se puede reabrir; si vuelve, vuelve a la cola.
 */
export const CLOSED_FOR_ASSIGNMENT_STAGES: readonly string[] = ["por_cerrar", "finalizado"];

/** Si un tomado sin caja se puede asignar según la macroetapa del Master. Sin dato, sí. */
export function takenIsAssignable(macroStage: string | null | undefined): boolean {
  return !macroStage || !CLOSED_FOR_ASSIGNMENT_STAGES.includes(macroStage);
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
  /** Apartado de la cola; null es «Todos». No cuenta como filtro del picker: tiene su propia fila. */
  segment: QueueSegment | null;
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
  segment: null,
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
 * Apartado × tienda × distrito × armados × tomados × fecha × etapas ×
 * subetapas × plazo × texto (pedido, cliente, distrito o teléfono). Dentro de
 * un grupo de chips basta con cumplir uno; entre grupos se exigen todos.
 *
 * Sin ninguna etapa elegida la lista es la cola de asignación (solo
 * `assignable`): es para lo que está la pantalla. Elegir una etapa abre esa
 * etapa entera, también los pedidos que ya salieron, para seguimiento.
 * `includeTracked` fuerza mirar todos, para contar las etapas. Un apartado
 * solo reúne pedidos que se pueden asignar.
 */
export function filterQueue(rows: readonly QueueRow[], filters: QueueFilters, today: string, opts: { includeTracked?: boolean } = {}): QueueRow[] {
  const needle = filters.query.trim().toLocaleLowerCase("es");
  const digits = phoneDigits(needle);
  const byPhone = digits.length >= 4 && digits.length === needle.replace(/[\s+\-().]/g, "").length;
  const onlyAssignable = !filters.stages.length && !opts.includeTracked;
  return rows.filter((q) => {
    if (onlyAssignable && !q.assignable && !isReturnable(q)) return false;
    if (filters.segment && (!q.assignable || queueSegment(q, today) !== filters.segment)) return false;
    if (filters.store && q.storeName !== filters.store) return false;
    if (filters.district && q.district !== filters.district) return false;
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

/**
 * Cuántos filtros están activos. El texto y el apartado no cuentan: cada uno
 * tiene su propio sitio a la vista. Cada grupo de chips cuenta una vez.
 */
export function activeFilterCount(filters: QueueFilters): number {
  return [filters.store, filters.district, filters.armedOnly, filters.takenOnly, filters.created !== "todo", filters.stages.length > 0, filters.substages.length > 0, filters.due.length > 0].filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Apartados de la cola (29-09-2026). «Que tengan un apartado como un subestado,
// simulado al "Sin llamar" de Por confirmar, donde se busca dejarlo en cero lo
// antes posible.» Cada pedido asignable cae en uno solo, y la lista los ordena
// en este orden: lo programado para hoy y mañana es un compromiso con la clienta; lo
// que nunca salió va antes que un reintento; lo de más de 30 días, después de
// lo reciente; lo programado para después de mañana, al final.
// ---------------------------------------------------------------------------

export type QueueSegment = "programados_hoy" | "programados_manana" | "nunca_salieron" | "ya_salieron" | "mas_de_30" | "programados_despues";

export const QUEUE_SEGMENTS: readonly QueueSegment[] = ["programados_hoy", "programados_manana", "nunca_salieron", "ya_salieron", "mas_de_30", "programados_despues"];

/** Un pedido que nunca salió y se creó hace más de esto va a «+30 días». */
export const STALE_AFTER_DAYS = 30;

export const QUEUE_SEGMENT_LABEL: Record<QueueSegment, { label: string; hint: string }> = {
  programados_hoy: { label: "Programados hoy", hint: "Con salida programada para hoy, o para un día que ya pasó sin que saliera. Van primero: es la fecha que se le dio a la clienta." },
  programados_manana: { label: "Programados para mañana", hint: "Con salida programada para mañana. Al llegar ese día pasan a «Programados hoy»." },
  nunca_salieron: { label: "Nunca salieron", hint: `Nunca tuvieron una salida a reparto y se crearon en los últimos ${STALE_AFTER_DAYS} días. Es el apartado a dejar en cero.` },
  ya_salieron: { label: "Ya salieron", hint: "Salieron a reparto al menos una vez y volvieron: reprogramaciones o recuperaciones. Van después de los que nunca salieron." },
  mas_de_30: { label: `+${STALE_AFTER_DAYS} días`, hint: `Nunca salieron y se crearon hace más de ${STALE_AFTER_DAYS} días: se revisan después de los recientes.` },
  programados_despues: { label: "Programados después", hint: "Con salida programada para después de mañana. Al acercarse la fecha pasan a «Programados para mañana» y luego a «Programados hoy»." },
};

/**
 * Qué cuenta como «salió a reparto» en `order_events`: el motorizado se llevó
 * el paquete («Lo llevo»), reportó en la puerta, o el paquete volvió a oficina.
 * `custody_transferred` NO: en el modo «confirmar» la custodia pasa al asignar,
 * antes de que el paquete deje el almacén, y un retirado de la caja antes de
 * salir contaría como reintento. Crear o anular un rótulo tampoco (§29.2).
 */
export const DEPARTURE_EVENT_KINDS = ["pickup_checked", "stop_reported", "returned_to_office", "delivered_unconfirmed_pickup"] as const;

/** El apartado de un pedido asignable. La programación manda sobre todo lo demás. */
export function queueSegment(row: Pick<QueueRow, "programmedFor" | "hasPriorDispatch" | "createdAt">, today: string): QueueSegment {
  if (row.programmedFor) {
    const programmedDay = row.programmedFor.slice(0, 10);
    if (programmedDay <= today) return "programados_hoy";
    return programmedDay === shiftDay(today, 1) ? "programados_manana" : "programados_despues";
  }
  if (row.hasPriorDispatch) return "ya_salieron";
  const created = limaDay(row.createdAt);
  // Sin fecha de creación no se esconde en «+30 días»: se queda en la cola a dejar en cero.
  if (created && created < shiftDay(today, -STALE_AFTER_DAYS)) return "mas_de_30";
  return "nunca_salieron";
}

const SEGMENT_RANK = new Map<QueueSegment, number>(QUEUE_SEGMENTS.map((segment, i) => [segment, i]));

/**
 * El orden de la lista: por apartado; dentro de lo programado, por la fecha
 * (lo vencido primero); en el resto, del pedido más reciente al más antiguo
 * (§29.2). Lo que no se asigna (seguimiento, «No entregado» en caja) va detrás.
 */
export function sortQueue<T extends QueueRow>(rows: readonly T[], today: string): T[] {
  const keyed = rows.map((row, i) => ({
    row,
    i,
    rank: row.assignable ? SEGMENT_RANK.get(queueSegment(row, today))! : QUEUE_SEGMENTS.length,
    program: row.programmedFor ?? "",
    created: row.createdAt ? Date.parse(row.createdAt) || 0 : -Infinity,
  }));
  keyed.sort((a, b) => a.rank - b.rank || a.program.localeCompare(b.program) || b.created - a.created || a.i - b.i);
  return keyed.map((k) => k.row);
}

/**
 * Asignar a la caja de `boxDay` un pedido programado para otro día pide
 * confirmar. Lo vencido no: que salga es justo lo que falta.
 */
export function programNeedsConfirm(programmedFor: string | null | undefined, boxDay: string, today: string): boolean {
  if (!programmedFor) return false;
  const day = programmedFor.slice(0, 10);
  return day >= today && day !== boxDay;
}

const WEEKDAYS_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

/** `2026-10-02` → «vie 02/10». */
export function programDayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return day;
  const weekday = WEEKDAYS_SHORT[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
  return `${weekday} ${m[3]}/${m[2]}`;
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
  // Con una etapa elegida la lista es de seguimiento y los apartados no se ven.
  return { ...filters, stages: [...stages], substages, segment: stages.length ? null : filters.segment };
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
  /** Filas que cumplen todo menos el apartado; es el «Todos» de la fila de apartados. */
  segmentTotal: number;
  segment: Record<QueueSegment, number>;
}

export function queueFacetCounts(rows: readonly QueueRow[], filters: QueueFilters, today: string): QueueFacetCounts {
  const forSegment = filterQueue(rows, { ...filters, segment: null }, today);
  const segment = Object.fromEntries(QUEUE_SEGMENTS.map((s) => [s, 0])) as Record<QueueSegment, number>;
  for (const row of forSegment) if (row.assignable) segment[queueSegment(row, today)] += 1;
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
  return { stage, substageTotal: forSubstage.length, substage, dueTotal: forDue.length, due, segmentTotal: forSegment.length, segment };
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

/** Tiles de la cola; las de apartado encienden ese apartado. */
export type QueueTile = "por_asignar" | "nunca_salieron" | "programados_hoy" | "por_reprogramar" | "tomados_sin_caja" | "armados";
export type BoxTile = "por_armar" | "listos_cotejo" | "sin_confirmar";

const SEGMENT_TILES = new Set<QueueTile>(["nunca_salieron", "programados_hoy"]);

export const QUEUE_TILE_LABEL: Record<QueueTile, { label: string; hint: string }> = {
  por_asignar: { label: "Por asignar", hint: "Pedidos de Lima con condiciones para salir y sin caja: disponibles más tomados sin ruta. Quita los filtros de la lista." },
  nunca_salieron: QUEUE_SEGMENT_LABEL.nunca_salieron,
  programados_hoy: QUEUE_SEGMENT_LABEL.programados_hoy,
  por_reprogramar: { label: "Por reprogramar", hint: "No entregados (En curso · Por reprogramar Lima): los del motorizado que siguen en su caja se reciben en oficina; los que ya volvieron, y los que otro courier no entregó, se asignan o se programan con el calendario. Lo de otro courier sale en una salida nueva." },
  tomados_sin_caja: { label: "Tomados sin caja", hint: "Ya tomados por Grupo GF (servicio y tarifa reservados) pero todavía sin motorizado." },
  armados: { label: "Armados", hint: "Tomados cuya salida ya armó Almacén (listo para despacho) y siguen sin caja." },
};

export const BOX_TILE_LABEL: Record<BoxTile, { label: string; hint: string }> = {
  por_armar: { label: "Por armar", hint: "En una caja de hoy y Almacén todavía no lo armó." },
  listos_cotejo: { label: "Listos para cotejo", hint: "Armados por Almacén y todavía sin cotejar en oficina." },
  sin_confirmar: { label: "Sin confirmar", hint: "En una caja de hoy y el motorizado aún no dijo «Lo llevo»." },
};

/** Un pedido de Grupo GF en «En curso · Por reprogramar Lima». */
export function isPorReprogramar(row: Pick<QueueRow, "macroStage" | "macroSubstage">): boolean {
  return row.macroStage === "en_curso" && row.macroSubstage === "por_reprogramar_lima";
}

/**
 * `rows` es la cola de asignación; `allRows` suma los que ya salieron, porque
 * «Por reprogramar» cuenta también los no entregados que siguen en una caja.
 */
export function queueTileCounts(rows: readonly QueueRow[], allRows: readonly QueueRow[], today: string): Record<QueueTile, number> {
  const segments = rows.map((q) => queueSegment(q, today));
  return {
    por_asignar: rows.length,
    nunca_salieron: segments.filter((s) => s === "nunca_salieron").length,
    programados_hoy: segments.filter((s) => s === "programados_hoy").length,
    por_reprogramar: allRows.filter(isPorReprogramar).length,
    tomados_sin_caja: rows.filter((q) => q.taken).length,
    armados: rows.filter((q) => q.armed).length,
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
  if (tile === "por_reprogramar") return filters.stages.length === 1 && filters.stages[0] === "en_curso" && filters.substages.length === 1 && filters.substages[0] === "por_reprogramar_lima";
  if (tile === "tomados_sin_caja") return filters.takenOnly;
  if (tile === "armados") return filters.armedOnly;
  return filters.segment === tile;
}

/** Tocar una tile: enciende su filtro (o lo apaga si ya estaba); «Por asignar» limpia todos. */
export function toggleQueueTile(filters: QueueFilters, tile: QueueTile): QueueFilters {
  if (tile === "por_asignar") return { ...EMPTY_QUEUE_FILTERS, query: filters.query };
  if (tile === "por_reprogramar") {
    return queueTileActive(filters, tile)
      ? { ...filters, stages: [], substages: [] }
      : { ...filters, stages: ["en_curso"], substages: ["por_reprogramar_lima"], segment: null };
  }
  if (tile === "tomados_sin_caja") return { ...filters, takenOnly: !filters.takenOnly };
  if (tile === "armados") return { ...filters, armedOnly: !filters.armedOnly };
  if (SEGMENT_TILES.has(tile)) {
    // Un apartado es de la cola de asignación: apaga el seguimiento por etapa.
    return queueTileActive(filters, tile)
      ? { ...filters, segment: null }
      : { ...filters, segment: tile as QueueSegment, stages: [], substages: [] };
  }
  return filters;
}

export function toggleBoxTile(current: BoxItemFilter, tile: BoxTile): BoxItemFilter {
  return current === tile ? "todos" : tile;
}
