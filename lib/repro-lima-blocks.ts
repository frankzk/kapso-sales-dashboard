// «Repro Lima» ordenado por las tareas del equipo (owner, 15-11-2026; MOM §9.5).
//
// «Busco que Repro Lima sea el panel de gestión del equipo de Lima para que
// puedan sacar adelante toda la gestión de los pedidos de Lima y puedan tener
// siempre la información a la mano de lo que pasa con cada pedido y puedan
// reprogramar y agendar los pedidos a su gusto.» Con GF Courier por API
// (§29.17) el courier prepara, asigna y reparte; el equipo confirma, reprograma,
// agenda, sigue y cierra. Tres bloques sobre UNA lista:
//
//  - «Por gestionar hoy»: lo que pide al equipo. Cada pedido tiene a lo sumo
//    una tarea: la primera que aplica (`limaTaskOf`).
//  - «Agenda»: el día en que sale —el acuerdo vigente con la clienta, el
//    programa de Grupo GF, el recojo del courier o «Programar envío» (§6.2)—,
//    por día; «Sin fecha», lo que todavía no lo tiene.
//  - «En manos del courier»: con la guía viva de un courier, por su estado.
//    Solo seguimiento: aquí no se opera al courier.
//
// Todo pedido está en la Agenda o en manos del courier (ninguno se pierde); la
// tarea es una capa encima. Son etiquetas de pantalla, no estados: no cambian
// la macroetapa ni `MOM_RESOLUTION_VERSION`, y no escriben nada. Pura.
import { courierLabel, limaQueueSegment, limaScheduledFor, type LimaPendingOrder, type PendingCase } from "@/lib/repro-lima-pending";
import { isDeliveryDay } from "@/lib/dispatch-plan";
import { programDayLabel } from "@/lib/dispatch-day";
import { courierDisplayName } from "@/lib/dispatched-with";
import { DISPATCH_DATE_MAX_DAYS } from "@/lib/dispatch-date";
import { RESCHEDULE_MAX_DAYS } from "@/lib/gf-dispatch-program";
import { isCustomerNovelty } from "@/lib/lima-stuck";
import { reproCallTimeLabel } from "@/lib/repro-lima";

/** El caso de la fila, con lo que el tablero mira además (`ReproRow`). */
export type BoardCase = PendingCase & {
  /** Quién tiene el caso: con otra persona, «Agendar» no lo toma. */
  claim?: { view: string; byName?: string | null } | null;
};

// ---------------------------------------------------------------------------
// Vocabulario de los tres bloques
// ---------------------------------------------------------------------------

export type LimaTask = "primer_despacho" | "no_entregados" | "novedad" | "llamar_despues" | "por_cerrar";
/** En el orden de las tarjetas, que es el de la lista. */
export const LIMA_TASKS: readonly LimaTask[] = ["primer_despacho", "no_entregados", "novedad", "llamar_despues", "por_cerrar"];

/** Filtros dentro de una tarjeta: no suman aparte. */
export type LimaSubFilter = "mas_de_30" | "reintentos_aliclik" | "esperan_anulacion" | "reprogramados";

export type LimaCourierState = "guia_creada" | "en_ruta" | "retornando";
export const LIMA_COURIER_STATES: readonly LimaCourierState[] = ["guia_creada", "en_ruta", "retornando"];

/** «hoy» (con lo vencido), un día `YYYY-MM-DD` de los nombrados, «despues» o «sin_fecha». */
export type LimaAgendaKey = string;

/** Lo que viaja por `atencion` en la URL. */
export type LimaBoardKey = "todos" | LimaTask | LimaSubFilter | LimaCourierState | LimaAgendaKey;

export interface LimaCard<K extends string = string> {
  key: K;
  label: string;
  hint: string;
  empty: string;
}

