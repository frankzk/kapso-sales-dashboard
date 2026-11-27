// Repro Lima: la cola de trabajo amplia. Son filtros de lectura del Master;
// ver un pendiente no crea un caso de entrega fallida ni autoriza otra salida.
//
// Desde el 15-11-2026 (owner; MOM §9.5) la pantalla ordena esta cola por las
// tareas del equipo en tres bloques —«Por gestionar hoy», «Agenda» y «En manos
// del courier»—, que calcula lib/repro-lima-blocks.ts. Aquí quedan la fila, sus
// fechas, los filtros de la barra y las piezas que comparten.
import { MACRO_SUBSTAGES_BY_STAGE, macroStageLabel, macroSubstageLabel, type OrderMacroStage } from "@/lib/order-macro-stage";
import { tandersReleaseCutoff } from "@/lib/gf-tanders-review";
import type { ReproList } from "@/lib/repro-lima";
import { limaDay, programDayLabel, queueSegment, type QueueSegment } from "@/lib/dispatch-day";
import { SALES_CHANNEL_OPTIONS } from "@/lib/sales-channel";
import type { PlanBox } from "@/lib/dispatch-plan";
import { courierDisplayName } from "@/lib/dispatched-with";

/** Lo que la cola mira del caso de Repro Lima (`ReproRow`). */
export type PendingCase = {
  orderId: string; list: ReproList;
  /** El reintento por Aliclik que toca (lib/lima-retry-chain.ts), o null. */
  retryChain?: unknown;
  agreement?: { agreedOn: string; courier?: string; courierName?: string } | null;
  program?: { scheduledFor: string } | null;
  /** La próxima llamada del caso («Llamar después», «No contesta»). */
  nextCallAt?: string | null;
  lastCall?: { at: string; outcome?: string | null } | null;
};

/** La fecha acordada vigente manda sobre un programa anterior que aún no se
 * actualizó. Sin acuerdo vigente, se usa una programación persistida y, sin
 * ella, el día en que Aliclik recoge la guía que ya tiene (owner, 07-11-2026)
 * o el que se le pidió a GF Courier para la suya (15-11-2026): un pedido
 * agendado con el courier no «nunca salió» sin gestión. Así un acuerdo con GF
 * Courier conserva su día en la Agenda aunque su caso se cierre al crear la
 * guía (el pedido deja «Por reprogramar Lima»). */
export function limaScheduledFor(row: LimaPendingOrder, c?: PendingCase): string | null {
  return (c?.list === "programados" ? c.agreement?.agreedOn : null) ?? row.programmedFor ?? c?.program?.scheduledFor ??
    row.courierPickup?.date ?? null;
}

export function limaQueueSegment(row: LimaPendingOrder, today: string, c?: PendingCase): QueueSegment {
  return queueSegment({ programmedFor: limaScheduledFor(row, c), hasPriorDispatch: row.hasPriorDispatch, createdAt: row.createdAt }, today);
}

/**
 * Lo que no se creó al aprobar varios, una línea por motivo (owner,
 * 08-11-2026: 21 pedidos repetían la misma frase). El motivo una vez y, al
 * final, sus pedidos; el motivo con más pedidos primero. Con un solo pedido,
 * «#KP1: motivo», como antes.
 */
export function groupApprovalFailures(failed: readonly { orderName: string; error: string }[]): string[] {
  const byError = new Map<string, string[]>();
  for (const f of failed) byError.set(f.error, [...(byError.get(f.error) ?? []), f.orderName]);
  return [...byError.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([error, names]) => (names.length === 1 ? `${names[0]}: ${error}` : `${error} Pedidos (${names.length}): ${names.join(", ")}.`));
}

/**
 * «Reintentos Aliclik»: a quién aprueba el botón de la barra (owner,
 * 06-11-2026). Los marcados que siguen listos y a la vista; sin ninguno
 * marcado, todos los listos, como antes. Un marcado que dejó de estar listo o
 * que un filtro esconde no se aprueba.
 */
