// Repro Lima: la cola de trabajo amplia. Son filtros de lectura del Master;
// ver un pendiente no crea un caso de entrega fallida ni autoriza otra salida.
import { MACRO_SUBSTAGES_BY_STAGE, macroStageLabel, macroSubstageLabel, type OrderMacroStage } from "@/lib/order-macro-stage";
import { tandersReleaseCutoff } from "@/lib/gf-tanders-review";
import type { ReproList } from "@/lib/repro-lima";
import { QUEUE_SEGMENTS, QUEUE_SEGMENT_LABEL, limaDay, programDayLabel, queueSegment, type QueueSegment } from "@/lib/dispatch-day";
import { SALES_CHANNEL_OPTIONS } from "@/lib/sales-channel";
import type { PlanBox, PlanCandidate } from "@/lib/dispatch-plan";
import { courierDisplayName } from "@/lib/dispatched-with";

export type LimaAttentionFilter = "todos" | "reintentos_aliclik" | "reprogramados" | QueueSegment | "llamar_despues" | "cerrados";
type AttentionCase = {
  orderId: string; list: ReproList;
  /** El reintento por Aliclik que toca (lib/lima-retry-chain.ts), o null. */
  retryChain?: unknown;
  agreement?: { agreedOn: string; courier?: string } | null;
  program?: { scheduledFor: string } | null;
};

export const LIMA_QUEUE_CARDS: readonly { key: Exclude<LimaAttentionFilter, "todos" | "llamar_despues" | "cerrados">; label: string; hint: string; empty: string }[] = [
  { key: "reintentos_aliclik", label: "Reintentos Aliclik", hint: "No entregados de Alexis, Urpi o AUTOECOM por «no contesta», «no estaba» u «otro»: vuelven a salir por Aliclik (AUTOECOM, luego ALIDRIVER), sin llamar. Crea la guía desde la ficha con el transporte indicado.", empty: "No hay reintentos por Aliclik con estos filtros." },
  { key: "reprogramados", label: "Reprogramados", hint: "Con una nueva fecha acordada y vigente en Repro Lima. También aparecen en Hoy, Mañana o Después según esa fecha.", empty: "No hay pedidos con una nueva fecha acordada con estos filtros." },
  { key: "programados_hoy", label: "Programados para hoy", hint: QUEUE_SEGMENT_LABEL.programados_hoy.hint, empty: "No hay pedidos programados para hoy con estos filtros." },
  { key: "programados_manana", label: "Programados para mañana", hint: QUEUE_SEGMENT_LABEL.programados_manana.hint, empty: "No hay pedidos programados para mañana con estos filtros." },
  { key: "nunca_salieron", label: "Nunca salieron", hint: `${QUEUE_SEGMENT_LABEL.nunca_salieron.hint} Del más antiguo al más reciente: arriba lo que lleva más días esperando.`, empty: "No hay pedidos recientes sin salida registrada con estos filtros." },
  { key: "ya_salieron", label: "Ya salieron", hint: "Con al menos una salida a reparto registrada y sin una nueva fecha pendiente. La situación indica si sigue con el courier o ya retornó.", empty: "No hay pedidos con una salida previa y sin nueva fecha con estos filtros." },
  { key: "mas_de_30", label: "Más de 30 días", hint: QUEUE_SEGMENT_LABEL.mas_de_30.hint, empty: "No hay pedidos de más de 30 días sin salida registrada con estos filtros." },
  { key: "programados_despues", label: "Programados para después", hint: QUEUE_SEGMENT_LABEL.programados_despues.hint, empty: "No hay pedidos programados para después de mañana con estos filtros." },
];

export const LIMA_FOLLOWUP_FILTERS = [
  { key: "llamar_despues" as const, label: "Llamar después", hint: "El cliente pidió que lo llamen a otra hora. Por la hora de la llamada.", empty: "Nadie pidió que lo llamen después." },
  { key: "cerrados" as const, label: "Cerrados · esperan anulación", hint: "«Desarmar y cerrar» del intento vigente: el pedido sigue en la etapa hasta que la tienda anule la venta.", empty: "Ningún caso cerrado espera la anulación." },
];

/** Las tarjetas filtran una sola cola. Los pedidos sin caso siguen en Todos;
 * no se les inventa un resultado de llamada ni se cambia su macroestado. */
export function attentionFilter(value: string | null): LimaAttentionFilter {
  if (value === "programados") return "reprogramados";
  return [...LIMA_QUEUE_CARDS, ...LIMA_FOLLOWUP_FILTERS].some((c) => c.key === value) ? value as LimaAttentionFilter : "todos";
}

