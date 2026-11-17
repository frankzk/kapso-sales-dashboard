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
import { limaDay, programDayLabel } from "@/lib/dispatch-day";
import { courierDisplayName } from "@/lib/dispatched-with";
import { DISPATCH_COURIER_LABEL, DISPATCH_DATE_MAX_DAYS, isDispatchCourier, type DispatchCourier } from "@/lib/dispatch-date";
import { limaClock } from "@/lib/grupo-gf-courier";
import { RESCHEDULE_MAX_DAYS } from "@/lib/gf-dispatch-program";
import { fullDeliveryDaysBetween, isCustomerNovelty } from "@/lib/lima-stuck";
import { reproCallTimeLabel, reproCourierStoreProblem } from "@/lib/repro-lima";
import { SWAYP_SUNDAY_ERROR, isSwaypDispatchDay } from "@/lib/swayp-dispatch-days";

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
export type LimaSubFilter =
  | "nunca_salieron" | "mas_de_30" | "guia_sin_recoger" | "salieron_sin_dia"
  | "por_acordar" | "reintentos_aliclik" | "sin_reporte"
  | "esperan_anulacion" | "reprogramados" | "hoy_sin_guia" | "manana_sin_guia"
  | "nuevos_hoy" | "nuevos_manana" | "nuevos_despues" | "nuevos_sin_dia" | "nuevos_sin_guia";

/**
 * Los ocho pasos del flujo (owner, 15-11-2026, tercera vuelta: «estos 5 no
 * suman 1,438»). Son una PARTICIÓN: cada pedido pendiente está en exactamente
 * un paso, así que suman el total. Los cinco primeros son el trabajo del
 * equipo; «Con el courier» y «Por cerrar» («no lo necesito como tal») se
 * dibujan plegados (`LIMA_FOLDED_STEPS`), pero cuentan para que la suma cierre.
 * «Programados» es un paso propio desde el 16-11-2026 (owner: «un programado es
 * un programado y tiene que salir a su propio flujo del día… en no entregados
 * y en sacar a reparto quedan básicamente los pedidos estancados»).
 */
export type LimaStep = "novedad" | "llamar_despues" | "no_entregados" | "por_sacar" | "nuevos" | "programados" | "con_courier" | "por_cerrar";
export const LIMA_STEPS: readonly LimaStep[] = ["novedad", "llamar_despues", "no_entregados", "por_sacar", "nuevos", "programados", "con_courier", "por_cerrar"];
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
    // «Nunca salieron», como lo llama el equipo (owner, 16-11-2026: «no veo el
    // bloque de no salieron nunca»): el filtro de adentro de «Sacar a reparto».
    label: "Nunca salieron",
    hint: "Nunca tuvieron una salida a reparto y no tienen día: confirma con la clienta y agenda la salida. Del más antiguo al más reciente; dentro, los de más de 30 días.",
    empty: "No hay pedidos que nunca salieron y estén sin día con estos filtros.",
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
    hint: "«Por reprogramar Lima» sin un día de salida, lo que el courier está devolviendo y lo que salió a ruta hace más de un día sin reporte: llama a la clienta y acuerda el día y el courier con «Atender»; con su día pasa a «Programados». Dentro, los reintentos por Aliclik (salen sin llamar), «Retornando» y «Sin reporte de la ruta».",
    empty: "No hay no entregados por gestionar con estos filtros.",
  },
  {
    key: "por_sacar",
    label: "Sacar a reparto",
    hint: "Lo que ya salió alguna vez, volvió y no tiene un día nuevo, y la guía que el courier no recogió en su día. Lo que sale por primera vez está en «Nuevos». Agéndalo: con su día pasa a «Programados».",
    empty: "No queda nada por sacar a reparto con estos filtros.",
  },
  {
    key: "nuevos",
    label: "Nuevos",
    // Owner, 17-11-2026: «queremos un apartado que incluya esos nuevos aquí en el flujo del día».
    hint: "Salen por primera vez y todavía no salen: nunca salieron a reparto. Por día de su guía: Hoy, Mañana y Después; sin guía ni día, «Sin día». Que salgan: lo de hoy y mañana sin guía ni rótulo es una alerta.",
    empty: "No hay pedidos nuevos por salir con estos filtros.",
  },
  {
    key: "programados",
    label: "Programados",
    hint: "Ya salieron alguna vez y tienen un día nuevo de salida: lo acordado con la clienta, «Programar envío», el programa de Grupo GF o la guía que el courier recoge en su día. Lo que sale por primera vez está en «Nuevos». Dentro, por día: Hoy, Mañana y Después. Que salgan: lo de hoy y mañana sin guía ni rótulo es una alerta.",
    empty: "No hay pedidos programados con estos filtros.",
  },
  {
    key: "con_courier",
    label: "Con el courier",
    hint: "Ya salieron con un courier (en ruta) o tienen su guía sin un día de recojo por delante. Solo seguimiento: aquí no se opera al courier. Lo que el courier devuelve está en No entregados.",
    empty: "Ningún courier lleva pedidos con estos filtros.",
  },
  {
    key: "por_cerrar",
    label: "Por cerrar",
    hint: "El courier dice que lo entregó y Kapta todavía no lo cierra (falta validar el cobro), o el caso se cerró con «Desarmar y cerrar» y espera que la tienda anule la venta. No es trabajo del equipo de Lima: se mira.",
    empty: "No hay pedidos por cerrar con estos filtros.",
  },
];

/**
 * Las partes de un paso (owner, 16-11-2026: «en el desglose dentro la suma de
 * las partes no da 216»): los filtros de adentro de «Sacar a reparto» y de «No
 * entregados» se reparten el paso, sin repetirse, y suman su cifra, como los
 * seis pasos suman el total. «Con el courier» ya lo hacía (Guía creada + En
 * ruta). Los trabados no son una parte: son una alerta encima.
 */
export const LIMA_STEP_PARTS: Partial<Record<LimaStep, readonly LimaSubFilter[] | readonly LimaBoardKey[]>> = {
  no_entregados: ["por_acordar", "reintentos_aliclik", "retornando", "sin_reporte"],
  por_sacar: ["guia_sin_recoger", "nunca_salieron", "mas_de_30", "salieron_sin_dia"],
  // Hoy (si hoy se reparte), Mañana (el próximo día de reparto) y Después: `agendaCards`.
  programados: ["hoy", "manana", "despues"],
  // Los nuevos, por día de su guía; sin guía ni día, al final (owner, 17-11-2026).
  nuevos: ["nuevos_hoy", "nuevos_manana", "nuevos_despues", "nuevos_sin_dia"],
  con_courier: ["guia_creada", "en_ruta"],
};