export function retryApprovalTargets<T extends { orderId: string }>(ready: readonly T[], selected: ReadonlySet<string>): { rows: T[]; picked: boolean } {
  const picked = ready.filter((row) => selected.has(row.orderId));
  return picked.length ? { rows: picked, picked: true } : { rows: [...ready], picked: false };
}

export const LIMA_PENDING_STAGES = ["por_confirmar", "preparacion", "por_despachar", "en_curso"] as const;
export type LimaPendingStage = typeof LIMA_PENDING_STAGES[number];
export interface LimaPendingOrder {
  orderId: string;
  storeId: string;
  storeName: string;
  orderName: string;
  customerName: string;
  customerPhone: string | null;
  district: string | null;
  orderTotal: number;
  createdAt: string | null;
  macroSince: string | null;
  stage: LimaPendingStage;
  substage: string | null;
  courier: string | null;
  dispatchedAt: string | null;
  attempts: number;
  /** Gestión histórica del mismo pedido; una lectura fallida no produce falsos «sin llamar». */
  management?: { hasCall: boolean; lastCallAt: string | null; lastCallResult: string | null; movedToLimaAt: string | null };
  /** Couriers y motorizados comprobados del Master o reconstruidos desde rutas reportadas. */
  dispatchedWith?: string[];
  /** El historial vacío se reconstruyó de rutas fechadas con resultado y motorizado. */
  historyFromRoutes?: boolean;
  hasPriorDispatch: boolean;
  lastDepartureAt: string | null;
  /**
   * «Por reprogramar Lima» cuya caja nunca salió (owner, 18-11-2026, #KP206971):
   * su courier anuló la guía antes de recogerla, con la caja en la empresa, y
   * no hay ninguna salida previa ni intento (`limaBoxNeverLeft`). No es un no
   * entregado: es su primera salida pendiente.
   */
  neverLeft?: boolean;
  programmedFor: string | null;
  /** Por dónde se generó (`order_master.sales_channel`, 0264); null sin calcular. */
  salesChannel: string | null;
  /** La dirección de entrega y su referencia, tal como están en el Master. */
  address: string | null;
  reference: string | null;
  /**
   * La guía de un courier externo que espera su recojo (§9.5, owner
   * 07-11-2026): Aliclik con la guía viva, sin salida ni retorno. `date`
   * es el día de recojo: el que reportó Aliclik o, sin reporte, el de su regla
   * de corte. Desde el 15-11-2026, también la guía de GF Courier sin salir,
   * con el día que se le pidió a GF (`scheduled_date`): el del acuerdo de Repro
   * Lima o el de «Programar envío». Sin guía esperando, null.
   */
  courierPickup?: { courier: "aliclik" | "gf_courier"; date: string } | null;
  /**
   * GF Courier volvió a programar su guía viva después de la novedad, con la
   * misma guía (owner, 21-11-2026, #KP207270: «pedido ya listo en Grupo GF para
   * que salga el 24/11… debería salirse de la lista y pasar a programados»): el
   * día en que vuelve a salir. Es el último `order.delivery_date_changed`,
   * recibido después del último cambio de estado (`gfRescheduleAfterIncident`).
   * GF deja la incidencia viva hasta que sale (§29.17). Con él, el pedido
   * también tiene su `courierPickup` de GF Courier con ese día. Sin eso, null.
   */
  gfRescheduled?: { date: string } | null;
  /**
   * Quién lleva su distrito según el reparto de 30 días (`lib/lima-rider-suggest.ts`): uno, dos o null. Solo
   * con guía de GF Courier sin motorizado (`shownRiderSuggestion`): lo que se muestra; el filtro «Motorizado» lo usa sin asignado.
   */
  suggestedRiders?: string[] | null;
  /**
   * El motorizado que GF Courier tiene asignado ahora a su guía viva, con el día de la ruta (`gfAssignedFromEvents`,
   * su último aviso de estado): «Alexis · ruta del 17/11». Con asignado no hay sugerencia; asignado para la ruta de
   * hoy, la fila va a «Con el courier · Asignado hoy» (owner, 27-11-2026). Sin guía GF viva, sin aviso de GF o ya
   * retirado de la carga, null.
   */
  gfAssigned?: { rider: string; day: string | null; routeDate?: string | null } | null;
  /**
   * El detalle de su courier vigente (owner, 08-11-2026: «no me das grupo gf
   * alexis o aliclik autoecom»): el motorizado de su última caja de Grupo GF, o
   * el transporte de su guía Aliclik (AUTOECOM, ALIDRIVER). Null si no hay.
   */
  courierDetail?: string | null;
  /**
   * Lo de Grupo GF (la caja, la solicitud, el rótulo y el armado); null si no
   * sale con Grupo GF. Desde el 15-11-2026 Repro Lima no lo enseña: lo leen los
   * trabados de Grupo GF que viven en Despacho del día (§9.6, §29.16).
   */
  gf?: LimaPendingGf | null;
  /** «Programar envío» (§6.2, `order_master.dispatch_scheduled_on`): solo en Por generar rótulo. */
  scheduledOn?: string | null;
  /** El courier de ese «Programar envío» (0348, `order_master.dispatch_courier`): `propio`, `gf_courier`, `aliclik` o `fenix`. */
  scheduledCourier?: string | null;
  /** Lo que dicen sus salidas, para «Lima trabados» (§9.6); null en Por confirmar o sin salidas. */
  ops?: LimaPendingOps | null;
}