/** La fecha acordada vigente manda sobre un programa anterior que aún no se
 * actualizó. Sin acuerdo vigente, se usa una programación persistida y, sin
 * ella, el día en que Aliclik recoge la guía que ya tiene (owner, 07-11-2026):
 * un pedido agendado con el courier no «nunca salió» sin gestión. */
export function limaScheduledFor(row: LimaPendingOrder, c?: AttentionCase): string | null {
  return (c?.list === "programados" ? c.agreement?.agreedOn : null) ?? row.programmedFor ?? c?.program?.scheduledFor ??
    row.courierPickup?.date ?? null;
}

export function limaQueueSegment(row: LimaPendingOrder, today: string, c?: AttentionCase): QueueSegment {
  return queueSegment({ programmedFor: limaScheduledFor(row, c), hasPriorDispatch: row.hasPriorDispatch, createdAt: row.createdAt }, today);
}

export function attentionRows(rows: readonly LimaPendingOrder[], cases: readonly AttentionCase[], filter: LimaAttentionFilter, today: string): LimaPendingOrder[] {
  const caseById = new Map(cases.map((c) => [c.orderId, c]));
  if (filter === "todos" || QUEUE_SEGMENTS.includes(filter as QueueSegment)) {
    // Una clasificación por pedido: el comparador no reconstruye fechas de
    // Lima miles de veces cuando la cola amplia tiene más de 2000 filas.
    return rows.map((row) => {
      const c = caseById.get(row.orderId);
      const segment = limaQueueSegment(row, today, c);
      return { row, segment, rank: QUEUE_SEGMENTS.indexOf(segment), day: limaScheduledFor(row, c) ?? "", created: Date.parse(row.createdAt ?? "") || 0 };
    }).filter((r) => filter === "todos" || r.segment === filter)
      // «Nunca salieron», del más antiguo al más reciente (owner, 06-11-2026):
      // en un pico lo armado hace días se hundía al final y nadie lo llamaba.
      // El resto, y Despacho del día (`sortQueue`, §29.13), siguen del más reciente.
      .sort((a, b) => a.rank - b.rank || a.day.localeCompare(b.day) || (a.segment === "nunca_salieron" ? a.created - b.created : b.created - a.created))
      .map((r) => r.row);
  }
  const byId = new Map(rows.map((row) => [row.orderId, row]));
  // La carga de casos ya aplica sortRepro: al filtrar se conservan el orden de
  // llamada y las prioridades de acuerdos, sin reconstruir otra tabla.
  return cases.flatMap((c) => {
    const row = byId.get(c.orderId);
    const matches = filter === "reintentos_aliclik"
      ? Boolean(c.retryChain)
      : filter === "reprogramados" ? c.list === "programados" && Boolean(c.agreement?.agreedOn) : c.list === filter;
    if (!row || !matches) return [];
    byId.delete(c.orderId);
    return [row];
  });
}

export function attentionCounts(rows: readonly LimaPendingOrder[], cases: readonly AttentionCase[], today: string): Record<LimaAttentionFilter, number> {
  const counts: Record<LimaAttentionFilter, number> = { todos: rows.length, reintentos_aliclik: 0, reprogramados: 0, programados_hoy: 0, programados_manana: 0, nunca_salieron: 0, ya_salieron: 0, mas_de_30: 0, programados_despues: 0, llamar_despues: 0, cerrados: 0 };
  const byId = new Map(cases.map((row) => [row.orderId, row]));
  for (const row of rows) {
    const c = byId.get(row.orderId);
    counts[limaQueueSegment(row, today, c)] += 1;
    if (c?.retryChain) counts.reintentos_aliclik += 1;
    if (c?.list === "programados" && c.agreement?.agreedOn) counts.reprogramados += 1;
    if (c?.list === "llamar_despues" || c?.list === "cerrados") counts[c.list] += 1;
  }
  return counts;
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
  hasPriorDispatch: boolean;
  lastDepartureAt: string | null;
  programmedFor: string | null;
  /** Por dónde se generó (`order_master.sales_channel`, 0264); null sin calcular. */
  salesChannel: string | null;
  /** La dirección de entrega y su referencia, tal como están en el Master. */
  address: string | null;
  reference: string | null;
  /**
   * La guía de un courier externo que espera su recojo (§9.5, owner
   * 07-11-2026): hoy, Aliclik con la guía viva, sin salida ni retorno. `date`
   * es el día de recojo: el que reportó Aliclik o, sin reporte, el de su regla
   * de corte. Sin guía esperando, null.
   */
  courierPickup?: { courier: "aliclik"; date: string } | null;
  /**
   * El detalle de su courier vigente (owner, 08-11-2026: «no me das grupo gf
   * alexis o aliclik autoecom»): el motorizado de su última caja de Grupo GF, o
   * el transporte de su guía Aliclik (AUTOECOM, ALIDRIVER). Null si no hay.
   */
  courierDetail?: string | null;
  /** Lo de Grupo GF para «Sale a reparto» (§29.16); null si no sale con Grupo GF. */
  gf?: LimaPendingGf | null;
  /** «Programar envío» (§6.2, `order_master.dispatch_scheduled_on`): solo en Por generar rótulo. */
  scheduledOn?: string | null;
  /** Lo que dicen sus salidas, para «Lima trabados» (§9.6); null en Por confirmar o sin salidas. */
  ops?: LimaPendingOps | null;
}