export const LIMA_TASK_CARDS: readonly LimaCard<LimaTask>[] = [
  {
    key: "primer_despacho",
    label: "Confirmar primer despacho",
    hint: "Nunca salieron y no tienen día: confirma con la clienta y agenda la salida. Del más antiguo al más reciente; dentro, los de más de 30 días.",
    empty: "No hay pedidos sin primer despacho por confirmar con estos filtros.",
  },
  {
    key: "no_entregados",
    label: "No entregados",
    hint: "«Por reprogramar Lima» sin una fecha acordada: llama a la clienta y acuerda el día y el courier con «Atender». Dentro, los reintentos por Aliclik, que salen sin llamar.",
    empty: "No hay no entregados por gestionar con estos filtros.",
  },
  {
    key: "novedad",
    label: "Novedad del courier",
    hint: "El courier todavía tiene el paquete y reporta un problema con la clienta (no contesta, no estaba, rechazo o dirección): llámala y acuerda la entrega o la devolución.",
    empty: "Ningún courier reporta una novedad con la clienta con estos filtros.",
  },
  {
    key: "llamar_despues",
    label: "Llamar después",
    hint: "El cliente pidió que lo llamen a otra hora. Por la hora de la llamada.",
    empty: "Nadie pidió que lo llamen después.",
  },
  {
    key: "por_cerrar",
    label: "Por cerrar",
    hint: "El courier dice que lo entregó y Kapta todavía no lo cierra (falta validar el cobro), o el caso se cerró con «Desarmar y cerrar» y espera que la tienda anule la venta.",
    empty: "No hay pedidos por cerrar con estos filtros.",
  },
];

export const LIMA_SUB_FILTERS: Record<LimaSubFilter, LimaCard<LimaSubFilter> & { parent: LimaTask | "agenda" }> = {
  mas_de_30: {
    key: "mas_de_30",
    parent: "primer_despacho",
    label: "Más de 30 días",
    hint: "Nunca salieron y se crearon hace más de 30 días: confirma si la venta sigue; si no, anúlala en la tienda.",
    empty: "No hay pedidos de más de 30 días sin salida registrada con estos filtros.",
  },
  reintentos_aliclik: {
    key: "reintentos_aliclik",
    parent: "no_entregados",
    label: "Reintentos Aliclik",
    hint: "No entregados de Alexis, Urpi o AUTOECOM por «no contesta», «no estaba» u «otro»: vuelven a salir por Aliclik (AUTOECOM, luego ALIDRIVER), sin llamar. Apruébalos aquí o crea la guía desde la ficha con el transporte indicado.",
    empty: "No hay reintentos por Aliclik con estos filtros.",
  },
  esperan_anulacion: {
    key: "esperan_anulacion",
    parent: "por_cerrar",
    label: "Esperan anulación",
    hint: "«Desarmar y cerrar» del intento vigente: el pedido sigue en la etapa hasta que la tienda anule la venta.",
    empty: "Ningún caso cerrado espera la anulación.",
  },
  reprogramados: {
    key: "reprogramados",
    parent: "agenda",
    label: "Reprogramados",
    hint: "Con una nueva fecha acordada y vigente con la clienta. Están en la Agenda, en el día acordado.",
    empty: "No hay pedidos con una nueva fecha acordada con estos filtros.",
  },
};

export const LIMA_COURIER_CARDS: readonly LimaCard<LimaCourierState>[] = [
  {
    key: "guia_creada",
    label: "Guía creada",
    hint: "Con la guía de un courier (GF Courier, Aliclik, Swayp…) que todavía no lo recoge.",
    empty: "No hay guías creadas sin recoger con estos filtros.",
  },
  {
    key: "en_ruta",
    label: "En ruta",
    hint: "El courier ya lo tiene: recibido, en tránsito, en reparto o con una novedad que todavía no lo devuelve.",
    empty: "Ningún courier lleva pedidos con estos filtros.",
  },
  {
    key: "retornando",
    label: "Retornando",
    hint: "El courier lo está devolviendo al almacén.",
    empty: "Ningún courier está devolviendo pedidos con estos filtros.",
  },
];

// ---------------------------------------------------------------------------
// La Agenda: hoy, los próximos días por su nombre, después y sin fecha
// ---------------------------------------------------------------------------

/** Cuántos días de reparto se nombran después de hoy («Lun 16», «Mar 17»…). */
export const AGENDA_NAMED_DAYS = 5;

function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Los días que la Agenda nombra: desde mañana, hasta juntar `count` días de
 * reparto (lunes a sábado, §29.16). El domingo que cae en medio queda dentro:
 * un acuerdo para ese día tiene su tarjeta (sin pedidos no se dibuja).
 */
export function agendaWindow(today: string, count = AGENDA_NAMED_DAYS): string[] {
  const out: string[] = [];
  let delivery = 0;
  for (let day = shiftDay(today, 1); delivery < count; day = shiftDay(day, 1)) {
    out.push(day);
    if (isDeliveryDay(day)) delivery += 1;
  }
  return out;
}