/**
 * Las salidas del pedido vistas para «Lima trabados» (§9.6), leídas de la
 * misma lectura de `shipments` que «Sale a reparto». Solo hechos: el motivo lo
 * decide `limaStuck` (lib/lima-stuck.ts).
 */
export interface LimaPendingOps {
  /** Swayp Generada, en empresa y sin evidencia de despacho de su salida viva. */
  pickupPending?: boolean;
  /** Última salida devuelta y ninguna salida viva posterior. */
  returnedToWarehouse?: boolean;
  /** Todas las guías GF vivas provienen del automático y siguen sin recoger ni despachar. */
  autoGfGuide?: boolean;
  /** Custodia de la salida viva más reciente o, sin ella, de la última salida. */
  custody?: string | null;
  /** Documentos de todas sus salidas, incluidas las anuladas; no son repartos. */
  guides?: { total: number; annulled: number; returned: number; cancelRequested?: number };
  /** Los couriers de sus salidas vivas (`pendiente`/`en_ruta`, sin retorno ni devolución), la más nueva primero. */
  liveCouriers: string[];
  /** Lo último que reportó el courier de la salida viva más nueva (`shipments.reported_status`). */
  reportedStatus: string | null;
  /** La guía de esa salida viva más nueva si es de GF Courier (para leer sus avisos), o null. */
  gfGuide?: string | null;
  /**
   * Una salida que el courier da por entregada con el pedido todavía abierto:
   * guía `entregado`, o viva con `DELIVERED` (Tanders lo deja `en_ruta` hasta
   * validar la constancia, §9.4). null si no hay.
   */
  courierDelivered: { courier: string } | null;
  /** La caja de Grupo GF más reciente de su salida viva (de cualquier día), o null. */
  lastGfBox: { day: string; riderName: string | null } | null;
}

export interface LimaPendingGf {
  /** Su caja activa de Grupo GF, si ya está en una. */
  box: PlanBox | null;
  /** El día de la solicitud que tomó Grupo GF, si la tomó. */
  requestDay: string | null;
  /** Su salida tiene QR (rótulo). */
  labeled: boolean;
  /** Almacén la armó (`listo_despacho`). */
  armed: boolean;
  /** Sin caja vigente y todavía con el motorizado en la caja de un día que pasó. */
  awaitingOffice?: boolean;
  /**
   * Su única caja de Grupo GF es de un día que pasó: ni la solicitud vieja ni
   * el corte le dan día; solo el acuerdo o el programa.
   */
  pastBox?: boolean;
}