/**
 * Las salidas del pedido vistas para «Lima trabados» (§9.6), leídas de la
 * misma lectura de `shipments` que «Sale a reparto». Solo hechos: el motivo lo
 * decide `limaStuck` (lib/lima-stuck.ts).
 */
export interface LimaPendingOps {
  /** Los couriers de sus salidas vivas (`pendiente`/`en_ruta`, sin retorno ni devolución), la más nueva primero. */
  liveCouriers: string[];
  /** Lo último que reportó el courier de la salida viva más nueva (`shipments.reported_status`). */
  reportedStatus: string | null;
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

/**
 * El pedido para «Sale a reparto» (§29.16, `lib/dispatch-plan.ts`). Su día:
 * el de la caja; si no, el acuerdo o el programa (`limaScheduledFor`), la
 * solicitud tomada, y, sin nada de eso, el corte (`cutoffDay`, el que da
 * `scheduledDay` ahora). Un reintento (En curso) o lo que sigue en una caja de
 * un día que pasó solo tiene el día del acuerdo o el programa: sin ellos espera
 * a la tienda (§29.13) y no entra, como en Despacho del día. Un acuerdo con
 * otro courier no es de Grupo GF.
 */
export function limaPlanCandidate(row: LimaPendingOrder, c: AttentionCase | undefined, cutoffDay: string): PlanCandidate | null {
  if (!row.gf) return null;
  if (c?.list === "programados" && c.agreement?.courier && c.agreement.courier !== "propio") return null;
  const agreedOrProgrammed = limaScheduledFor(row, c);
  const waitsForStore = row.stage === "en_curso" || Boolean(row.gf.pastBox);
  const day = agreedOrProgrammed ?? (waitsForStore ? null : row.gf.requestDay ?? cutoffDay);
  return { orderId: row.orderId, day: day?.slice(0, 10) ?? null, box: row.gf.box, labeled: row.gf.labeled, armed: row.gf.armed, awaitingOffice: Boolean(row.gf.awaitingOffice) };
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
}
export type LimaFilterOption = { value: string; label: string; count: number };

export const NO_COURIER = "sin_courier";
export const NO_DISTRICT = "sin_distrito";
const ROW_FILTER_PARAMS = { channels: "canal", districts: "distrito", couriers: "courier", createdFrom: "creado_desde", createdTo: "creado_hasta" } as const;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function emptyRowFilters(): LimaRowFilters {
  return { createdFrom: "", createdTo: "", channels: new Set(), districts: new Set(), couriers: new Set() };
}

export function rowFiltersActive(f: LimaRowFilters): number {
  return Number(Boolean(f.createdFrom || f.createdTo)) + Number(f.channels.size > 0) + Number(f.districts.size > 0) + Number(f.couriers.size > 0);
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
export function rowFilterOptions(rows: readonly LimaPendingOrder[]): { channels: LimaFilterOption[]; districts: LimaFilterOption[]; couriers: LimaFilterOption[] } {
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
  return { channels, districts, couriers };
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
  };
}

export function writeRowFilters(params: URLSearchParams, f: LimaRowFilters): void {
  for (const name of Object.values(ROW_FILTER_PARAMS)) params.delete(name);
  if (f.createdFrom) params.set(ROW_FILTER_PARAMS.createdFrom, f.createdFrom);
  if (f.createdTo) params.set(ROW_FILTER_PARAMS.createdTo, f.createdTo);
  for (const [field, name] of [["channels", ROW_FILTER_PARAMS.channels], ["districts", ROW_FILTER_PARAMS.districts], ["couriers", ROW_FILTER_PARAMS.couriers]] as const) {
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