/** El cajón de la Agenda de un día: lo vencido sigue en Hoy. */
export function agendaKeyOf(day: string | null, today: string, window: readonly string[]): LimaAgendaKey {
  if (!day) return "sin_fecha";
  if (day <= today) return "hoy";
  return window.length && day <= window[window.length - 1]! ? day : "despues";
}

const WEEKDAY = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const WEEKDAY_LONG = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** `2026-11-16` → «Lun 16». */
export function agendaDayLabel(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  return `${WEEKDAY[d.getUTCDay()]} ${day.slice(8, 10)}`;
}

/** `2026-11-16` → «lunes 16/11». */
function agendaDayLong(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  return `${WEEKDAY_LONG[d.getUTCDay()]} ${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

/**
 * Las tarjetas de la Agenda: Hoy, cada día nombrado (un domingo solo si tiene
 * pedidos), Después y Sin fecha.
 */
export function agendaCards(today: string, counts: Readonly<Record<string, number>>, window = agendaWindow(today)): LimaCard<LimaAgendaKey>[] {
  const last = window[window.length - 1];
  return [
    {
      key: "hoy",
      label: "Hoy",
      hint: "Agendados para hoy, y los de un día que ya pasó sin que salieran (van primero).",
      empty: "No hay pedidos agendados para hoy con estos filtros.",
    },
    ...window.filter((day) => isDeliveryDay(day) || (counts[day] ?? 0) > 0).map((day) => ({
      key: day,
      label: agendaDayLabel(day),
      hint: `Agendados para el ${agendaDayLong(day)}.`,
      empty: `No hay pedidos agendados para el ${programDayLabel(day)} con estos filtros.`,
    })),
    {
      key: "despues",
      label: "Después",
      hint: last ? `Agendados después del ${agendaDayLong(last)}.` : "Agendados más adelante.",
      empty: "No hay pedidos agendados más adelante con estos filtros.",
    },
    {
      key: "sin_fecha",
      label: "Sin fecha",
      hint: "Todavía sin día: ni acuerdo con la clienta, ni programa de Grupo GF, ni recojo del courier, ni «Programar envío». Elige varios y «Mover a…» un día.",
      empty: "Todos los pedidos tienen día con estos filtros.",
    },
  ];
}

// ---------------------------------------------------------------------------
// Qué es cada pedido
// ---------------------------------------------------------------------------

/** Las salidas que son de Grupo GF: la «por definir» que rellena y la propia. No son una guía de courier. */
const GF_INTERNAL = new Set(["propio", "por_definir"]);
const RETURNING_SUBSTAGES = new Set(["en_retorno", "retorno_solicitado"]);
const PRE_DISPATCH = new Set(["por_confirmar", "preparacion", "por_despachar"]);

export function isPorReprogramarLima(row: Pick<LimaPendingOrder, "stage" | "substage">): boolean {
  return row.stage === "en_curso" && row.substage === "por_reprogramar_lima";
}

/**
 * El courier de la guía viva (GF Courier, Aliclik, Swayp…), o el de la guía
 * Aliclik que espera su recojo; null si no hay. La salida propia de Grupo GF y
 * la «por definir» no cuentan: son del reparto propio.
 */
export function liveGuideCourier(row: Pick<LimaPendingOrder, "ops" | "courierPickup">): string | null {
  return row.ops?.liveCouriers.find((c) => !GF_INTERNAL.has(c)) ?? row.courierPickup?.courier ?? null;
}

/**
 * Su estado en manos del courier, o null si no lo tiene un courier:
 * - **Guía creada**: antes de salir, con la guía viva de un courier.
 * - **En ruta**: En curso (también con Grupo GF). Un «Por reprogramar Lima»
 *   solo si la guía sigue viva con su courier (GF deja la incidencia viva,
 *   §29.17): si no, el paquete ya no está en la calle.
 * - **Retornando**: en retorno, retorno solicitado o `RETURNING` del courier.
 */
export function limaCourierState(row: LimaPendingOrder): LimaCourierState | null {
  const guide = liveGuideCourier(row);
  if (row.stage === "en_curso") {
    if (isPorReprogramarLima(row) && !guide) return null;
    const returning = RETURNING_SUBSTAGES.has(row.substage ?? "") || /^RETURNING\b/i.test(row.ops?.reportedStatus?.trim() ?? "");
    return returning ? "retornando" : "en_ruta";
  }
  return guide ? "guia_creada" : null;
}

/**
 * «Novedad del courier»: En curso, con la guía viva de un courier que reporta
 * un problema con la clienta (`isCustomerNovelty`, la regla de «Lima
 * trabados»), sin que el paquete esté volviendo. Al momento: es una llamada,
 * no un trabado (el trabado espera un día de reparto entero).
 */
export function courierNovelty(row: LimaPendingOrder): boolean {
  if (row.stage !== "en_curso" || RETURNING_SUBSTAGES.has(row.substage ?? "")) return false;
  if (!row.ops?.liveCouriers.some((c) => !GF_INTERNAL.has(c))) return false;
  return isCustomerNovelty(row.ops.reportedStatus);
}

/**
 * El día de la Agenda: el de `limaScheduledFor` (acuerdo vigente, programa de
 * Grupo GF o recojo de Aliclik) y, sin él, «Programar envío»
 * (`dispatch_scheduled_on`, §6.2).
 */
export function limaAgendaDay(row: LimaPendingOrder, c?: PendingCase): string | null {
  return (limaScheduledFor(row, c) ?? row.scheduledOn ?? null)?.slice(0, 10) ?? null;
}

export type LimaAgendaOrigin = "acuerdo" | "programa" | "recojo" | "envio";

export const AGENDA_ORIGIN_LABEL: Record<LimaAgendaOrigin, string> = {
  acuerdo: "Acordado con la clienta",
  programa: "Programa de Grupo GF",
  recojo: "Recojo del courier",
  envio: "Programar envío",
};

/** De dónde sale el día de la Agenda, en el mismo orden que `limaAgendaDay`. */
export function limaAgendaOrigin(row: LimaPendingOrder, c?: PendingCase): LimaAgendaOrigin | null {
  if (c?.list === "programados" && c.agreement?.agreedOn) return "acuerdo";
  if (row.programmedFor ?? c?.program?.scheduledFor) return "programa";
  if (row.courierPickup?.date) return "recojo";
  if (row.scheduledOn) return "envio";
  return null;
}

/**
 * La tarea del equipo, la primera que aplica:
 * 1. **Por cerrar**: el courier lo da por entregado y el pedido sigue abierto
 *    (`ops.courierDelivered`), o el caso se cerró con «Desarmar y cerrar» y
 *    espera la anulación de la tienda.
 * 2. **No entregados**, si tiene un reintento por Aliclik que toca (sale sin
 *    llamar; se aprueba en su filtro).
 * 3. Con un acuerdo o programa vigente (lista «Programados»): ninguna, ya tiene
 *    su día en la Agenda.
 * 4. **Llamar después**.
 * 5. **Novedad del courier** (`courierNovelty`).
 * 6. **No entregados**: lo demás de «Por reprogramar Lima».
 * 7. **Confirmar primer despacho**: antes de salir, nunca salió, sin día y sin
 *    guía de courier (los «Nunca salieron» y «Más de 30 días» de antes).
 */
export function limaTaskOf(row: LimaPendingOrder, c?: PendingCase): LimaTask | null {
  if (row.ops?.courierDelivered) return "por_cerrar";
  if (c?.list === "cerrados") return "por_cerrar";
  if (isPorReprogramarLima(row) && c?.retryChain) return "no_entregados";
  if (c?.list === "programados") return null;
  if (c?.list === "llamar_despues") return "llamar_despues";
  if (courierNovelty(row)) return "novedad";
  if (isPorReprogramarLima(row)) return "no_entregados";
  if (PRE_DISPATCH.has(row.stage) && !row.hasPriorDispatch && !limaAgendaDay(row, c) && !liveGuideCourier(row)) return "primer_despacho";
  return null;
}

export interface LimaRowClass {
  task: LimaTask | null;
  /** Nunca salió y se creó hace más de 30 días (dentro de «Confirmar primer despacho»). */
  stale: boolean;
  /** Tiene un reintento por Aliclik que toca. */
  retry: boolean;
  /** Cerrado con «Desarmar y cerrar»: espera la anulación. */
  awaitingCancel: boolean;
  /** Con una fecha acordada vigente con la clienta. */
  agreed: boolean;
  /** Su cajón de la Agenda, o null si lo tiene un courier y no tiene día por delante. */
  agenda: LimaAgendaKey | null;
  agendaDay: string | null;
  agendaOrigin: LimaAgendaOrigin | null;
  courier: LimaCourierState | null;
}

/**
 * Los tres bloques de un pedido. Con un courier, entra a la Agenda solo si
 * tiene un día de hoy en adelante (el recojo de Aliclik, un acuerdo): un día
 * que pasó ya no es una fecha por cumplir, el courier lo tiene. Sin courier,
 * siempre: con su día (lo vencido en Hoy) o en «Sin fecha».
 */
export function classifyLimaRow(row: LimaPendingOrder, c: PendingCase | undefined, today: string, window: readonly string[]): LimaRowClass {
  const task = limaTaskOf(row, c);
  const courier = limaCourierState(row);
  const day = limaAgendaDay(row, c);
  const agenda = courier ? (day && day >= today ? agendaKeyOf(day, today, window) : null) : agendaKeyOf(day, today, window);
  return {
    task,
    stale: task === "primer_despacho" && limaQueueSegment(row, today, c) === "mas_de_30",
    retry: Boolean(c?.retryChain),
    awaitingCancel: c?.list === "cerrados",
    agreed: c?.list === "programados" && Boolean(c.agreement?.agreedOn),
    agenda,
    agendaDay: day,
    agendaOrigin: day ? limaAgendaOrigin(row, c) : null,
    courier,
  };
}

/** Una clasificación por pedido: las cifras y la lista la reusan. */
export function classifyLimaRows(rows: readonly LimaPendingOrder[], cases: readonly PendingCase[], today: string, window = agendaWindow(today)): Map<string, LimaRowClass> {
  const caseById = new Map(cases.map((c) => [c.orderId, c]));
  return new Map(rows.map((row) => [row.orderId, classifyLimaRow(row, caseById.get(row.orderId), today, window)]));
}

// ---------------------------------------------------------------------------
// Cifras, filtro y orden
// ---------------------------------------------------------------------------

export interface LimaBoardCounts {
  todos: number;
  task: Record<LimaTask, number>;
  sub: Record<LimaSubFilter, number>;
  /** Por cajón: «hoy», cada día, «despues» y «sin_fecha». */
  agenda: Record<string, number>;
  courier: Record<LimaCourierState, number>;
}

export function limaBoardCounts(rows: readonly LimaPendingOrder[], classes: ReadonlyMap<string, LimaRowClass>): LimaBoardCounts {
  const counts: LimaBoardCounts = {
    todos: rows.length,
    task: { primer_despacho: 0, no_entregados: 0, novedad: 0, llamar_despues: 0, por_cerrar: 0 },
    sub: { mas_de_30: 0, reintentos_aliclik: 0, esperan_anulacion: 0, reprogramados: 0 },
    agenda: { hoy: 0, despues: 0, sin_fecha: 0 },
    courier: { guia_creada: 0, en_ruta: 0, retornando: 0 },
  };
  for (const row of rows) {
    const cls = classes.get(row.orderId);
    if (!cls) continue;
    if (cls.task) counts.task[cls.task] += 1;
    if (cls.stale) counts.sub.mas_de_30 += 1;
    if (cls.retry) counts.sub.reintentos_aliclik += 1;
    if (cls.awaitingCancel) counts.sub.esperan_anulacion += 1;
    if (cls.agreed) counts.sub.reprogramados += 1;
    if (cls.agenda) counts.agenda[cls.agenda] = (counts.agenda[cls.agenda] ?? 0) + 1;
    if (cls.courier) counts.courier[cls.courier] += 1;
  }
  return counts;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const TASK_SET = new Set<string>(LIMA_TASKS);
const COURIER_SET = new Set<string>(LIMA_COURIER_STATES);

/** ¿La fila entra en el filtro `key`? */
export function boardMatches(cls: LimaRowClass, key: LimaBoardKey): boolean {
  if (key === "todos") return true;
  if (TASK_SET.has(key)) return cls.task === key;
  if (COURIER_SET.has(key)) return cls.courier === key;
  switch (key) {
    case "mas_de_30": return cls.stale;
    case "reintentos_aliclik": return cls.retry;
    case "esperan_anulacion": return cls.awaitingCancel;
    case "reprogramados": return cls.agreed;
    default: return cls.agenda === key;
  }
}

/**
 * Lo que dice `atencion` en la URL. Los enlaces de la pantalla anterior
 * siguen abriendo lo más cercano: «Programados para hoy» es Hoy, «para
 * mañana» el día de mañana, «para después» Después, «Nunca salieron»
 * Confirmar primer despacho, «Por decidir» No entregados, «Cerrados» Esperan
 * anulación y `programados` Reprogramados. «Ya salieron» no tiene par: abre
 * Todos, igual que un valor desconocido. Un día que ya pasó abre Hoy.
 */
export function boardFilter(value: string | null, today: string): LimaBoardKey {
  switch (value) {
    case null:
    case "":
    case "todos":
      return "todos";
    case "programados_hoy": return "hoy";
    case "programados_manana": return shiftDay(today, 1);
    case "programados_despues": return "despues";
    case "nunca_salieron": return "primer_despacho";
    case "por_decidir": return "no_entregados";
    case "cerrados": return "esperan_anulacion";
    case "programados": return "reprogramados";
  }
  if (TASK_SET.has(value) || COURIER_SET.has(value) || value in LIMA_SUB_FILTERS) return value;
  if (value === "hoy" || value === "despues" || value === "sin_fecha") return value;
  if (ISO_DAY.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`))) return value <= today ? "hoy" : value;
  return "todos";
}