// ---------------------------------------------------------------------------
// Los filtros de la barra, junto a Tienda (owner, 06-11-2026): los del Master
// que sirven en Lima. Creación, Canal, Distrito y Courier. Vacíos, no filtran.

export interface LimaRowFilters {
  /** `YYYY-MM-DD` del día de creación en Lima, o vacío. */
  createdFrom: string;
  createdTo: string;
  channels: ReadonlySet<string>;
  districts: ReadonlySet<string>;
  couriers: ReadonlySet<string>;
  /**
   * «Motorizado» (owner, 17-11-2026: «cámbialo a Motorizado»): el motorizado que GF ya asignó o, sin asignado, el
   * sugerido por su distrito; o `sin_motorizado`. Antes «Sugerido».
   */
  suggested: ReadonlySet<string>;
}

export const NO_SUGGESTED = "sin_motorizado";

/** El motorizado de la fila: el asignado por GF; sin él, los sugeridos (uno o dos); si no, `sin_motorizado`. */
export function suggestedKeys(row: Pick<LimaPendingOrder, "suggestedRiders" | "gfAssigned">): string[] {
  if (row.gfAssigned?.rider) return [row.gfAssigned.rider];
  return row.suggestedRiders?.length ? row.suggestedRiders : [NO_SUGGESTED];
}

const PRE_DISPATCH_STAGES = new Set(["por_confirmar", "preparacion", "por_despachar"]);

/** Hechos positivos de salida; nunca se deduce una salida de una guía creada. */
export function limaHasDeparture(row: Pick<LimaPendingOrder, "hasPriorDispatch" | "dispatchedAt" | "attempts"> & Partial<Pick<LimaPendingOrder, "dispatchedWith" | "lastDepartureAt">>): boolean {
  return Boolean(row.hasPriorDispatch || row.dispatchedAt || row.lastDepartureAt || row.attempts > 0 || row.dispatchedWith?.length);
}

/**
 * «Nuevo» (owner, 17-11-2026: «para poder diferenciarlos exactamente»): el
 * pedido que sale por PRIMERA vez —nunca salió a reparto, sin intentos— y
 * todavía no sale. Lo distingue de lo reprogramado. También el «Por
 * reprogramar Lima» cuya caja nunca salió (`neverLeft`, 18-11-2026): el
 * courier anuló la guía antes de recogerla. Pura.
 */
export function limaIsNew(row: Pick<LimaPendingOrder, "stage" | "hasPriorDispatch" | "dispatchedAt" | "attempts" | "neverLeft"> & Partial<Pick<LimaPendingOrder, "dispatchedWith" | "lastDepartureAt">>): boolean {
  return (PRE_DISPATCH_STAGES.has(row.stage) || row.neverLeft === true)
    && !limaHasDeparture(row);
}

/** Lo de una guía que dice si su caja llegó a salir de la empresa. */
export interface NeverLeftGuide {
  courier: string | null;
  delivery_status: string;
  custody_state?: string | null;
  dispatched_at?: string | null;
  out_for_delivery_at?: string | null;
  returned_at?: string | null;
}

/** Las salidas que no son de un courier que recoge: la propia de Grupo GF, las agencias y «por definir». */
const NOT_PICKUP_COURIERS = new Set(["propio", "shalom", "olva", "por_definir"]);

/**
 * ¿La caja de este pedido nunca salió de la empresa? (owner, 18-11-2026,
 * #KP206971: «este pedido nunca salió a reparto»). Sí cuando un courier que
 * recoge (GF Courier, Aliclik, Swayp…) anuló su guía ANTES de recogerla
 * (`guideAnnulledBeforeDispatch`, que abre la recuperación y lo deja en «Por
 * reprogramar Lima») y ninguna guía del pedido salió, volvió ni pasó a manos
 * de un courier: todas siguen con la caja en la empresa. Pura.
 */
