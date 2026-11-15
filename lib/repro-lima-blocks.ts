// «Repro Lima» ordenado por las tareas del equipo (owner, 15-11-2026; MOM §9.5).
//
// «Busco que Repro Lima sea el panel de gestión del equipo de Lima para que
// puedan sacar adelante toda la gestión de los pedidos de Lima y puedan tener
// siempre la información a la mano de lo que pasa con cada pedido y puedan
// reprogramar y agendar los pedidos a su gusto.» Con GF Courier por API
// (§29.17) el courier prepara, asigna y reparte; el equipo confirma, reprograma,
// agenda, sigue y cierra. Dos bloques sobre UNA lista (tercera vuelta, owner
// 15-11-2026: «estos 5 no suman 1,438»; «en la barra superior las etapas deben
// sumar el total… las que no necesitamos, como Por cerrar, plegadas»):
//
//  - «Flujo del día»: seis pasos que son una PARTICIÓN —cada pedido está en
//    exactamente uno (`limaStepOf`), así que suman el total—: los cuatro del
//    trabajo del equipo (Novedad del courier, Llamar después, No entregados y
//    Sacar a reparto) y, plegados, los dos que solo se miran (Con el courier y
//    Por cerrar). La tarea del equipo (`limaTaskOf`) decide los pasos.
//  - «Agenda»: el día en que sale —el acuerdo vigente con la clienta, el
//    programa de Grupo GF, el recojo del courier o «Programar envío» (§6.2)—
//    en Hoy (con lo vencido), Mañana, Después y Sin fecha. En Hoy y Mañana,
//    cuántos tienen guía o rótulo y cuántos no: los que no, son una alerta.
//
// Son etiquetas de pantalla, no estados: no cambian la macroetapa ni
// `MOM_RESOLUTION_VERSION`, y no escriben nada. Pura.
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
// Vocabulario del flujo y la Agenda
// ---------------------------------------------------------------------------

export type LimaTask = "primer_despacho" | "no_entregados" | "novedad" | "llamar_despues" | "por_cerrar";
/** En el orden de las tarjetas, que es el de la lista. */
export const LIMA_TASKS: readonly LimaTask[] = ["primer_despacho", "no_entregados", "novedad", "llamar_despues", "por_cerrar"];

/** Filtros dentro de una tarjeta: no suman aparte. */
export type LimaSubFilter = "mas_de_30" | "reintentos_aliclik" | "esperan_anulacion" | "reprogramados" | "hoy_sin_guia" | "manana_sin_guia";

/**
 * Los seis pasos del flujo (owner, 15-11-2026, tercera vuelta: «estos 5 no
 * suman 1,438»). Son una PARTICIÓN: cada pedido pendiente está en exactamente
 * un paso, así que suman el total. Los cuatro primeros son el trabajo del
 * equipo; «Con el courier» y «Por cerrar» («no lo necesito como tal») se
 * dibujan plegados (`LIMA_FOLDED_STEPS`), pero cuentan para que la suma cierre.
 */
export type LimaStep = "novedad" | "llamar_despues" | "no_entregados" | "por_sacar" | "con_courier" | "por_cerrar";
export const LIMA_STEPS: readonly LimaStep[] = ["novedad", "llamar_despues", "no_entregados", "por_sacar", "con_courier", "por_cerrar"];
/** Los pasos que el equipo no trabaja: solo se miran, plegados al final del flujo. */
export const LIMA_FOLDED_STEPS: ReadonlySet<LimaStep> = new Set<LimaStep>(["con_courier", "por_cerrar"]);

export type LimaCourierState = "guia_creada" | "en_ruta" | "retornando";
export const LIMA_COURIER_STATES: readonly LimaCourierState[] = ["guia_creada", "en_ruta", "retornando"];

/** «hoy» (con lo vencido), un día `YYYY-MM-DD` de los nombrados, «despues» o «sin_fecha». */
export type LimaAgendaKey = string;