export const LIMA_SUB_FILTERS: Record<LimaSubFilter, LimaCard<LimaSubFilter> & { parent: LimaStep | LimaTask | "agenda" }> = {
  nunca_salieron: {
    key: "nunca_salieron",
    parent: "por_sacar",
    label: "Nunca salieron",
    hint: "Nunca tuvieron una salida a reparto, no tienen día y se crearon en los últimos 30 días: confirma con la clienta y agenda la salida. Es el apartado a dejar en cero.",
    empty: "No hay pedidos que nunca salieron y estén sin día con estos filtros.",
  },
  mas_de_30: {
    key: "mas_de_30",
    parent: "por_sacar",
    label: "Más de 30 días",
    hint: "Nunca salieron y se crearon hace más de 30 días: confirma si la venta sigue; si no, anúlala en la tienda.",
    empty: "No hay pedidos de más de 30 días sin salida registrada con estos filtros.",
  },
  salieron_sin_dia: {
    key: "salieron_sin_dia",
    parent: "por_sacar",
    label: "Ya salieron, sin día",
    hint: "Salieron a reparto antes, volvieron y todavía no tienen un día nuevo: agenda la salida.",
    empty: "Todo lo que ya salió antes tiene su día nuevo con estos filtros.",
  },
  por_acordar: {
    key: "por_acordar",
    parent: "no_entregados",
    label: "Por acordar",
    hint: "«Por reprogramar Lima» sin un día de salida ni un reintento por Aliclik: llama a la clienta y acuerda el día y el courier con «Atender».",
    empty: "No hay no entregados por acordar con estos filtros.",
  },
  guia_sin_recoger: {
    key: "guia_sin_recoger",
    parent: "por_sacar",
    label: "Guía sin recoger",
    hint: "Con la guía de un courier que debía recogerlo un día que ya pasó y no lo recogió: todavía no salió. Coordina el recojo o crea la guía con otro courier desde la Mesa de ruta.",
    empty: "Ninguna guía se quedó sin recoger con estos filtros.",
  },
  reintentos_aliclik: {
    key: "reintentos_aliclik",
    parent: "no_entregados",
    label: "Reintentos Aliclik",
    hint: "No entregados de Alexis, Urpi o AUTOECOM por «no contesta», «no estaba» u «otro»: vuelven a salir por Aliclik (AUTOECOM, luego ALIDRIVER), sin llamar. Apruébalos aquí o crea la guía desde la ficha con el transporte indicado.",
    empty: "No hay reintentos por Aliclik con estos filtros.",
  },
  sin_reporte: {
    key: "sin_reporte",
    parent: "no_entregados",
    label: "Sin reporte de la ruta",
    hint: "Salieron a ruta y pasó un día de reparto entero después del día de la ruta (el domingo no cuenta) sin que el motorizado ni el courier reporten la entrega: se cuentan como no entregados para que no se queden trabados «con el courier». Pide el reporte; si no se entregó, acuerda el nuevo día con la clienta.",
    empty: "Todas las rutas vencidas tienen su reporte con estos filtros.",
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
  nuevos_hoy: {
    key: "nuevos_hoy", parent: "nuevos", label: "Hoy",
    hint: "Nuevos que salen hoy (o debían salir) por el día de su guía.",
    empty: "No hay nuevos que salgan hoy con estos filtros.",
  },
  nuevos_manana: {
    key: "nuevos_manana", parent: "nuevos", label: "Mañana",
    hint: "Nuevos que salen el próximo día de reparto.",
    empty: "No hay nuevos que salgan mañana con estos filtros.",
  },
  nuevos_despues: {
    key: "nuevos_despues", parent: "nuevos", label: "Después",
    hint: "Nuevos que salen después del próximo día de reparto.",
    empty: "No hay nuevos para después con estos filtros.",
  },
  nuevos_sin_dia: {
    key: "nuevos_sin_dia", parent: "nuevos", label: "Sin día",
    hint: "Nuevos sin guía ni día de salida (o con una guía sin día de recojo): confirma con la clienta y agenda la salida.",
    empty: "Todos los nuevos tienen su día con estos filtros.",
  },
  nuevos_sin_guia: {
    key: "nuevos_sin_guia", parent: "nuevos", label: "Sin guía (hoy o mañana)",
    hint: "Nuevos que salen hoy o mañana sin guía del courier ni rótulo, y que la automática no va a crear: genérala para que salgan.",
    empty: "Todos los nuevos de hoy y mañana tienen su guía.",
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
    hint: "Todo lo que sale mañana y todavía no tiene guía del courier ni rótulo, acordado o no. Los que va a crear la automática (GF, Aliclik o Swayp) lo dicen en su fila; los demás, genéralos hoy para que salgan.",
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
    hint: "El courier ya lo tiene y la ruta es de hoy o del día de reparto anterior: recibido, en tránsito o en reparto. Si pasa un día de reparto entero sin reporte, va a No entregados → «Sin reporte de la ruta». Cada fila dice el día de su ruta.",
    empty: "Ningún courier lleva pedidos con estos filtros.",
  },
  {
    key: "retornando",
    label: "Retornando",
    hint: "El courier lo está devolviendo al almacén: no se entregó. Llama a la clienta y acuerda el nuevo día; sale otra vez cuando llegue al almacén.",
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

/** El próximo día de reparto desde hoy: hoy si se reparte; si no (domingo), el siguiente. */
export function nextDeliveryDay(today: string): string {
  let day = today;
  while (!isDeliveryDay(day)) day = shiftDay(day, 1);
  return day;
}

/**
 * El cajón de la Agenda de un día. Un día que ya pasó (o hoy) sale el próximo
 * día de reparto: hoy si se reparte, y si no —domingo— «Mañana» (owner,
 * 16-11-2026: «¿por qué atrasados? Si saldrían mañana de todas maneras… estuvo
 * mal ahí el agendamiento»). La fila sigue diciendo «Vencido · sáb 14/11».
 */
export function agendaKeyOf(day: string | null, today: string, window: readonly string[]): LimaAgendaKey {
  if (!day) return "sin_fecha";
  if (day <= today) return isDeliveryDay(today) ? "hoy" : "manana";
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

/**
 * El día que Kapta propone a lo que falta sacar y no tiene día: el próximo día
 * de reparto (el de «Mañana»). Es una propuesta: el equipo la confirma con
 * «Agendar» o en lote con «Mover a…» (owner, 15-11-2026: «Kapta propone, el
 * equipo confirma»).
 */
export function limaSuggestedDay(today: string): string {
  const window = agendaWindow(today);
  return window[window.length - 1] ?? shiftDay(today, 1);
}

/**
 * Desde qué minuto de Lima «Hoy sin guía» es alerta (owner, 15-11-2026: «desde
 * las 10:30»). Antes, que falte la guía de hoy es normal (la de Aliclik del
 * día programado se crea a las 8, 10 y 12): se cuenta, pero sin alerta.
 */
export const HOY_SIN_GUIA_ALERT_MINUTE = 10 * 60 + 30;
export function hoySinGuiaAlert(now: Date): boolean {
  return limaClock(now).minute >= HOY_SIN_GUIA_ALERT_MINUTE;
}

/**
 * Las tarjetas de «Programados» (antes «Agenda»): Hoy, Mañana (el próximo día
 * de reparto) y Después. Sin «Sin fecha» (owner, 16-11-2026: «¿qué sentido
 * tiene un programado sin fecha?»): lo que no tiene día vive en «Sacar a
 * reparto» («Nunca salieron», «Más de 30 días», «Ya salieron, sin día»). En un
 * día sin reparto (domingo) no hay «Hoy»: lo de hoy y lo que tenía un día que
 * ya pasó sale el próximo día de reparto, en «Mañana».
 */
export function agendaCards(today: string, _counts: Readonly<Record<string, number>> = {}, window = agendaWindow(today)): LimaCard<LimaAgendaKey>[] {
  const manana = window[window.length - 1] ?? shiftDay(today, 1);
  const literal = manana === shiftDay(today, 1);
  const delivery = isDeliveryDay(today);
  const hoy: LimaCard<LimaAgendaKey>[] = delivery
    ? [{
        key: "hoy",
        label: "Hoy",
        hint: "Salen hoy, y los de un día que ya pasó sin que salieran (van primero). Los que no tienen guía ni rótulo son una alerta.",
        empty: "No hay pedidos agendados para hoy con estos filtros.",
      }]
    : [];
  return [
    ...hoy,
    {
      key: "manana",
      label: literal ? `Mañana · ${agendaDayLabel(manana)}` : agendaDayLabel(manana),
      hint: delivery
        ? `Salen el ${agendaDayLong(manana)}, el próximo día de reparto. Los que no tienen guía ni rótulo son una alerta.`
        : `Salen el ${agendaDayLong(manana)}, el próximo día de reparto: hoy no se reparte, así que también lo que tenía un día que ya pasó o hoy (van primero). Los que no tienen guía ni rótulo son una alerta.`,
      empty: `No hay pedidos agendados para el ${programDayLabel(manana)} con estos filtros.`,
    },
    {
      key: "despues",
      label: "Después",
      hint: `Agendados después del ${agendaDayLong(manana)}.`,
      empty: "No hay pedidos agendados más adelante con estos filtros.",
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

/** «Nuevo»: vive en `lib/repro-lima-pending.ts` (la fila y la clasificación lo usan). */
import { limaIsNew } from "@/lib/repro-lima-pending";
export { limaIsNew };

/** La alerta de «Nuevos»: sale hoy o mañana sin guía ni rótulo, y la automática no la crea. Pura. */
export function limaNewWithoutGuide(cls: Pick<LimaRowClass, "step" | "agenda" | "guide" | "autoGuide">): boolean {
  return cls.step === "nuevos" && (cls.agenda === "hoy" || cls.agenda === "manana") && !cls.guide && !cls.autoGuide;
}

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
    // Un no entregado que ya tiene su guía nueva esperando recojo (owner, 16-11-2026, #KP204876): guía creada, no en ruta.
    if (isPorReprogramarLima(row) && row.courierPickup) return "guia_creada";
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
 * El día en que salió a ruta: el más reciente entre la caja de Grupo GF de su
 * salida viva (el día de la ruta del motorizado), la salida
 * (`dispatched_at`) y la entrada a En curso. El más reciente, para que una
 * salida nueva nunca se lea como una ruta vieja.
 */
export function limaRouteDay(row: LimaPendingOrder): string | null {
  const days = [row.ops?.lastGfBox?.day ?? null, limaDay(row.dispatchedAt), limaDay(row.macroSince)].filter((d): d is string => Boolean(d));
  return days.length ? days.sort()[days.length - 1]! : null;
}

/**
 * Sale con el reparto propio de Grupo GF (una parada en Kapta), no con la guía
 * de otro courier: solo ahí el equipo puede registrar «No se entregó» por el
 * motorizado (owner, 15-11-2026). En las guías de otros couriers el resultado
 * lo reporta el courier.
 */
export function limaOwnRoute(row: LimaPendingOrder): boolean {
  if (liveGuideCourier(row)) return false;
  return Boolean(row.ops?.lastGfBox) || GF_INTERNAL.has(row.courier ?? "");
}

/**
 * Cuántos días de reparto enteros se espera el reporte después del día de la
 * ruta (owner, 15-11-2026): «si salió a ruta un lunes, el miércoles no puede
 * estar con el courier». El martes todavía sí; desde el miércoles, no
 * entregado. El domingo no cuenta (owner, «días de reparto»): si salió un
 * sábado, el lunes todavía espera y desde el martes es no entregado.
 */
export const ROUTE_REPORT_GRACE_DAYS = 1;

/**
 * Salió a ruta y venció: En curso, en la calle (no retornando ni dado por
 * entregado), y pasó un día de reparto entero después del día de la ruta sin
 * resultado.
 * Repro Lima lo cuenta como no entregado («se asume como no entregado… si no se
 * van a quedar entrampados»). Es una etiqueta de pantalla: no cambia la etapa.
 */
export function routeWithoutReport(row: LimaPendingOrder, courier: LimaCourierState | null, today: string): boolean {
  if (row.stage !== "en_curso" || courier !== "en_ruta" || row.ops?.courierDelivered || isPorReprogramarLima(row)) return false;
  const day = limaRouteDay(row);
  return Boolean(day && fullDeliveryDaysBetween(day, today) >= ROUTE_REPORT_GRACE_DAYS);
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
  // Ya tiene su salida nueva: la guía de un courier que espera su recojo. No es
  // un no entregado por gestionar, lo lleva el courier (owner, 16-11-2026: «ya
  // tiene guía para mañana… no guarda lógica»).
  if (isPorReprogramarLima(row) && row.courierPickup) return null;
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
  /** Salió a ruta hace más de un día sin reporte: cuenta como no entregado (`routeWithoutReport`). */
  noReport: boolean;
  /** Su guía debía recogerse un día que ya pasó y el courier no la recogió: por sacar a reparto. */
  missedPickup: boolean;
  /**
   * Su día de recojo pasó hace menos de un día de reparto entero: el courier la
   * recoge el próximo día de reparto, que es su `agendaDay` (sin «Vencido»).
   */
  pickupRolled: boolean;
  /** El día en que salió a ruta (`limaRouteDay`), o null si no está En curso. */
  routeDay: string | null;
  /** Salió a ruta hoy. */
  routeToday: boolean;
  /**
   * La guía GF automática lo cubre: su tienda la tiene en Activo y está en
   * Preparación · Por generar rótulo sin un acuerdo de Repro Lima (como
   * `gfAutoSkip`). La pasada crea su guía en minutos, todo el día (16-11-2026).
   */
  autoGuide: boolean;
  /**
   * Quién crea esa guía sola: `gf_courier` (la guía GF automática) o `aliclik`
   * / `fenix` («Guía Aliclik y Swayp del día programado» en Activo, 0349, con
   * lo programado con ese courier). Null si nadie.
   */
  autoGuideBy: "gf_courier" | "aliclik" | "fenix" | null;
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
export function classifyLimaRow(row: LimaPendingOrder, c: PendingCase | undefined, today: string, window: readonly string[], opts: LimaClassifyOptions = {}): LimaRowClass {
  const courier = limaCourierState(row);
  const base = limaTaskOf(row, c);
  // Una ruta vencida sin reporte ya no está «con el courier»: es un no entregado (owner, 15-11-2026).
  const noReport = base === null && routeWithoutReport(row, courier, today);
  // Lo que el courier devuelve tampoco: no se entregó (owner, 15-11-2026: «los de retornando deberían estar en no entregados»).
  const returning = base === null && courier === "retornando";
  const task: LimaTask | null = noReport || returning ? "no_entregados" : base;
  const scheduled = limaAgendaDay(row, c);
  // La guía que espera su recojo y cuyo día ya pasó: el courier la recoge el
  // próximo día de reparto (owner, 16-11-2026, #KP204807: «sale a reparto
  // mañana y ya está listo, pero el sistema lo marca como Vencido»). Solo si
  // pasó un día de reparto entero después de su día sin que la recoja, es una
  // guía sin recoger: todavía no salió, está por sacar a reparto (15-11-2026).
  const pickupDay = courier === "guia_creada" ? row.courierPickup?.date ?? scheduled : null;
  const pickupLate = base === null && Boolean(pickupDay && pickupDay < today);
  const missedPickup = pickupLate && fullDeliveryDaysBetween(pickupDay!, today) >= ROUTE_REPORT_GRACE_DAYS;
  const day = pickupLate && !missedPickup ? nextDeliveryDay(today) : scheduled;
  const baseStep = missedPickup ? "por_sacar" : limaStepOf(task, courier);
  // Con un courier, la Agenda solo lo cuenta con un día de hoy en adelante. Sin
  // courier (o con la guía sin recoger): con su día; sin día, «Sin fecha» solo
  // si es por sacar a reparto.
  const agenda = courier && !missedPickup
    ? (day && day >= today ? agendaKeyOf(day, today, window) : null)
    : day ? agendaKeyOf(day, today, window) : baseStep === "por_sacar" ? "sin_fecha" : null;
  // «Programados», su propio paso (owner, 16-11-2026: «un programado es un
  // programado»): tiene día de salida y todavía no sale (sin courier o con la
  // guía que espera su recojo), venga de No entregados (un «Por reprogramar
  // Lima» con su día en el programa de Grupo GF), de Sacar a reparto o de la
  // guía creada. La novedad, «Llamar después» y «Por cerrar» mandan; la guía
  // que el courier no recogió en su día es un estancado de Sacar a reparto.
  const programmed = Boolean(agenda && agenda !== "sin_fecha") && !missedPickup
    && (courier === null || courier === "guia_creada")
    && (baseStep === "no_entregados" || baseStep === "por_sacar" || baseStep === "con_courier");
  const planned: LimaStep = programmed ? "programados" : baseStep;
  // «Nuevos» (owner, 17-11-2026): lo que sale por primera vez y todavía no
  // sale, venga de Sacar a reparto, de Programados o de la guía creada. La
  // novedad, «Llamar después», No entregados y «Por cerrar» siguen mandando.
  const step: LimaStep = limaIsNew(row) && (planned === "por_sacar" || planned === "programados" || planned === "con_courier") ? "nuevos" : planned;
  const autoBy = limaAutoGuideBy(row, c, opts);
  return {
    step,
    guide: Boolean(courier) || Boolean(row.ops?.courierDelivered) || (row.substage != null && !NO_GUIDE_SUBSTAGES.has(row.substage)),
    task,
    stale: task === "primer_despacho" && limaQueueSegment(row, today, c) === "mas_de_30",
    retry: Boolean(c?.retryChain),
    noReport,
    missedPickup,
    routeDay: row.stage === "en_curso" ? limaRouteDay(row) : null,
    routeToday: row.stage === "en_curso" && limaRouteDay(row) === today,
    autoGuide: autoBy !== null,
    autoGuideBy: autoBy,
    awaitingCancel: c?.list === "cerrados",
    agreed: c?.list === "programados" && Boolean(c.agreement?.agreedOn),
    agenda,
    agendaDay: day,
    agendaOrigin: day ? limaAgendaOrigin(row, c) : null,
    pickupRolled: pickupLate && !missedPickup,
    courier,
  };
}

/**
 * ¿La fila ofrece crear la guía directo («Guía Aliclik», «Guía GF»; owner,
 * 16-11-2026: «como un fast forward»)? Solo si todavía no tiene guía ni rótulo
 * y está en Preparación, Por despachar o «Por reprogramar Lima»; la novedad y
 * «Por cerrar» no. La acción vuelve a pasar por todas las compuertas. Pura.
 */
export function limaQuickGuideEligible(row: Pick<LimaPendingOrder, "stage" | "substage">, cls: Pick<LimaRowClass, "guide" | "step">): boolean {
  if (cls.guide || cls.step === "por_cerrar" || cls.step === "novedad") return false;
  return row.stage === "preparacion" || row.stage === "por_despachar" || isPorReprogramarLima(row);
}

/**
 * El aviso flotante de «Guía Aliclik» / «Guía GF» (owner, 16-11-2026: «esa
 * alerta en verde que salga como un popup también»): el resultado en el título
 * y, debajo, el pedido con el dato de la guía, sin repetir la frase del aviso
 * de la página («Guía creada en GF Courier: …», «Guía creada en Aliclik para
 * #KP…: …»). Pura.
 */
export function quickGuideToast(orderName: string, courierName: string, notice: string | null | undefined): { title: string; detail: string } {
  const text = (notice ?? "").trim();
  const linked = /^Gu[ií]a existente vinculada/i.test(text) || /ya estaba vinculada/i.test(text);
  const rest = text.replace(/^Gu[ií]a (?:creada|existente vinculada) en [^:]+?(?: para [^:]+)?:\s*/i, "").replace(/\.$/, "");
  return {
    title: `${linked ? "Guía vinculada" : "Guía creada"} en ${courierName}`,
    detail: rest ? `${orderName} · ${rest}` : orderName,
  };
}

/** El transporte de Aliclik que «Guía Aliclik» propone: AUTOECOM si se puede (en Lima, owner 03-11-2026); si no, el primero elegible. Pura. */
export function defaultAliclikTransport(couriers: readonly { transportId: number; transportName?: string | null; selectable: boolean }[] | null | undefined): number | null {
  const selectable = (couriers ?? []).filter((c) => c.selectable);
  const autoecom = selectable.find((c) => /autoecom/i.test(c.transportName ?? ""));
  return (autoecom ?? selectable[0])?.transportId ?? null;
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

export interface LimaClassifyOptions {
  /** Las tiendas con la guía GF automática en Activo (`loadGfAutoActiveStores`). */
  autoGuideStores?: ReadonlySet<string>;
  /** Las tiendas con «Guía Aliclik y Swayp del día programado» en Activo (`loadLimaCourierAutoActiveStores`, 0349). */
  courierAutoStores?: ReadonlySet<string>;
}

/**
 * Quién crea sola la guía de un pedido sin guía, o null. Pura.
 * - La guía GF automática: Preparación · Por generar rótulo, sin acuerdo de
 *   Repro Lima y sin otro courier programado (como `gfAutoSkip`, 0348).
 * - La del día programado (0349): lo programado con Aliclik o Swayp, con
 *   «Programar envío» en Por generar rótulo o con un acuerdo en «Por
 *   reprogramar Lima» (`limaCourierEnvioCourier`, `limaCourierCaseCourier`).
 */
export function limaAutoGuideBy(row: LimaPendingOrder, c: PendingCase | undefined, opts: LimaClassifyOptions = {}): "gf_courier" | "aliclik" | "fenix" | null {
  const porRotulo = row.stage === "preparacion" && row.substage === "por_generar_rotulo";
  const agreedCourier = c?.agreement?.agreedOn ? c.agreement.courier ?? null : null;
  if (opts.courierAutoStores?.has(row.storeId)) {
    const courier = agreedCourier ?? (porRotulo ? row.scheduledCourier ?? null : null);
    if ((courier === "aliclik" || courier === "fenix") && (porRotulo || isPorReprogramarLima(row))) return courier;
  }
  if (opts.autoGuideStores?.has(row.storeId) && porRotulo && !agreedCourier && !c?.agreement?.agreedOn
    && (!row.scheduledCourier || row.scheduledCourier === "gf_courier")) return "gf_courier";
  return null;
}

/** Una clasificación por pedido: las cifras y la lista la reusan. */
export function classifyLimaRows(rows: readonly LimaPendingOrder[], cases: readonly PendingCase[], today: string, window = agendaWindow(today), opts: LimaClassifyOptions = {}): Map<string, LimaRowClass> {
  const caseById = new Map(cases.map((c) => [c.orderId, c]));
  return new Map(rows.map((row) => [row.orderId, classifyLimaRow(row, caseById.get(row.orderId), today, window, opts)]));
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
  /** De lo que sale mañana sin guía (todos en `manana_sin_guia`), los que creará la automática: no alarman. */
  autoGuideManana: number;
  /**
   * De «En ruta» (dentro de Con el courier), cuántos salieron hoy; los demás
   * son de la ruta anterior (owner, 15-11-2026: «¿cuándo estuvieron en ruta?»).
   */
  enRutaHoy: number;
}

export function limaBoardCounts(rows: readonly LimaPendingOrder[], classes: ReadonlyMap<string, LimaRowClass>): LimaBoardCounts {
  const counts: LimaBoardCounts = {
    todos: rows.length,
    step: { novedad: 0, llamar_despues: 0, no_entregados: 0, por_sacar: 0, nuevos: 0, programados: 0, con_courier: 0, por_cerrar: 0 },
    task: { primer_despacho: 0, no_entregados: 0, novedad: 0, llamar_despues: 0, por_cerrar: 0 },
    sub: { nunca_salieron: 0, mas_de_30: 0, guia_sin_recoger: 0, salieron_sin_dia: 0, por_acordar: 0, reintentos_aliclik: 0, sin_reporte: 0, esperan_anulacion: 0, reprogramados: 0, hoy_sin_guia: 0, manana_sin_guia: 0, nuevos_hoy: 0, nuevos_manana: 0, nuevos_despues: 0, nuevos_sin_dia: 0, nuevos_sin_guia: 0 },
    agenda: { hoy: 0, manana: 0, despues: 0 },
    courier: { guia_creada: 0, en_ruta: 0, retornando: 0 },
    autoGuideManana: 0,
    enRutaHoy: 0,
  };
  for (const row of rows) {
    const cls = classes.get(row.orderId);
    if (!cls) continue;
    counts.step[cls.step] += 1;
    if (cls.task) counts.task[cls.task] += 1;
    // «Programados»: sus días (Hoy, Mañana, Después) son sus partes; lo de hoy y
    // mañana sin guía y los reprogramados, filtros de adentro (no suman aparte).
    if (cls.step === "programados") {
      if (cls.agenda) counts.agenda[cls.agenda] = (counts.agenda[cls.agenda] ?? 0) + 1;
      if (cls.agenda === "hoy" && !cls.guide) counts.sub.hoy_sin_guia += 1;
      // Todo lo de mañana sin guía, acordado o no (owner, 17-11-2026: «lo lógico es que aparezca en
      // mañana sin guía»); los que creará la automática se cuentan aparte y no alarman.
      if (cls.agenda === "manana" && !cls.guide) {
        counts.sub.manana_sin_guia += 1;
        if (cls.autoGuide) counts.autoGuideManana += 1;
      }
      if (cls.agreed) counts.sub.reprogramados += 1;
    }
    // Las partes de «Sacar a reparto» y de «No entregados»: una y solo una por pedido (`limaStepPart`).
    const part = limaStepPart(cls);
    if (part) counts.sub[part] += 1;
    if (cls.awaitingCancel) counts.sub.esperan_anulacion += 1;
    if (limaNewWithoutGuide(cls)) counts.sub.nuevos_sin_guia += 1;
    // Guía creada y En ruta son los filtros de adentro de «Con el courier»; Retornando, de «No entregados».
    if (cls.courier && cls.step === COURIER_STEP[cls.courier]) counts.courier[cls.courier] += 1;
    if (cls.step === "con_courier" && cls.courier === "en_ruta" && cls.routeToday) counts.enRutaHoy += 1;
  }
  return counts;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const TASK_SET = new Set<string>(LIMA_TASKS);
const STEP_SET = new Set<string>(LIMA_STEPS);
const COURIER_SET = new Set<string>(LIMA_COURIER_STATES);
/** El paso donde vive el filtro de cada estado del courier: lo que vuelve es un no entregado. */
const COURIER_STEP: Record<LimaCourierState, LimaStep> = { guia_creada: "con_courier", en_ruta: "con_courier", retornando: "no_entregados" };

/**
 * La parte de su paso, para «Sacar a reparto» y «No entregados» (owner,
 * 16-11-2026: las partes suman el paso). La primera que aplica:
 * - Sacar a reparto (lo que no tiene día): «Guía sin recoger», «Nunca
 *   salieron» (los últimos 30 días), «Más de 30 días» y «Ya salieron, sin día».
 *   Lo que tiene día es «Programados», cuyas partes son sus días.
 * - No entregados: «Reintentos Aliclik», «Sin reporte de la ruta», «Retornando»
 *   (es el filtro del courier, sin parte propia) y «Por acordar».
 * Null en los demás pasos. Pura.
 */
export function limaStepPart(cls: LimaRowClass): LimaSubFilter | null {
  if (cls.step === "nuevos") {
    if (cls.agenda === "hoy") return "nuevos_hoy";
    if (cls.agenda === "manana") return "nuevos_manana";
    if (cls.agenda && cls.agenda !== "sin_fecha") return "nuevos_despues";
    return "nuevos_sin_dia";
  }
  if (cls.step === "por_sacar") {
    if (cls.missedPickup) return "guia_sin_recoger";
    if (cls.task === "primer_despacho") return cls.stale ? "mas_de_30" : "nunca_salieron";
    return "salieron_sin_dia";
  }
  if (cls.step === "no_entregados") {
    if (cls.retry) return "reintentos_aliclik";
    if (cls.noReport) return "sin_reporte";
    if (cls.courier === "retornando") return null;
    return "por_acordar";
  }
  return null;
}

/** ¿La fila entra en el filtro `key`? */
export function boardMatches(cls: LimaRowClass, key: LimaBoardKey): boolean {
  if (key === "todos") return true;
  if (STEP_SET.has(key)) return cls.step === key;
  if (TASK_SET.has(key)) return cls.task === key;
  if (COURIER_SET.has(key)) return cls.courier === key && cls.step === COURIER_STEP[key as LimaCourierState];
  switch (key) {
    case "nunca_salieron":
    case "mas_de_30":
    case "salieron_sin_dia":
    case "por_acordar":
    case "reintentos_aliclik":
    case "sin_reporte":
    case "guia_sin_recoger":
    case "nuevos_hoy":
    case "nuevos_manana":
    case "nuevos_despues":
    case "nuevos_sin_dia":
      return limaStepPart(cls) === key;
    case "nuevos_sin_guia": return limaNewWithoutGuide(cls);
    case "esperan_anulacion": return cls.awaitingCancel;
    // Los días y sus filtros son de «Programados» (owner, 16-11-2026).
    case "reprogramados": return cls.step === "programados" && cls.agreed;
    case "hoy_sin_guia": return cls.step === "programados" && cls.agenda === "hoy" && !cls.guide;
    case "manana_sin_guia": return cls.step === "programados" && cls.agenda === "manana" && !cls.guide;
    default: return cls.step === "programados" && cls.agenda === key;
  }
}

/**
 * Lo que dice `atencion` en la URL. Los enlaces de la pantalla anterior
 * siguen abriendo lo más cercano: «Programados para hoy» es Hoy, «para
 * mañana» Mañana, «para después» Después, «Nunca salieron» su parte dentro
 * de Sacar a reparto, «Confirmar primer despacho» Sacar a reparto, «Por decidir» No entregados, «Cerrados» Esperan
 * anulación y `programados` Reprogramados. «Ya salieron» no tiene par: abre
 * Todos, igual que un valor desconocido. Un día que ya pasó abre Hoy.
 */
export function boardFilter(value: string | null, today: string): LimaBoardKey {
  switch (value) {
    case null:
    case "":
    case "todos":
      return "todos";
    case "programados_hoy": return isDeliveryDay(today) ? "hoy" : "manana";
    case "programados_manana": return "manana";
    case "programados_despues": return "despues";
    case "nunca_salieron": return "nunca_salieron";
    case "primer_despacho": return "por_sacar";
    case "por_decidir": return "no_entregados";
    case "cerrados": return "esperan_anulacion";
    case "agendados": return "programados";
  }
  if (STEP_SET.has(value) || TASK_SET.has(value) || COURIER_SET.has(value) || value in LIMA_SUB_FILTERS) return value;
  // Un enlace de «Programados por paso» (`por_sacar:manana`, 16-11-2026, ya
  // reemplazado por el paso «Programados»): abre el día.
  if (value.includes(":")) return boardFilter(value.slice(value.indexOf(":") + 1), today);
  // Un día sin reparto no tiene «Hoy»: abre «Mañana».
  if (value === "hoy") return isDeliveryDay(today) ? "hoy" : "manana";
  if (value === "manana" || value === "despues") return value;
  // «Sin fecha» ya no es de Programados: lo que no tiene día está en Sacar a reparto.
  if (value === "sin_fecha") return "por_sacar";
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

/** El orden de la lista: por paso; en «Programados», hoy, mañana y después; con el courier, por su estado. */
function groupRank(cls: LimaRowClass): number {
  const base = STEP_RANK.get(cls.step)!;
  if (cls.step === "programados" || cls.step === "nuevos") return base + (AGENDA_RANK[cls.agenda ?? "sin_fecha"] ?? 2);
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
    // Programados, por día (lo vencido primero); Sacar a reparto, lo más antiguo primero (owner, 06-11-2026).
    if (step === "programados" || step === "nuevos") return (a.cls.agendaDay ?? "9999").localeCompare(b.cls.agendaDay ?? "9999") || a.created - b.created;
    if (step === "por_sacar") {
      if (a.cls.agendaDay || b.cls.agendaDay) return (a.cls.agendaDay ?? "9999").localeCompare(b.cls.agendaDay ?? "9999") || a.created - b.created;
      return a.created - b.created;
    }
    return a.since - b.since;
  }).map((r) => r.row);
}

// ---------------------------------------------------------------------------
// Lo que dice la fila
// ---------------------------------------------------------------------------

/** «Llamar después» cuya hora ya llegó (owner, 15-11-2026: «arriba en la lista y en rojo»). */
export function callDue(c: Pick<PendingCase, "list" | "nextCallAt"> | undefined, now: Date): boolean {
  if (c?.list !== "llamar_despues" || !c.nextCallAt) return false;
  const at = Date.parse(c.nextCallAt);
  return Number.isFinite(at) && at <= now.getTime();
}

/**
 * Los estados de Aliclik (`status · dispatchStatus · callStatus`), con las
 * palabras de su propio Excel (`lib/aliclik-import.ts`): «PENDING_DELIVERY ·
 * PREPARED · CONFIRMED» se lee «Por entregar · Validado · Confirmado».
 */
const ALICLIK_STATUS_TEXT: Record<string, string> = {
  PENDING_DELIVERY: "Por entregar",
  DELIVERED: "Entregado",
  CANCEL: "Cancelado",
  ANNULLED: "Anulado",
  REFUSED: "Rechazado",
  NOT_RESPOND: "No contesta",
  RESCHEDULED: "Reprogramado",
  TO_PREPARE: "Por preparar",
  PREPARED: "Validado",
  PICKED: "Recolectado",
  IN_TRANSIT: "En tránsito",
  REMAINING_IN_TRANSIT: "Remanente en tránsito",
  STORE_CENTRAL: "Almacén central",
  TO_RETURN: "Por devolver",
  RETURNED: "Devuelto",
  IN_AGENCY: "En agencia",
  LEFT_IN_WAREHOUSE: "Dejado en almacén",
  CONFIRMED: "Confirmado",
  IMPORTED: "Importado",
};

/** Los estados de GF Courier (§29.17), dichos con palabras; lo demás va como lo reportó el courier. */
const GF_STATUS_TEXT: Record<string, string> = {
  CREATED: "Guía creada",
  READY_FOR_PICKUP: "Lista para recojo",
  // Etapa dentro de GF (owner, 17-11-2026).
  "CREATED:TO_PREPARE": "En GF: por preparar",
  "CREATED:PREPARING": "En GF: en preparación",
  "READY_FOR_PICKUP:LABELED": "En GF: guía impresa, falta escanear",
  "READY_FOR_PICKUP:AWAITING_ASSIGNMENT": "En GF: por asignar a motorizado",
  "READY_FOR_PICKUP:AWAITING_OFFICE_CHECK": "En GF: asignado · falta cotejo de oficina",
  "READY_FOR_PICKUP:AWAITING_RIDER": "En GF: asignado · falta que el motorizado lo reciba",
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
  // GF recibió la anulación de una guía ya preparada y falta que la confirme (17-11-2026).
  CANCEL_REQUESTED: "En GF: anulada, GF desarma la caja",
};

export function courierStatusText(status: string | null | undefined): string | null {
  const raw = status?.trim();
  if (!raw) return null;
  const whole = GF_STATUS_TEXT[raw.toUpperCase()];
  if (whole) return whole;
  // Los estados compuestos de Aliclik, parte por parte; lo desconocido va como llegó.
  return raw.split(/\s*·\s*/).map((part) => ALICLIK_STATUS_TEXT[part.toUpperCase()] ?? part).join(" · ");
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

/**
 * La fecha de la ruta del courier, para la fila de lo que lleva un courier
 * (owner, 15-11-2026: «tienes que figurar la fecha de por qué está con el
 * courier, de la ruta del courier»):
 * - **Guía creada**: el día de recojo (Aliclik) o el que se le pidió a GF
 *   Courier; uno que pasó, «Vencido · vie 13/11». Sin día, «Guía creada».
 * - **En ruta** y **Retornando**: el día de la ruta (`limaRouteDay`): «Hoy» o
 *   «dom 15/11».
 */
export function courierRouteText(row: LimaPendingOrder, cls: Pick<LimaRowClass, "courier" | "agendaDay" | "routeDay">, today: string): { day: string; detail: string; overdue: boolean } | null {
  if (!cls.courier) return null;
  if (cls.courier === "guia_creada") {
    const pickup = row.courierPickup;
    const day = cls.agendaDay ?? pickup?.date;
    const detail = pickup ? (pickup.courier === "aliclik" ? "Recojo de Aliclik" : "Sale con GF Courier") : "Guía creada";
    if (!day) return { day: "Guía creada", detail: "Sin día del courier", overdue: false };
    return { day: agendaDayText(day, today), detail, overdue: day < today };
  }
  const day = cls.routeDay ?? limaRouteDay(row);
  const detail = cls.courier === "retornando" ? "Retornando" : "En ruta";
  if (!day) return { day: detail, detail: "Sin día de ruta", overdue: false };
  return { day: day === today ? "Hoy" : programDayLabel(day), detail, overdue: false };
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
    case "no_entregados": {
      if (cls.retry) return "Reintento por Aliclik: apruébalo en «Reintentos Aliclik», sin llamar.";
      if (cls.courier === "retornando") return `Lo está devolviendo ${courierName}: llama a la clienta y acuerda el nuevo día (Atender); sale otra vez cuando llegue al almacén.`;
      if (cls.noReport) {
        const rider = row.ops?.lastGfBox?.riderName;
        const who = courier ? courierDisplayName(courier) : GF_INTERNAL.has(row.courier ?? "") || row.ops?.lastGfBox ? (rider ? `el motorizado ${rider}` : "el motorizado") : courierName;
        const when = cls.routeDay ? `Salió a ruta el ${programDayLabel(cls.routeDay)}` : "Salió a ruta";
        return limaOwnRoute(row)
          ? `${when} y ${who} no reportó el resultado: se cuenta como no entregado. Llama a la clienta; si no lo recibió, regístralo con «No se entregó» (con la captura) y acuerda el nuevo día.`
          : `${when} y ${who} no reportó el resultado: se cuenta como no entregado. Pide el reporte a ${who}: el pedido cambia cuando el courier lo reporte.`;
      }
      return "Llamar a la clienta y acordar el día y el courier (Atender).";
    }
    case "novedad":
      return `Llamar a la clienta y acordar con ${courierName} la entrega o la devolución: la guía sigue viva.`;
    case "llamar_despues":
      if (!c?.nextCallAt) return "Llamar a la clienta otra vez.";
      // Ya llegó la hora (owner, 15-11-2026): lo dice primero; la fila lo pinta en rojo (`callDue`).
      return callDue(c, now) ? `Ya toca llamar (pidió ${reproCallTimeLabel(c.nextCallAt, now)}).` : `Llamar ${reproCallTimeLabel(c.nextCallAt, now)}.`;
    case "primer_despacho":
      return cls.stale
        ? "Confirmar con la clienta si la venta sigue; si no, anularla en la tienda."
        : `Sacarlo a reparto: Kapta sugiere el ${programDayLabel(limaSuggestedDay(today))}. Confírmalo (y los datos con la clienta si hace falta).`;
    case null:
      break;
  }
  if (cls.missedPickup) {
    const who = row.courierPickup ? courierDisplayName(row.courierPickup.courier) : courierName;
    return `${who} debía recogerlo el ${programDayLabel(row.courierPickup?.date ?? cls.agendaDay ?? today)} y no lo recogió: coordina el recojo o crea la guía con otro courier (Mesa de ruta).`;
  }
  if (cls.courier === "retornando") return "Recibir la devolución en Almacén cuando llegue.";
  if (cls.courier === "en_ruta") return `Solo seguimiento: lo tiene ${courierName}.`;
  if (cls.courier === "guia_creada") {
    // El día de recojo es el de la clase: si su día pasó sin recogerlo, el próximo día de reparto.
    const pickup = row.courierPickup && cls.agendaDay && cls.agendaDay >= today ? cls.agendaDay : null;
    return row.courierPickup && pickup
      ? `Lo recoge ${courierDisplayName(row.courierPickup.courier)} ${pickup === today ? "hoy" : `el ${programDayLabel(pickup)}`}.`
      : `Lo prepara y lo recoge ${courierName}.`;
  }
  if (!cls.guide && cls.agenda === "hoy") {
    if (cls.agendaDay && cls.agendaDay < today) return `Debía salir el ${programDayLabel(cls.agendaDay)} y no tiene guía ni rótulo: créala hoy desde la Mesa de ruta o reagéndalo.`;
    return hoySinGuiaAlert(now)
      ? "Sale hoy y no tiene guía ni rótulo: créala desde la Mesa de ruta para que salga."
      : "Sale hoy y todavía no tiene guía ni rótulo: si a las 10:30 no la tiene, créala desde la Mesa de ruta.";
  }
  if (!cls.guide && cls.agenda === "manana") {
    if (cls.autoGuideBy === "fenix") return "Sale mañana con Swayp: Kapta crea su guía hoy, hasta las 21:00.";
    if (cls.autoGuideBy === "aliclik") return "Sale mañana con Aliclik: Kapta crea su guía esta noche o mañana temprano.";
    return cls.autoGuide ? "Sale mañana: la guía GF automática la crea en minutos; si no puede, avisa por Telegram." : "Sale mañana y no tiene guía ni rótulo: genérala hoy.";
  }
  if (cls.agendaDay && cls.agendaDay < today) return `Debía salir el ${programDayLabel(cls.agendaDay)}: revisa por qué no salió y reagéndalo.`;
  if (cls.agendaDay === today) return "Sale hoy.";
  if (cls.agendaDay) return `Sale el ${programDayLabel(cls.agendaDay)}. Sin gestión salvo que la clienta cambie algo.`;
  return `Sin día: Kapta sugiere el ${programDayLabel(limaSuggestedDay(today))} para que salga.`;
}

// ---------------------------------------------------------------------------
// «Agendar» (owner, 15-11-2026): con qué camino se pone el día
// ---------------------------------------------------------------------------

export type AgendarPath =
  /** Un acuerdo con la clienta que ya existe: se cambia su día, con su courier (`moveReproAgreement`). */
  | { kind: "acuerdo"; current: string; courierName: string; maxDays: number }
  /** Sin guía ni acuerdo, en Preparación · Por generar rótulo: «Programar envío» (`scheduleOrderDispatch`, §6.2), con courier o sin él. */
  | { kind: "envio"; current: string | null; maxDays: number }
  /**
   * Un no entregado sin acuerdo (16-11-2026): se programa con un courier elegido y
   * queda un acuerdo sin llamada (`programReproWithoutCall`).
   */
  | { kind: "acuerdo_nuevo"; current: null; maxDays: number }
  | { kind: null; why: string };

/**
 * Con qué acción existente se agenda el pedido. La misma decisión la vuelve a
 * tomar el servidor (`agendarReproLima`) con los hechos de ese momento.
 * - Con un acuerdo (aunque esté vencido), se cambia el día del acuerdo: el
 *   courier y lo que cambió ya se acordaron con la clienta.
 * - Sin acuerdo y en Por generar rótulo, «Programar envío»: el día en que sale
 *   su primera guía (con GF Courier por API, la guía automática de ese día).
 * - Un no entregado sin acuerdo se programa eligiendo el courier: queda un
 *   acuerdo sin llamada (owner, 16-11-2026). El reintento por Aliclik no: se
 *   aprueba en su filtro.
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
  if (isPorReprogramarLima(row) && c?.retryChain) return { kind: null, why: "Tiene un reintento por Aliclik: apruébalo en «Reintentos Aliclik»." };
  if (isPorReprogramarLima(row)) return { kind: "acuerdo_nuevo", current: null, maxDays: RESCHEDULE_MAX_DAYS };
  if (liveGuideCourier(row) || row.stage === "en_curso") return { kind: null, why: "Ya tiene guía: el día lo lleva el courier." };
  return { kind: null, why: "Ya tiene rótulo: acuerda el día con la clienta en «Atender»." };
}

// ---------------------------------------------------------------------------
// El courier al programar (owner, 16-11-2026: «con un botón ya lo dejamos
// programados exactamente para un courier»)
// ---------------------------------------------------------------------------

/** El orden en que se ofrecen: Grupo GF o GF Courier según la tienda, luego Aliclik y Swayp. */
const PROGRAM_COURIER_ORDER: readonly DispatchCourier[] = ["propio", "gf_courier", "aliclik", "fenix"];

/** Los couriers que se ofrecen para un pedido: GF Courier solo con su API, Grupo GF nunca con ella (`reproCourierStoreProblem`). Pura. */
export function programCourierChoices(gfCourierApi: boolean): DispatchCourier[] {
  return PROGRAM_COURIER_ORDER.filter((c) => !reproCourierStoreProblem(c, gfCourierApi));
}

/** Los del lote: los que valen para al menos uno de los elegidos, en el mismo orden. Pura. */
export function batchCourierChoices(gfFlags: readonly boolean[]): DispatchCourier[] {
  return PROGRAM_COURIER_ORDER.filter((c) => gfFlags.some((gf) => !reproCourierStoreProblem(c, gf)));
}

/** Cuántos de los elegidos no pueden salir con ese courier por su tienda. Pura. */
export function batchCourierRejects(courier: DispatchCourier | null, gfFlags: readonly boolean[]): number {
  if (!courier) return 0;
  return gfFlags.filter((gf) => Boolean(reproCourierStoreProblem(courier, gf))).length;
}

/** Qué pasa al programar con cada courier: lo que se dice bajo los chips. */
export const PROGRAM_COURIER_HINT: Record<DispatchCourier, string> = {
  propio: "Grupo GF: sale en el reparto propio de ese día.",
  gf_courier: "GF Courier: la guía queda creada para ese día.",
  aliclik: "Aliclik: queda programado; ese día se crea su guía con «Guía Aliclik».",
  fenix: "Swayp: queda programado; su guía se crea la víspera desde la Mesa de ruta. Elige desde mañana.",
};

/**
 * Con «Guía Aliclik y Swayp del día programado» en Activo (0349), Kapta crea
 * la guía sola: lo dice así. Sin ella, `PROGRAM_COURIER_HINT`. Pura.
 */
export function programCourierHint(courier: DispatchCourier, autoActive: boolean): string {
  if (autoActive && courier === "aliclik") return "Aliclik: Kapta crea su guía la noche anterior o la mañana de ese día (AUTOECOM si se puede). Si no puede, avisa por Telegram.";
  if (autoActive && courier === "fenix") return "Swayp: Kapta crea su guía la víspera, hasta las 21:00, con ese día de despacho. Elige desde mañana.";
  return PROGRAM_COURIER_HINT[courier];
}

/**
 * Lo que la guía de ese courier necesita, dicho al programar (0349): Swayp arma
 * su ruta el día anterior (desde mañana, de lunes a sábado, como
 * `agreementDateProblem`) y Aliclik no crea la guía sin la ubicación. Null si
 * se puede. Pura.
 */
export function programCourierProblem(courier: DispatchCourier, day: string, today: string, hasCoordinate: boolean): string | null {
  if (courier === "fenix") {
    if (day <= today) return "Swayp arma su ruta el día anterior: elige desde mañana.";
    if (!isSwaypDispatchDay(day)) return SWAYP_SUNDAY_ERROR;
  }
  if (courier === "aliclik" && !hasCoordinate) {
    return "Aliclik necesita la ubicación del pedido: ponla en la ficha (Aliclik) y vuelve a programarlo.";
  }
  return null;
}

/** El courier de un programa, por su nombre, o null. Pura. */
export function programCourierName(value: string | null | undefined): string | null {
  return isDispatchCourier(value) ? DISPATCH_COURIER_LABEL[value] : null;
}

/** La línea de «Fecha agendada» bajo el día: de dónde sale y, si se sabe, con qué courier. Pura. */
export function agendaOriginLine(origin: LimaAgendaOrigin, row: Pick<LimaPendingOrder, "scheduledCourier">, agreementCourierName?: string | null): string {
  const courier = origin === "acuerdo" ? agreementCourierName ?? null : origin === "envio" ? programCourierName(row.scheduledCourier) : null;
  return courier ? `${AGENDA_ORIGIN_LABEL[origin]} · ${courier}` : AGENDA_ORIGIN_LABEL[origin];
}

/** «Kapta sugiere…»: de qué pedidos habla, en Sacar a reparto o en No entregados. Pura. */
export function proposalsNoun(n: number, noEntregados: boolean): string {
  if (noEntregados) return n === 1 ? "no entregado por acordar (elige el courier abajo)" : "no entregados por acordar (elige el courier abajo)";
  return n === 1 ? "pedido sin fecha que se puede programar" : "pedidos sin fecha que se pueden programar";
}

/**
 * Cómo se dice poner el día (owner, 16-11-2026: «debería ser reprogramar o
 * programar en vez de mover al»): «Programar» lo que no tiene día y
 * «Reprogramar» lo que ya lo tiene, como el paso «Programados». Puras.
 */
export function programarVerb(hasDay: boolean): "Programar" | "Reprogramar" {
  return hasDay ? "Reprogramar" : "Programar";
}

/** El botón de confirmar de una fila: «Programar para el lun 16/11» o «Reprogramar al lun 16/11». */
export function programarConfirmLabel(hasDay: boolean, day: string): string {
  return hasDay ? `Reprogramar al ${programDayLabel(day)}` : `Programar para el ${programDayLabel(day)}`;
}

/** El botón del lote: según cuántos de los elegidos ya tienen día. */
export function programarBatchLabel(withDay: number, withoutDay: number, day: string | null): string {
  const verb = withoutDay === 0 ? "Reprogramar" : withDay === 0 ? "Programar" : "Programar y reprogramar";
  if (!day) return `${verb}…`;
  return withoutDay === 0 ? `${verb} al ${programDayLabel(day)}` : `${verb} para el ${programDayLabel(day)}`;
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