/** La tarjeta (o el filtro de adentro) de una clave, para el título de la lista y su vacío. */
export function boardCard(key: LimaBoardKey, today: string): (LimaCard & { block: "gestion" | "agenda" | "courier" }) | null {
  if (key === "todos") return null;
  const task = LIMA_TASK_CARDS.find((c) => c.key === key);
  if (task) return { ...task, block: "gestion" };
  const courier = LIMA_COURIER_CARDS.find((c) => c.key === key);
  if (courier) return { ...courier, block: "courier" };
  if (key in LIMA_SUB_FILTERS) {
    const sub = LIMA_SUB_FILTERS[key as LimaSubFilter];
    return { ...sub, block: sub.parent === "agenda" ? "agenda" : "gestion" };
  }
  if (ISO_DAY.test(key)) {
    return {
      key,
      label: agendaDayLabel(key),
      hint: `Agendados para el ${agendaDayLong(key)}.`,
      empty: `No hay pedidos agendados para el ${programDayLabel(key)} con estos filtros.`,
      block: "agenda",
    };
  }
  const agenda = agendaCards(today, {}).find((c) => c.key === key);
  return agenda ? { ...agenda, block: "agenda" } : null;
}

const TASK_RANK = new Map(LIMA_TASKS.map((task, i) => [task, i]));
const COURIER_RANK = new Map(LIMA_COURIER_STATES.map((state, i) => [state, i]));