export function limaBoxNeverLeft(guides: readonly NeverLeftGuide[]): boolean {
  const left = guides.some((g) => g.dispatched_at || g.out_for_delivery_at || g.returned_at || (g.custody_state ?? "empresa") !== "empresa");
  if (left) return false;
  return guides.some((g) => g.delivery_status === "anulado" && !NOT_PICKUP_COURIERS.has((g.courier ?? "").trim().toLowerCase()));
}


export type LimaFilterOption = { value: string; label: string; count: number };

export const NO_COURIER = "sin_courier";
export const NO_DISTRICT = "sin_distrito";
const ROW_FILTER_PARAMS = { channels: "canal", districts: "distrito", couriers: "courier", suggested: "motorizado", createdFrom: "creado_desde", createdTo: "creado_hasta" } as const;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function emptyRowFilters(): LimaRowFilters {
  return { createdFrom: "", createdTo: "", channels: new Set(), districts: new Set(), couriers: new Set(), suggested: new Set() };
}

export function rowFiltersActive(f: LimaRowFilters): number {
  return Number(Boolean(f.createdFrom || f.createdTo)) + Number(f.channels.size > 0) + Number(f.districts.size > 0) + Number(f.couriers.size > 0) + Number(f.suggested.size > 0);
}

/** El mismo distrito escrito con o sin tilde o con otras mayúsculas es uno. */
export function districtKey(district: string | null | undefined): string {
  const key = (district ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  return key || NO_DISTRICT;
}

export function courierKey(courier: string | null | undefined): string {
  return (courier ?? "").trim().toLowerCase() || NO_COURIER;
}

/**
 * La clave del detalle dentro de su courier: «propio:alexis»,
 * «aliclik:autoecom». El mismo motorizado escrito con o sin tilde es uno.
 */
export function courierDetailKey(courier: string | null | undefined, detail: string | null | undefined): string | null {
  const d = (detail ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  return d ? `${courierKey(courier)}:${d}` : null;
}

/** «Grupo GF · Alexis», «Aliclik · AUTOECOM» o solo el courier. */
export function courierLabel(courier: string | null | undefined, detail?: string | null): string {
  const name = courierKey(courier) === NO_COURIER ? "Sin courier" : courierDisplayName(courier);
  return detail?.trim() ? `${name} · ${detail.trim()}` : name;
}

/** Sin canal calculado cuenta como «Sin marca», como en el Master. */
export function channelKey(channel: string | null | undefined): string {
  return channel || "otro";
}

export function rowFiltersMatch(row: LimaPendingOrder, f: LimaRowFilters): boolean {
  if (f.createdFrom || f.createdTo) {
    const day = limaDay(row.createdAt);
    if (!day || (f.createdFrom && day < f.createdFrom) || (f.createdTo && day > f.createdTo)) return false;
  }
  if (f.channels.size && !f.channels.has(channelKey(row.salesChannel))) return false;
  // «Yordani o Alexis» entra con cualquiera de los dos.
  if (f.suggested.size && !suggestedKeys(row).some((k) => f.suggested.has(k))) return false;
  if (f.districts.size && !f.districts.has(districtKey(row.district))) return false;
  if (f.couriers.size) {
    // El courier entero («Grupo GF») o su detalle («Grupo GF · Alexis»).
    const detail = courierDetailKey(row.courier, row.courierDetail);
    if (!f.couriers.has(courierKey(row.courier)) && !(detail && f.couriers.has(detail))) return false;
  }
  return true;
}

function titleCase(value: string): string {
  return value.toLocaleLowerCase("es").replace(/(^|[\s(/-])(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toLocaleUpperCase("es"));
}

/** Las opciones de cada píldora con su cantidad, sobre las filas que se le pasan. */
export function rowFilterOptions(rows: readonly LimaPendingOrder[]): { channels: LimaFilterOption[]; districts: LimaFilterOption[]; couriers: LimaFilterOption[]; suggested: LimaFilterOption[] } {
  const suggestedCount = new Map<string, number>();
  for (const row of rows) for (const k of suggestedKeys(row)) suggestedCount.set(k, (suggestedCount.get(k) ?? 0) + 1);
  // «Motorizado»: cada uno (el de más pedidos primero) y, al final, «Sin motorizado».
  const suggested = [...suggestedCount.entries()]
    .map(([value, count]) => ({ value, label: value === NO_SUGGESTED ? "Sin motorizado" : value, count }))
    .sort((a, b) => Number(a.value === NO_SUGGESTED) - Number(b.value === NO_SUGGESTED) || b.count - a.count || a.label.localeCompare(b.label, "es"));
  const channelCount = new Map<string, number>();
  const courierCount = new Map<string, number>();
  const detailCount = new Map<string, { parent: string; label: string; count: number }>();
  const district = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const row of rows) {
    const channel = channelKey(row.salesChannel);
    channelCount.set(channel, (channelCount.get(channel) ?? 0) + 1);
    const courier = courierKey(row.courier);
    courierCount.set(courier, (courierCount.get(courier) ?? 0) + 1);
    const detail = courierDetailKey(row.courier, row.courierDetail);
    if (detail) {
      const entry = detailCount.get(detail) ?? { parent: courier, label: courierLabel(row.courier, row.courierDetail), count: 0 };
      entry.count += 1;
      detailCount.set(detail, entry);
    }
    const key = districtKey(row.district);
    const entry = district.get(key) ?? { count: 0, spellings: new Map<string, number>() };
    entry.count += 1;
    const spelled = titleCase((row.district ?? "").replace(/\s+/g, " ").trim());
    if (spelled) entry.spellings.set(spelled, (entry.spellings.get(spelled) ?? 0) + 1);
    district.set(key, entry);
  }
  // Las opciones fijas del Master, en su orden; un canal desconocido va al final.
  const known = new Set<string>(SALES_CHANNEL_OPTIONS.map((o) => o.value));
  const channels = [
    ...SALES_CHANNEL_OPTIONS.map((o) => ({ value: o.value as string, label: o.label, count: channelCount.get(o.value) ?? 0 })),
    ...[...channelCount.keys()].filter((v) => !known.has(v)).map((v) => ({ value: v, label: v, count: channelCount.get(v)! })),
  ];
  const districts = [...district.entries()].map(([value, { count, spellings }]) => ({
    value,
    // El nombre: la forma más escrita (con tilde si empata).
    label: value === NO_DISTRICT ? "Sin distrito" : [...spellings.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0], "es"))[0]?.[0] ?? value,
    count,
  })).sort((a, b) => Number(a.value === NO_DISTRICT) - Number(b.value === NO_DISTRICT) || a.label.localeCompare(b.label, "es"));
  // Cada courier y, debajo, sus detalles: «Grupo GF», «Grupo GF · Alexis»…
  const parents = [...courierCount.entries()].map(([value, count]) => ({ value, label: value === NO_COURIER ? "Sin courier" : courierDisplayName(value), count }))
    .sort((a, b) => Number(a.value === NO_COURIER) - Number(b.value === NO_COURIER) || b.count - a.count || a.label.localeCompare(b.label, "es"));
  const couriers = parents.flatMap((parent) => [
    parent,
    ...[...detailCount.entries()].filter(([, d]) => d.parent === parent.value)
      .map(([value, d]) => ({ value, label: d.label, count: d.count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "es")),
  ]);
  return { channels, districts, couriers, suggested };
}

/** De la URL: `canal`, `distrito` y `courier` se repiten; las fechas, una vez. */
export function readRowFilters(params: Pick<URLSearchParams, "get" | "getAll">): LimaRowFilters {
  const day = (value: string | null) => (value && ISO_DAY.test(value) ? value : "");
  const set = (name: string) => new Set(params.getAll(name).filter(Boolean));
  return {
    createdFrom: day(params.get(ROW_FILTER_PARAMS.createdFrom)),
    createdTo: day(params.get(ROW_FILTER_PARAMS.createdTo)),
    channels: set(ROW_FILTER_PARAMS.channels),
    districts: set(ROW_FILTER_PARAMS.districts),
    couriers: set(ROW_FILTER_PARAMS.couriers),
    suggested: set(ROW_FILTER_PARAMS.suggested),
  };
}

export function writeRowFilters(params: URLSearchParams, f: LimaRowFilters): void {
  for (const name of Object.values(ROW_FILTER_PARAMS)) params.delete(name);
  if (f.createdFrom) params.set(ROW_FILTER_PARAMS.createdFrom, f.createdFrom);
  if (f.createdTo) params.set(ROW_FILTER_PARAMS.createdTo, f.createdTo);
  for (const [field, name] of [["channels", ROW_FILTER_PARAMS.channels], ["districts", ROW_FILTER_PARAMS.districts], ["couriers", ROW_FILTER_PARAMS.couriers], ["suggested", ROW_FILTER_PARAMS.suggested]] as const) {
    for (const value of [...f[field]].sort()) params.append(name, value);
  }
}

/** Los parámetros de estos filtros, en orden estable: la clave de la lista. */
export function rowFiltersParam(params: Pick<URLSearchParams, "get" | "getAll">): string {
  const out = new URLSearchParams();
  writeRowFilters(out, readRowFilters(params));
  return out.toString();
}

function shiftIsoDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + delta)).toISOString().slice(0, 10);
}