/** Lo que viaja por `atencion` en la URL. */
export type LimaBoardKey = "todos" | LimaStep | LimaTask | LimaSubFilter | LimaCourierState | LimaAgendaKey;

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

/** Las cinco tarjetas del flujo, en su orden de trabajo. */
export const LIMA_STEP_CARDS: readonly LimaCard<LimaStep>[] = [
  {
    key: "novedad",
    label: "Novedad del courier",
    hint: "El courier todavía tiene el paquete y reporta un problema con la clienta (no contesta, no estaba, rechazo o dirección): llámala y acuerda la entrega o la devolución.",
    empty: "Ningún courier reporta una novedad con la clienta con estos filtros.",
  },
  {
    key: "llamar_despues",
    label: "Llamar después",
    hint: "La clienta pidió que la llamen a otra hora. Por la hora de la llamada.",
    empty: "Nadie pidió que lo llamen después.",
  },
  {
    key: "no_entregados",
    label: "No entregados",
    hint: "«Por reprogramar Lima» sin una fecha acordada: llama a la clienta y acuerda el día y el courier con «Atender». Dentro, los reintentos por Aliclik, que salen sin llamar.",
    empty: "No hay no entregados por gestionar con estos filtros.",
  },
  {
    key: "por_sacar",
    label: "Sacar a reparto",
    hint: "Todo lo que todavía no salió: lo agendado que espera su guía o su rótulo, y lo que nunca salió y no tiene día. La meta es que salga todo: agenda lo que no tiene día y genera la guía de lo que sale hoy o mañana.",
    empty: "No queda nada por sacar a reparto con estos filtros.",
  },
  {
    key: "con_courier",
    label: "Con el courier",
    hint: "Con la guía viva de un courier: creada, en ruta o retornando. Solo seguimiento: aquí no se opera al courier.",
    empty: "Ningún courier lleva pedidos con estos filtros.",
  },
  {
    key: "por_cerrar",
    label: "Por cerrar",
    hint: "El courier dice que lo entregó y Kapta todavía no lo cierra (falta validar el cobro), o el caso se cerró con «Desarmar y cerrar» y espera que la tienda anule la venta. No es trabajo del equipo de Lima: se mira.",
    empty: "No hay pedidos por cerrar con estos filtros.",
  },
];