function groupRank(cls: LimaRowClass): number {
  if (cls.task) return TASK_RANK.get(cls.task)!;
  if (cls.agenda && cls.agenda !== "sin_fecha") return 10;
  if (cls.agenda === "sin_fecha") return 20;
  return 30 + (cls.courier ? COURIER_RANK.get(cls.courier)! : 0);
}

/**
 * La lista de un filtro, en el orden de las tareas: primero lo que pide al
 * equipo (en el orden de sus tarjetas), después la Agenda por día (lo vencido
 * primero), lo que no tiene fecha y lo que lleva el courier.
 * - No entregados y Llamar después siguen el orden de los casos
 *   (`caseOrder`, el de `sortRepro`: los fallos de ayer, lo vencido, la hora
 *   de la llamada).
 * - Confirmar primer despacho, del más antiguo al más reciente (owner,
 *   06-11-2026: en un pico lo armado hace días se hundía al final); sin fecha
 *   de creación, primero.
 * - Novedad, Por cerrar, Sin fecha y lo del courier: lo que más lleva en su
 *   etapa, primero.
 * - En la Agenda, por día y, en el mismo día, del más reciente al más antiguo.
 */
export function limaBoardRows(
  rows: readonly LimaPendingOrder[],
  classes: ReadonlyMap<string, LimaRowClass>,
  key: LimaBoardKey,
  caseOrder: ReadonlyMap<string, number> = new Map(),
): LimaPendingOrder[] {
  return rows.flatMap((row) => {
    const cls = classes.get(row.orderId);
    return cls && boardMatches(cls, key) ? [{
      row,
      cls,
      group: groupRank(cls),
      caseAt: caseOrder.get(row.orderId) ?? Number.MAX_SAFE_INTEGER,
      created: Date.parse(row.createdAt ?? "") || 0,
      since: Date.parse(row.macroSince ?? row.createdAt ?? "") || 0,
    }] : [];
  }).sort((a, b) => {
    if (a.group !== b.group) return a.group - b.group;
    const task = a.cls.task;
    if (task === "no_entregados" || task === "llamar_despues") return a.caseAt - b.caseAt || a.since - b.since;
    if (task === "primer_despacho") return a.created - b.created;
    if (!task && a.group === 10) return (a.cls.agendaDay ?? "").localeCompare(b.cls.agendaDay ?? "") || b.created - a.created;
    return a.since - b.since;
  }).map((r) => r.row);
}