/** Los atajos de «Creación»: lo de hoy, lo de ayer, la semana y lo que lleva días esperando. */
export function createdPresets(today: string): { label: string; from: string; to: string }[] {
  return [
    { label: "Hoy", from: today, to: today },
    { label: "Ayer", from: shiftIsoDay(today, -1), to: shiftIsoDay(today, -1) },
    { label: "Últimos 7 días", from: shiftIsoDay(today, -6), to: today },
    { label: "Antes de ayer o más", from: "", to: shiftIsoDay(today, -2) },
  ];
}
export interface LimaPendingFilter {
  stage: LimaPendingStage;
  label: string;
  count: number;
  children: { key: string; label: string; count: number }[];
}

export function pendingKey(row: Pick<LimaPendingOrder, "stage" | "substage">): string {
  return `${row.stage}:${row.substage ?? ""}`;
}

export function isLimaPendingStage(stage: unknown): stage is LimaPendingStage {
  return LIMA_PENDING_STAGES.includes(stage as LimaPendingStage);
}

/**
 * ¿Puede estar en Repro Lima? Cobertura Lima y todavía por entregar: el mismo
 * filtro con el que `loadReproLima` (con `attention`) lee la etapa. La ficha lo
 * usa para no preguntar por pedidos que no pueden estar; quien decide si el
 * pedido está —y si sale la pestaña «Repro Lima»— es `loadReproRow`, que
 * además mira la tienda, el permiso y que no esté anulado (MOM §9.5).
 */