export const LIMA_SUB_FILTERS: Record<LimaSubFilter, LimaCard<LimaSubFilter> & { parent: LimaStep | LimaTask | "agenda" }> = {
  mas_de_30: {
    key: "mas_de_30",
    parent: "por_sacar",
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
  hoy_sin_guia: {
    key: "hoy_sin_guia",
    parent: "agenda",
    label: "Hoy sin guía",
    hint: "Salen hoy (o debían salir) y todavía no tienen guía del courier ni rótulo: no van a salir si nadie la genera. Ábrelos y crea la guía desde la Mesa de ruta.",
    empty: "Todo lo de hoy tiene su guía o su rótulo.",
  },
  manana_sin_guia: {
    key: "manana_sin_guia",
    parent: "agenda",
    label: "Mañana sin guía",
    hint: "Salen mañana y todavía no tienen guía del courier ni rótulo. Genérala hoy para que salgan.",
    empty: "Todo lo de mañana tiene su guía o su rótulo.",
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

/**
 * Cuántos días de reparto tiene «Mañana»: uno, el próximo (owner, 15-11-2026:
 * «lo del martes al viernes, ponlo dentro de Después»). Si mañana es domingo,
 * un acuerdo para el domingo cae en «Mañana» con el lunes.
 */
export const AGENDA_NAMED_DAYS = 1;

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

/** El cajón de la Agenda de un día: lo vencido sigue en Hoy; el próximo día de reparto es «Mañana». */
export function agendaKeyOf(day: string | null, today: string, window: readonly string[]): LimaAgendaKey {
  if (!day) return "sin_fecha";
  if (day <= today) return "hoy";
  return window.length && day <= window[window.length - 1]! ? "manana" : "despues";
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

/** Las tarjetas de la Agenda: Hoy, Mañana (el próximo día de reparto), Después y Sin fecha. */
export function agendaCards(today: string, _counts: Readonly<Record<string, number>> = {}, window = agendaWindow(today)): LimaCard<LimaAgendaKey>[] {
  const manana = window[window.length - 1] ?? shiftDay(today, 1);
  const literal = manana === shiftDay(today, 1);
  return [
    {
      key: "hoy",
      label: "Hoy",
      hint: "Salen hoy, y los de un día que ya pasó sin que salieran (van primero). Los que no tienen guía ni rótulo son una alerta.",
      empty: "No hay pedidos agendados para hoy con estos filtros.",
    },
    {
      key: "manana",
      label: literal ? `Mañana · ${agendaDayLabel(manana)}` : agendaDayLabel(manana),
      hint: `Salen el ${agendaDayLong(manana)}, el próximo día de reparto. Los que no tienen guía ni rótulo son una alerta.`,
      empty: `No hay pedidos agendados para el ${programDayLabel(manana)} con estos filtros.`,
    },
    {
      key: "despues",
      label: "Después",
      hint: `Agendados después del ${agendaDayLong(manana)}.`,
      empty: "No hay pedidos agendados más adelante con estos filtros.",
    },
    {
      key: "sin_fecha",
      label: "Sin fecha",
      hint: "Por sacar a reparto y todavía sin día: ni acuerdo con la clienta, ni programa, ni recojo del courier, ni «Programar envío». Elige varios y «Mover a…» un día.",
      empty: "Todo lo que falta sacar tiene día con estos filtros.",
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
  /** Su paso del flujo: uno y solo uno por pedido (los pasos suman el total). */
  step: LimaStep;
  /** Tiene guía de courier viva o un rótulo de salida (no está en «por generar rótulo» ni «por reprogramar»). */
  guide: boolean;
  task: LimaTask | null;
  /** Nunca salió y se creó hace más de 30 días (dentro de «Sacar a reparto»). */
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
 * Su paso, su cajón de la Agenda y su courier. Con un courier, entra a la Agenda solo si
 * tiene un día de hoy en adelante (el recojo de Aliclik, un acuerdo): un día
 * que pasó ya no es una fecha por cumplir, el courier lo tiene. Sin courier,
 * siempre: con su día (lo vencido en Hoy) o en «Sin fecha».
 */
export function classifyLimaRow(row: LimaPendingOrder, c: PendingCase | undefined, today: string, window: readonly string[]): LimaRowClass {
  const task = limaTaskOf(row, c);
  const courier = limaCourierState(row);
  const day = limaAgendaDay(row, c);
  const step = limaStepOf(task, courier);
  // Con un courier, la Agenda solo lo cuenta con un día de hoy en adelante. Sin
  // courier: con su día; sin día, «Sin fecha» solo si es por sacar a reparto.
  const agenda = courier
    ? (day && day >= today ? agendaKeyOf(day, today, window) : null)
    : day ? agendaKeyOf(day, today, window) : step === "por_sacar" ? "sin_fecha" : null;
  return {
    step,
    guide: Boolean(courier) || Boolean(row.ops?.courierDelivered) || (row.substage != null && !NO_GUIDE_SUBSTAGES.has(row.substage)),
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

/** Las subetapas en las que el pedido todavía no tiene guía ni rótulo de salida. */
const NO_GUIDE_SUBSTAGES = new Set(["por_generar_rotulo", "por_reprogramar_lima"]);

/**
 * El paso del flujo, de la tarea y el courier (owner, 15-11-2026). La tarea
 * manda («Por cerrar» gana a todo, como en `limaTaskOf`); sin tarea, lo que
 * lleva un courier está «Con el courier» y lo demás —lo que nunca salió, lo
 * agendado sin courier— en «Sacar a reparto».
 */
export function limaStepOf(task: LimaTask | null, courier: LimaCourierState | null): LimaStep {
  if (task === "novedad" || task === "llamar_despues" || task === "no_entregados" || task === "por_cerrar") return task;
  if (task === "primer_despacho") return "por_sacar";
  return courier ? "con_courier" : "por_sacar";
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
  /** Los seis pasos: suman `todos`. */
  step: Record<LimaStep, number>;
  task: Record<LimaTask, number>;
  sub: Record<LimaSubFilter, number>;
  /** Por cajón: «hoy», cada día, «despues» y «sin_fecha». */
  agenda: Record<string, number>;
  courier: Record<LimaCourierState, number>;
}

export function limaBoardCounts(rows: readonly LimaPendingOrder[], classes: ReadonlyMap<string, LimaRowClass>): LimaBoardCounts {
  const counts: LimaBoardCounts = {
    todos: rows.length,
    step: { novedad: 0, llamar_despues: 0, no_entregados: 0, por_sacar: 0, con_courier: 0, por_cerrar: 0 },
    task: { primer_despacho: 0, no_entregados: 0, novedad: 0, llamar_despues: 0, por_cerrar: 0 },
    sub: { mas_de_30: 0, reintentos_aliclik: 0, esperan_anulacion: 0, reprogramados: 0, hoy_sin_guia: 0, manana_sin_guia: 0 },
    agenda: { hoy: 0, manana: 0, despues: 0, sin_fecha: 0 },
    courier: { guia_creada: 0, en_ruta: 0, retornando: 0 },
  };
  for (const row of rows) {
    const cls = classes.get(row.orderId);
    if (!cls) continue;
    counts.step[cls.step] += 1;
    if (cls.task) counts.task[cls.task] += 1;
    if (cls.agenda === "hoy" && !cls.guide) counts.sub.hoy_sin_guia += 1;
    if (cls.agenda === "manana" && !cls.guide) counts.sub.manana_sin_guia += 1;
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
const STEP_SET = new Set<string>(LIMA_STEPS);
const COURIER_SET = new Set<string>(LIMA_COURIER_STATES);

/** ¿La fila entra en el filtro `key`? */
export function boardMatches(cls: LimaRowClass, key: LimaBoardKey): boolean {
  if (key === "todos") return true;
  if (STEP_SET.has(key)) return cls.step === key;
  if (TASK_SET.has(key)) return cls.task === key;
  if (COURIER_SET.has(key)) return cls.courier === key;
  switch (key) {
    case "mas_de_30": return cls.stale;
    case "reintentos_aliclik": return cls.retry;
    case "esperan_anulacion": return cls.awaitingCancel;
    case "reprogramados": return cls.agreed;
    case "hoy_sin_guia": return cls.agenda === "hoy" && !cls.guide;
    case "manana_sin_guia": return cls.agenda === "manana" && !cls.guide;
    default: return cls.agenda === key;
  }
}

/**
 * Lo que dice `atencion` en la URL. Los enlaces de la pantalla anterior
 * siguen abriendo lo más cercano: «Programados para hoy» es Hoy, «para
 * mañana» Mañana, «para después» Después, «Nunca salieron» y «Confirmar primer
 * despacho» Sacar a reparto, «Por decidir» No entregados, «Cerrados» Esperan
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
    case "programados_manana": return "manana";
    case "programados_despues": return "despues";
    case "nunca_salieron": return "por_sacar";
    case "primer_despacho": return "por_sacar";
    case "por_decidir": return "no_entregados";
    case "cerrados": return "esperan_anulacion";
    case "programados": return "reprogramados";
  }
  if (STEP_SET.has(value) || TASK_SET.has(value) || COURIER_SET.has(value) || value in LIMA_SUB_FILTERS) return value;
  if (value === "hoy" || value === "manana" || value === "despues" || value === "sin_fecha") return value;
  // Un día guardado de la Agenda anterior abre su cajón de ahora.
  if (ISO_DAY.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`))) {
    const key = agendaKeyOf(value, today, agendaWindow(today));
    return key === "sin_fecha" ? "todos" : key;
  }
  return "todos";
}

/** La tarjeta (o el filtro de adentro) de una clave, para el título de la lista y su vacío. */
export function boardCard(key: LimaBoardKey, today: string): (LimaCard & { block: "gestion" | "agenda" | "courier" }) | null {
  if (key === "todos") return null;
  const step = LIMA_STEP_CARDS.find((c) => c.key === key);
  if (step) return { ...step, block: "gestion" };
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

const STEP_RANK = new Map(LIMA_STEPS.map((step, i) => [step, i * 10]));
const COURIER_RANK = new Map(LIMA_COURIER_STATES.map((state, i) => [state, i]));
const AGENDA_RANK: Record<string, number> = { hoy: 0, manana: 1, despues: 2, sin_fecha: 3 };

/** El orden de la lista: por paso; en «Sacar a reparto», hoy, mañana, después y sin fecha; con el courier, por su estado. */
function groupRank(cls: LimaRowClass): number {
  const base = STEP_RANK.get(cls.step)!;
  if (cls.step === "por_sacar") return base + (AGENDA_RANK[cls.agenda ?? "sin_fecha"] ?? 3);
  if (cls.step === "con_courier") return base + (cls.courier ? COURIER_RANK.get(cls.courier)! : 3);
  return base;
}

/**
 * La lista de un filtro, en el orden de los pasos del flujo.
 * - No entregados y Llamar después siguen el orden de los casos
 *   (`caseOrder`, el de `sortRepro`: los fallos de ayer, lo vencido, la hora
 *   de la llamada).
 * - Sacar a reparto: hoy (lo vencido primero), mañana, después y, al final, lo
 *   que no tiene día, del más antiguo al más reciente (owner, 06-11-2026: en
 *   un pico lo armado hace días se hundía al final); sin fecha de creación,
 *   primero.
 * - Con el courier, por su estado (guía creada, en ruta, retornando).
 * - Novedad, Por cerrar y lo del courier: lo que más lleva en su etapa, primero.
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
    const step = a.cls.step;
    if (step === "no_entregados" || step === "llamar_despues") return a.caseAt - b.caseAt || a.since - b.since;
    if (step === "por_sacar") {
      // Lo que tiene día, por día (lo vencido primero); sin día, lo más antiguo primero (owner, 06-11-2026).
      if (a.cls.agendaDay || b.cls.agendaDay) return (a.cls.agendaDay ?? "9999").localeCompare(b.cls.agendaDay ?? "9999") || a.created - b.created;
      return a.created - b.created;
    }
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
        : "Sacarlo a reparto: agenda el día y genera su guía (confirma los datos con la clienta si hace falta).";
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
  if (!cls.guide && cls.agenda === "hoy") {
    return cls.agendaDay && cls.agendaDay < today
      ? `Debía salir el ${programDayLabel(cls.agendaDay)} y no tiene guía ni rótulo: créala hoy desde la Mesa de ruta o reagéndalo.`
      : "Sale hoy y no tiene guía ni rótulo: créala desde la Mesa de ruta para que salga.";
  }
  if (!cls.guide && cls.agenda === "manana") return "Sale mañana y no tiene guía ni rótulo: genérala hoy.";
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

/** Los días que «Agendar» ofrece como chips: hoy y los cinco próximos de reparto (no cambia con la Agenda de cuatro cajones). */
export const AGENDAR_QUICK_DAYS = 5;
export function agendarQuickDays(today: string, count = AGENDAR_QUICK_DAYS): string[] {
  return [today, ...agendaWindow(today, count).filter(isDeliveryDay)];
}

/** El último día que admite el camino (`maxDays` desde hoy). */
export function agendarMaxDay(today: string, maxDays: number): string {
  return shiftDay(today, maxDays);
}