// ---------------------------------------------------------------------------
// Lo que dice la fila
// ---------------------------------------------------------------------------

/** Los estados de GF Courier (§29.17), dichos con palabras; lo demás va como lo reportó el courier. */
const GF_STATUS_TEXT: Record<string, string> = {
  CREATED: "Guía creada",
  READY_FOR_PICKUP: "Lista para recojo",
  OUT_FOR_DELIVERY: "En reparto",
  INCIDENT: "Incidencia",
  "INCIDENT:NO_ANSWER": "Incidencia: no contesta",
  "INCIDENT:CUSTOMER_ABSENT": "Incidencia: no estaba",
  "INCIDENT:WRONG_ADDRESS": "Incidencia: dirección errada",
  "INCIDENT:RESCHEDULE_REQUESTED": "Pidió otra fecha",
  REFUSED: "Rechazado en la puerta",
  RETURNING: "Retornando",
  RETURNED: "Devuelto al almacén de GF",
  DELIVERED: "Entregado",
  CANCELLED: "Anulada",
};

export function courierStatusText(status: string | null | undefined): string | null {
  const raw = status?.trim();
  if (!raw) return null;
  return GF_STATUS_TEXT[raw.toUpperCase()] ?? raw;
}

/** «GF Courier · Incidencia: no contesta», «Grupo GF · Alexis», o null sin courier. */
export function courierNowText(row: LimaPendingOrder): string | null {
  const guide = liveGuideCourier(row);
  const code = guide ?? row.courier;
  if (!code || code === "por_definir") return null;
  const name = courierLabel(code, code === row.courier ? row.courierDetail : null);
  const status = courierStatusText(row.ops?.reportedStatus);
  return status ? `${name} · ${status}` : name;
}