export function isReproLimaCandidate(row: { coverage?: string | null; macro_stage?: string | null }): boolean {
  return row.coverage === "lima" && isLimaPendingStage(row.macro_stage);
}

/**
 * Con qué modo abre «Atender»: «Cerrados» y un acuerdo programado se leen sin
 * tomar el caso (E29); lo demás se atiende y toma el candado.
 */
export function reproAttendMode(row: { list: ReproList; agreement?: unknown }): "edit" | "read" {
  return row.list === "cerrados" || row.list === "programados" && Boolean(row.agreement) ? "read" : "edit";
}

export function pendingFilters(rows: readonly LimaPendingOrder[]): LimaPendingFilter[] {
  return LIMA_PENDING_STAGES.flatMap((stage) => {
    const matching = rows.filter((r) => r.stage === stage);
    if (!matching.length) return [];
    const counts = new Map<string | null, number>();
    for (const row of matching) counts.set(row.substage, (counts.get(row.substage) ?? 0) + 1);
    const canon: readonly string[] = MACRO_SUBSTAGES_BY_STAGE[stage as OrderMacroStage];
    const subs = [...counts.keys()].sort((a, b) => {
      const ai = a == null ? Infinity : canon.indexOf(a);
      const bi = b == null ? Infinity : canon.indexOf(b);
      return (ai < 0 ? canon.length : ai) - (bi < 0 ? canon.length : bi) || (a ?? "").localeCompare(b ?? "", "es");
    });
    return [{ stage, label: macroStageLabel(stage), count: matching.length, children: subs.map((substage) => ({
      key: pendingKey({ stage, substage }), label: substage ? macroSubstageLabel(substage) : "Sin subetapa", count: counts.get(substage)!,
    })) }];
  });
}