/** El día de la Agenda dicho en la fila: «Hoy», «lun 16/11» o «Vencido · jue 12/11». */
export function agendaDayText(day: string | null, today: string): string {
  if (!day) return "Sin fecha";
  if (day === today) return "Hoy";
  return day < today ? `Vencido · ${programDayLabel(day)}` : programDayLabel(day);
}

/**
 * El próximo paso de la fila, dicho para quien la atiende: la tarea; sin
 * tarea, lo que dice su día o su courier. Un trabado lo dice con su regla
 * (`limaStuckRule(...).action`), aparte.
 */
export function limaNextStep(row: LimaPendingOrder, c: PendingCase | undefined, cls: LimaRowClass, today: string, now: Date = new Date()): string {
  const courier = liveGuideCourier(row);
  const courierName = courier ? courierDisplayName(courier) : row.courier ? courierDisplayName(row.courier) : "el courier";
  switch (cls.task) {
    case "por_cerrar":
      return cls.awaitingCancel
        ? "Anular la venta en la tienda: el caso se cerró con «Desarmar y cerrar»."
        : `Validar el cobro de ${row.ops?.courierDelivered ? courierDisplayName(row.ops.courierDelivered.courier) : courierName} para cerrarlo (Tanders: su constancia en Validar pagos).`;
    case "no_entregados":
      return cls.retry
        ? "Reintento por Aliclik: apruébalo en «Reintentos Aliclik», sin llamar."
        : "Llamar a la clienta y acordar el día y el courier (Atender).";
    case "novedad":
      return `Llamar a la clienta y acordar con ${courierName} la entrega o la devolución: la guía sigue viva.`;
    case "llamar_despues":
      return c?.nextCallAt ? `Llamar ${reproCallTimeLabel(c.nextCallAt, now)}.` : "Llamar a la clienta otra vez.";
    case "primer_despacho":
      return cls.stale
        ? "Confirmar con la clienta si la venta sigue; si no, anularla en la tienda."
        : "Confirmar los datos con la clienta y agendar la salida.";
    case null:
      break;
  }
  if (cls.courier === "retornando") return "Recibir la devolución en Almacén cuando llegue.";
  if (cls.courier === "en_ruta") return `Solo seguimiento: lo tiene ${courierName}.`;
  if (cls.courier === "guia_creada") {
    return row.courierPickup && row.courierPickup.date >= today
      ? `Lo recoge ${courierDisplayName(row.courierPickup.courier)} el ${programDayLabel(row.courierPickup.date)}.`
      : `Lo prepara y lo recoge ${courierName}.`;
  }
  if (cls.agendaDay && cls.agendaDay < today) return `Debía salir el ${programDayLabel(cls.agendaDay)}: revisa por qué no salió y reagéndalo.`;
  if (cls.agendaDay === today) return "Sale hoy.";
  if (cls.agendaDay) return `Sale el ${programDayLabel(cls.agendaDay)}. Sin gestión salvo que la clienta cambie algo.`;
  return "Agendar la salida.";
}

// ---------------------------------------------------------------------------
// «Agendar» (owner, 15-11-2026): con qué camino se pone el día
// ---------------------------------------------------------------------------

export type AgendarPath =
  /** Un acuerdo con la clienta que ya existe: se cambia su día, con su courier (`moveReproAgreement`). */
  | { kind: "acuerdo"; current: string; courierName: string; maxDays: number }
  /** Sin guía ni acuerdo, en Preparación · Por generar rótulo: «Programar envío» (`scheduleOrderDispatch`, §6.2). */
  | { kind: "envio"; current: string | null; maxDays: number }
  | { kind: null; why: string };

/**
 * Con qué acción existente se agenda el pedido. La misma decisión la vuelve a
 * tomar el servidor (`agendarReproLima`) con los hechos de ese momento.
 * - Con un acuerdo (aunque esté vencido), se cambia el día del acuerdo: el
 *   courier y lo que cambió ya se acordaron con la clienta.
 * - Sin acuerdo y en Por generar rótulo, «Programar envío»: el día en que sale
 *   su primera guía (con GF Courier por API, la guía automática de ese día).
 * - Un no entregado sin acuerdo no tiene courier: se acuerda en «Atender».
 * - Con una guía, el día lo lleva el courier; con rótulo, se acuerda en
 *   «Atender».
 */
export function agendarPath(row: LimaPendingOrder, c: BoardCase | undefined, opts: { canScheduleDispatch: boolean }): AgendarPath {
  if (c?.list === "cerrados") return { kind: null, why: "Se cerró con «Desarmar y cerrar»: espera la anulación." };
  if (c?.claim?.view === "otro") return { kind: null, why: `${c.claim.byName ?? "Otra persona"} lo está atendiendo.` };
  if (c?.agreement?.agreedOn) {
    return { kind: "acuerdo", current: c.agreement.agreedOn, courierName: c.agreement.courierName ?? courierDisplayName(c.agreement.courier ?? null), maxDays: RESCHEDULE_MAX_DAYS };
  }
  if (row.stage === "preparacion" && row.substage === "por_generar_rotulo" && !liveGuideCourier(row)) {
    return opts.canScheduleDispatch
      ? { kind: "envio", current: row.scheduledOn ?? null, maxDays: DISPATCH_DATE_MAX_DAYS }
      : { kind: null, why: "Tu rol no permite programar envíos." };
  }
  if (isPorReprogramarLima(row)) return { kind: null, why: "Primero acuerda el día y el courier con la clienta en «Atender»." };
  if (liveGuideCourier(row) || row.stage === "en_curso") return { kind: null, why: "Ya tiene guía: el día lo lleva el courier." };
  return { kind: null, why: "Ya tiene rótulo: acuerda el día con la clienta en «Atender»." };
}

/** Los días que ofrece «Agendar»: hoy y los próximos días de reparto, hasta `count`. */
export function agendarQuickDays(today: string, count = AGENDA_NAMED_DAYS): string[] {
  return [today, ...agendaWindow(today, count).filter(isDeliveryDay)];
}

/** El último día que admite el camino (`maxDays` desde hoy). */
export function agendarMaxDay(today: string, maxDays: number): string {
  return shiftDay(today, maxDays);
}