// Exclusiones, no selecciones: todo se muestra al entrar, incluso una subetapa
// nueva. Desmarcar todas es válido y no debe restablecer la lista por sorpresa.
export function togglePendingKeys(hidden: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const next = new Set(hidden);
  const show = keys.some((key) => hidden.has(key));
  for (const key of keys) { if (show) next.delete(key); else next.add(key); }
  return next;
}

export function pendingMatches(row: LimaPendingOrder, query: string): boolean {
  const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f#]/g, "").toLowerCase().trim();
  const q = norm(query);
  if (!q || norm(row.orderName).includes(q) || norm(row.customerName).includes(q)) return true;
  const digits = query.replace(/\D/g, "");
  return digits.length >= 3 && (row.customerPhone ?? "").replace(/\D/g, "").includes(digits);
}

export function pendingGroup(row: LimaPendingOrder, today: string): { label: string; detail: string } {
  if (row.stage === "en_curso" && row.substage === "por_reprogramar_lima") {
    return { label: "Entrega fallida", detail: "Confirma con el cliente una nueva fecha y courier." };
  }
  const old = row.createdAt && Number.isFinite(Date.parse(row.createdAt)) &&
    Date.parse(`${today}T00:00:00-05:00`) - Date.parse(row.createdAt) > 30 * 86_400_000;
  // Agendado con Aliclik: no falta confirmar ni programar, falta que lo recojan.
  // Si el día pasó y sigue sin recojo, eso sí es trabajo: preguntarle a Aliclik.
  if (row.courierPickup && row.stage !== "en_curso") {
    const day = programDayLabel(row.courierPickup.date);
    return row.courierPickup.date >= today
      ? { label: "Agendado con Aliclik", detail: `Aliclik lo recoge el ${day}. No hace falta gestión salvo que el cliente cambie algo.` }
      : { label: "Aliclik no lo recogió", detail: `Estaba para el ${day} y sigue sin recojo: revisa la guía con Aliclik.` };
  }
  if (old) return { label: "Antiguo por revisar", detail: "Más de 30 días: confirma si la venta sigue vigente y ubica el paquete." };
  const tandersDue = row.courier === "tanders" && row.stage === "en_curso" && row.substage === "en_transito" &&
    row.dispatchedAt && Number.isFinite(Date.parse(row.dispatchedAt)) &&
    Date.parse(row.dispatchedAt) < Date.parse(`${tandersReleaseCutoff(today)}T00:00:00-05:00`);
  if (tandersDue) return { label: "Antiguo por revisar", detail: "Tanders: despacho anterior sin cierre. Confirma su reporte y dónde está el paquete." };
  if (!row.hasPriorDispatch && row.stage !== "en_curso") {
    return { label: "Pendiente de primer despacho", detail: "Confirma los datos y la fecha antes de despachar." };
  }
  return { label: "Seguimiento de entrega", detail: "Revisa el estado del courier y la ubicación del paquete antes de otra salida." };
}
