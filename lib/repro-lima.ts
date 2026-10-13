// «Repro Lima» (fase 1, entrega 1a; decisiones del owner del 12-10-2026, D1-D13).
//
// La tienda llama a cada cliente de Lima con entrega fallida, confirma fecha y
// courier, y Kapta decide qué hacer con la caja y cuándo se programa con Grupo
// GF. Aquí viven las reglas PURAS: sin IO, para el servidor y la pantalla.
//
// Lo que NO es: un estado del Master. «Por decidir», «Llamar después»,
// «Programados» y «Cerrados» son etiquetas de pantalla que se derivan del caso
// (`lima_repro_cases`), de su programa en Grupo GF y del `order_master` (D2). El
// pedido sigue en «En curso · Por reprogramar Lima» hasta que sale o se cierra.
//
// El acuerdo vive en el caso y nunca se reescribe (D5): si Grupo GF mueve o
// quita la fecha, la fila lo enseña como deriva.
//
// La acción de caja la calcula lib/repro-box-action.ts; este módulo no la importa
// (aquel importa de este), así no hay ciclos.

import { limaClock, nextDay, sameDayCutoffLabel, sameDayCutoffMinute, scheduledDay } from "@/lib/grupo-gf-courier";
import { rescheduleDateProblem, RESCHEDULE_MAX_DAYS } from "@/lib/gf-dispatch-program";
import { programDayLabel } from "@/lib/dispatch-day";
import { guideDoorRejection, guideFailedAfterDispatch, type RecoveryGuideLike } from "@/lib/reproprovincia";
import { ownRetryDecision, type OwnRetryBlock } from "@/lib/gf-retry";
import { motivoDelCourier } from "@/lib/aliclik-status";
import { NON_DELIVERY_REASONS } from "@/lib/routes";
import { nombreDeCourier, sameCourier } from "@/lib/shipment-output";
import { firstSwaypDispatchDay, isSwaypDispatchDay, SWAYP_SUNDAY_ERROR } from "@/lib/swayp-dispatch-days";

// ---------------------------------------------------------------------------
// Vocabulario
// ---------------------------------------------------------------------------

/** Los cuatro resultados de una llamada (MOM §11.4), con sus kinds propios. */
export type ReproOutcome = "confirma" | "llamar_despues" | "no_contesta" | "no_quiere";
export const REPRO_OUTCOMES: readonly ReproOutcome[] = ["confirma", "llamar_despues", "no_contesta", "no_quiere"];

/** Lo que dicen las cuatro fichas de «Resultado» en la hoja. */
export const REPRO_OUTCOME_LABEL: Record<ReproOutcome, string> = {
  confirma: "Confirma fecha",
  llamar_despues: "Llamar después",
  no_contesta: "No contesta",
  no_quiere: "Ya no lo quiere",
};

export function isReproOutcome(value: unknown): value is ReproOutcome {
  return typeof value === "string" && (REPRO_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Por dónde se habló. `sin_contacto` es «Desarmar y cerrar sin llamada»: la
 * misma RPC, sin cliente al otro lado (E2).
 */
export type ReproChannel = "llamada" | "whatsapp" | "sin_contacto";
export const REPRO_CHANNEL_LABEL: Record<ReproChannel, string> = {
  llamada: "llamada",
  whatsapp: "WhatsApp",
  sin_contacto: "sin llamada",
};

export function isReproChannel(value: unknown): value is ReproChannel {
  return value === "llamada" || value === "whatsapp" || value === "sin_contacto";
}

/**
 * El courier del acuerdo, con el token que se guarda (catálogo de la Mesa de
 * despacho): Grupo GF es `propio` y Swayp es `fenix`. Urpi queda en el CHECK
 * para fase 2, pero en 1a no se ofrece (E16).
 */
export type ReproCourier = "propio" | "tanders" | "fenix" | "urpi" | "axel";
export const REPRO_COURIERS: readonly ReproCourier[] = ["propio", "tanders", "fenix", "urpi", "axel"];
/** Los que se ofrecen en la hoja, en este orden (Grupo GF por defecto). Sin Urpi en 1a (E16). */
export const REPRO_COURIER_CHOICES: readonly ReproCourier[] = ["propio", "tanders", "fenix", "axel"];

export const REPRO_COURIER_LABEL: Record<ReproCourier, string> = {
  propio: "Grupo GF",
  tanders: "Tanders",
  fenix: "Swayp",
  urpi: "Urpi",
  axel: "Axel",
};

export function isReproCourier(value: unknown): value is ReproCourier {
  return typeof value === "string" && (REPRO_COURIERS as readonly string[]).includes(value);
}

/** Urpi solo lleva primeros despachos (§9.1): un reprogramado no pasa a Urpi en 1a (E16). */
export const URPI_DISABLED_REASON = "Urpi solo lleva primeros despachos (§9.1); un reprogramado no pasa a Urpi en esta fase.";

/** Por qué un courier no se puede elegir en 1a, sin mirar el pedido. */
export function reproCourierDisabledReason(courier: ReproCourier): string | null {
  return courier === "urpi" ? URPI_DISABLED_REASON : null;
}

/** El nombre corto de un courier guardado: el del acuerdo o el de una salida. */
export function reproCourierName(courier: string | null | undefined): string {
  const known = REPRO_COURIERS.find((c) => sameCourier(c, courier));
  if (known) return REPRO_COURIER_LABEL[known];
  return courier?.trim() ? nombreDeCourier(courier) : "otro courier";
}

/** Las seis acciones de la tabla «Qué hacer con la caja» (§9.3, decisión 8). */
export type BoxAction =
  | "mantener"
  | "reimprimir_misma_salida"
  | "salida_nueva_rearmar"
  | "desarmar_rearmar"
  | "caja_nueva_stock"
  | "desarmar_cerrar";
export const BOX_ACTIONS: readonly BoxAction[] = [
  "mantener",
  "reimprimir_misma_salida",
  "salida_nueva_rearmar",
  "desarmar_rearmar",
  "caja_nueva_stock",
  "desarmar_cerrar",
];

/** Las de un acuerdo: «Desarmar y cerrar» cierra el caso, nunca es un acuerdo. */
export type AgreementBoxAction = Exclude<BoxAction, "desarmar_cerrar">;

export function isBoxAction(value: unknown): value is BoxAction {
  return typeof value === "string" && (BOX_ACTIONS as readonly string[]).includes(value);
}

export function isAgreementBoxAction(value: unknown): value is AgreementBoxAction {
  return isBoxAction(value) && value !== "desarmar_cerrar";
}

/** Cómo se lee cada acción. Lo re-exporta lib/repro-box-action.ts. */
export const BOX_ACTION_LABEL: Record<BoxAction, string> = {
  mantener: "Mantener",
  reimprimir_misma_salida: "Reimprimir el rótulo de la misma salida",
  salida_nueva_rearmar: "Salida nueva y rearmado",
  desarmar_rearmar: "Desarmar y rearmar",
  caja_nueva_stock: "Caja nueva desde stock",
  desarmar_cerrar: "Desarmar y cerrar",
};

/**
 * Las que se preparan «la noche anterior» (columna «Lista para» de la tabla
 * aprobada, E14): no salen el mismo día en que se deciden.
 */
export const NIGHT_BEFORE_BOX_ACTIONS: ReadonlySet<BoxAction> = new Set<BoxAction>([
  "reimprimir_misma_salida",
  "salida_nueva_rearmar",
  "desarmar_rearmar",
]);

/** Lo que el cliente cambió, declarado por quien decide (D8). */
export interface ReproChanges {
  /** Dirección o referencia. */
  direccion: boolean;
  telefono: boolean;
  monto: boolean;
  /** Producto, talla, color o cantidad. */
  producto: boolean;
  /** La caja está abierta o dañada. */
  caja_danada: boolean;
  /** El cliente lo quiere ya: no se espera la caja que vuelve. */
  no_esperar_caja: boolean;
}

export const REPRO_CHANGE_KEYS: readonly (keyof ReproChanges)[] = [
  "direccion",
  "telefono",
  "monto",
  "producto",
  "caja_danada",
  "no_esperar_caja",
];

export const REPRO_CHANGE_LABEL: Record<keyof ReproChanges, string> = {
  direccion: "dirección",
  telefono: "teléfono",
  monto: "monto",
  producto: "producto",
  caja_danada: "caja dañada",
  no_esperar_caja: "no esperar la caja",
};

export const NO_REPRO_CHANGES: ReproChanges = {
  direccion: false,
  telefono: false,
  monto: false,
  producto: false,
  caja_danada: false,
  no_esperar_caja: false,
};

/** Los cambios de un jsonb o de un formulario: solo las seis claves, en booleano. */
export function normalizeReproChanges(raw: unknown): ReproChanges {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...NO_REPRO_CHANGES };
  for (const key of REPRO_CHANGE_KEYS) out[key] = source[key] === true;
  return out;
}

/** «dirección, monto» o null si no cambió nada. */
export function reproChangesText(changes: Partial<ReproChanges> | null | undefined): string | null {
  const list = REPRO_CHANGE_KEYS.filter((key) => changes?.[key]).map((key) => REPRO_CHANGE_LABEL[key]);
  return list.length ? list.join(", ") : null;
}

/** Las cuatro listas de la pantalla. Etiquetas, no subetapas (D2). */
export type ReproList = "por_decidir" | "llamar_despues" | "programados" | "cerrados";
export const REPRO_LISTS: readonly ReproList[] = ["por_decidir", "llamar_despues", "programados", "cerrados"];
export const REPRO_LIST_LABEL: Record<ReproList, string> = {
  por_decidir: "Por decidir",
  llamar_despues: "Llamar después",
  programados: "Programados",
  cerrados: "Cerrados",
};

/**
 * Los kinds del historial (`order_events`). Nuevos a propósito: nunca `call`,
 * `confirmation_contact` ni `contact_attempt`, que gastan el cupo de
 * confirmación (lib/order-confirmation.ts, D3).
 */
export const REPRO_EVENT_KINDS = {
  call: "lima_repro_call",
  agreed: "lima_repro_agreed",
  closed: "lima_repro_closed",
} as const;
export type ReproEventKind = (typeof REPRO_EVENT_KINDS)[keyof typeof REPRO_EVENT_KINDS];

/** El kind del evento de una llamada: el mismo que escribe `lima_repro_record`. */
export function reproEventKind(outcome: ReproOutcome): ReproEventKind {
  if (outcome === "confirma") return REPRO_EVENT_KINDS.agreed;
  if (outcome === "no_quiere") return REPRO_EVENT_KINDS.closed;
  return REPRO_EVENT_KINDS.call;
}

/** Por qué se cierra un caso (CHECK de 0249). */
export type ReproCloseReason = "desarmar_cerrar" | "fuera_de_etapa" | "nuevo_intento";

/** El candado del caso: el mismo TTL y latido que Envíos (D10). */
export const REPRO_CLAIM_TTL_MINUTES = 10;
export const REPRO_CLAIM_HEARTBEAT_MS = 4 * 60_000;

// ---------------------------------------------------------------------------
// Fechas y horas de Lima
// ---------------------------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Día de Lima (YYYY-MM-DD) de un ISO, o null. */
function limaDayOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  // Un día suelto ya es de Lima: `Date.parse` lo leería como medianoche UTC.
  if (DAY_RE.test(iso)) return iso;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return DAY_RE.test(iso.slice(0, 10)) ? iso.slice(0, 10) : null;
  return limaClock(new Date(t)).day;
}

function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

function daysFromTo(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T12:00:00Z`) - Date.parse(`${fromDay}T12:00:00Z`)) / DAY_MS);
}

function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/**
 * Un instante de Lima como ISO con su desfase (Lima no tiene horario de
 * verano: siempre -05:00). Es la ÚNICA forma de convertir un `datetime-local`
 * o un chip de hora: `new Date(valor)` lo leería en la zona del navegador o del
 * servidor (E19).
 */
export function limaDateTimeIso(date: string, time: string): string {
  return `${date}T${time.slice(0, 5)}:00-05:00`;
}

/** El valor de un `datetime-local` («2026-10-13T15:00») como instante de Lima, o null. */
export function limaDateTimeFromInput(value: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec((value ?? "").trim());
  return m ? limaDateTimeIso(m[1]!, m[2]!) : null;
}

/** Un instante como valor de `datetime-local` en hora de Lima («2026-10-13T15:00»). */
export function limaDateTimeInputValue(iso: string | null | undefined): string {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const clock = limaClock(new Date(t));
  return `${clock.day}T${hhmm(clock.minute)}`;
}

/** «hoy 15:00», «mañana 08:30» o «lun 13/10 15:00». */
export function reproCallTimeLabel(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const at = limaClock(new Date(t));
  const today = limaClock(now).day;
  const time = hhmm(at.minute);
  if (at.day === today) return `hoy ${time}`;
  if (at.day === nextDay(today)) return `mañana ${time}`;
  return `${programDayLabel(at.day)} ${time}`;
}

/** Las vueltas de llamadas del plan: 08:30-12:00 y 15:00-18:00. */
export const CALL_ROUND_AFTERNOON = "15:00";
export const CALL_ROUND_MORNING = "08:30";
/** Margen mínimo para proponer la próxima vuelta (E19): 14:56 ya no propone las 15:00. */
export const NEXT_ROUND_MARGIN_MINUTES = 5;

/**
 * La próxima vuelta de llamadas para «No contesta»: hoy a las 15:00 si faltan
 * al menos cinco minutos; si no, mañana a las 08:30.
 */
export function nextRoundAt(now: Date = new Date()): string {
  const today = limaClock(now).day;
  const afternoon = limaDateTimeIso(today, CALL_ROUND_AFTERNOON);
  if (Date.parse(afternoon) - now.getTime() >= NEXT_ROUND_MARGIN_MINUTES * 60_000) return afternoon;
  return limaDateTimeIso(nextDay(today), CALL_ROUND_MORNING);
}

/** Hasta cuántos días adelante se agenda una llamada (el mismo tope que la fecha). */
export const NEXT_CALL_MAX_DAYS = RESCHEDULE_MAX_DAYS;

/**
 * ¿Sirve esta hora para la próxima llamada? Null si sí. Exige el desfase en el
 * ISO: un «2026-10-13T15:00» suelto se leería en la zona del servidor.
 */
export function nextCallProblem(iso: string | null | undefined, now: Date = new Date()): string | null {
  const value = (iso ?? "").trim();
  const t = Date.parse(value);
  if (!value || !/(Z|[+-]\d{2}:?\d{2})$/.test(value) || !Number.isFinite(t)) return "Elige el día y la hora de la llamada.";
  if (t <= now.getTime()) return "Elige una hora que todavía no pasó.";
  if (t > now.getTime() + NEXT_CALL_MAX_DAYS * DAY_MS) return `La próxima llamada no puede pasar de ${NEXT_CALL_MAX_DAYS} días.`;
  return null;
}

// ---------------------------------------------------------------------------
// Fecha del acuerdo
// ---------------------------------------------------------------------------

/**
 * El primer día que se puede acordar:
 * - Swayp arma su ruta el día anterior y no despacha domingos: desde mañana,
 *   saltando el domingo (`firstSwaypDispatchDay`, E15).
 * - Una acción que se prepara la noche anterior (reimprimir, salida nueva,
 *   desarmar y rearmar): desde mañana (E14).
 * - Grupo GF: hoy hasta el corte (`same_day_cutoff`), después mañana.
 * - Tanders y Axel: hoy.
 */
export function firstAllowedDay(
  courier: ReproCourier,
  cutoff: string | null | undefined,
  now: Date = new Date(),
  boxAction?: BoxAction | null,
): string {
  const today = limaClock(now).day;
  if (sameCourier(courier, "fenix")) return firstSwaypDispatchDay(today);
  if (boxAction && NIGHT_BEFORE_BOX_ACTIONS.has(boxAction)) return nextDay(today);
  if (courier === "propio") return scheduledDay(cutoff, now);
  return today;
}

/**
 * ¿Sirve este día para el acuerdo? Null si sí. La misma regla en la hoja, en la
 * acción y (el rango) en la RPC (§11.6):
 * 1. hoy o después, hasta 60 días (`rescheduleDateProblem`);
 * 2. Swayp: nunca hoy y nunca domingo;
 * 3. una acción de la noche anterior: nunca hoy (E14);
 * 4. Grupo GF hoy después del corte: lo aprueba Despacho GF desde «Programar» (D6).
 */
export function agreementDateProblem(input: {
  day: string;
  today: string;
  /** Minuto del día en Lima (`limaClock().minute`). */
  nowMinute: number;
  cutoff: string | null | undefined;
  courier: ReproCourier;
  boxAction?: BoxAction | null;
}): string | null {
  const base = rescheduleDateProblem(input.day, input.today);
  if (base) return base;
  const today = input.day === input.today;
  if (sameCourier(input.courier, "fenix")) {
    if (today) return "Swayp arma su ruta el día anterior: elige desde mañana.";
    if (!isSwaypDispatchDay(input.day)) return SWAYP_SUNDAY_ERROR;
  }
  if (today && input.boxAction && NIGHT_BEFORE_BOX_ACTIONS.has(input.boxAction)) {
    return `«${BOX_ACTION_LABEL[input.boxAction]}» se prepara la noche anterior: elige desde mañana.`;
  }
  if (input.courier === "propio" && today && input.nowMinute > sameDayCutoffMinute(input.cutoff)) {
    return `Pasó el corte de las ${sameDayCutoffLabel(input.cutoff)}: elige mañana. Para hoy, lo aprueba Despacho GF desde «Programar».`;
  }
  return null;
}

/** La chapa del corte en la cabecera de la pantalla. */
export function cutoffNotice(cutoff: string | null | undefined, now: Date = new Date()): { passed: boolean; text: string } {
  const passed = limaClock(now).minute > sameDayCutoffMinute(cutoff);
  return passed
    ? { passed, text: "Pasó el corte: lo confirmado sale mañana" }
    : { passed, text: `Lo que confirmes hasta las ${sameDayCutoffLabel(cutoff)} sale hoy` };
}

// ---------------------------------------------------------------------------
// El episodio: qué fallo atiende el caso
// ---------------------------------------------------------------------------

type EpisodeOutput = RecoveryGuideLike & { id: string; output_number?: number | null };
export type EpisodeStop = {
  id: string;
  reported_at: string | null;
  status?: string | null;
  /** Día de su ruta (YYYY-MM-DD). */
  routeDate?: string | null;
};

function cmpCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * El orden de las paradas «No entregado», la más reciente primero: por el día
 * de su ruta, después por `reported_at` y por id. El día de la ruta va antes
 * porque `reported_at` se reescribe en cada corrección del reporte
 * (Liquidaciones 2, «Completar reportes anteriores»): corregir la parada de un
 * día anterior no la vuelve el fallo más reciente ni abre otro episodio (§9.5).
 */
export function compareEpisodeStops(a: EpisodeStop, b: EpisodeStop): number {
  return cmpCode(b.routeDate ?? "", a.routeDate ?? "") ||
    cmpCode(b.reported_at ?? "", a.reported_at ?? "") ||
    cmpCode(b.id, a.id);
}

/**
 * El fallo que define el episodio: la parada «No entregado» más reciente
 * (`compareEpisodeStops`) y la salida de otro courier que no entregó (la de
 * consecutivo más alto que pasa `guideFailedAfterDispatch`). Un reintento del
 * mismo día reusa su parada (`route_id, order_id` único), así que el episodio
 * no cambia; un día nuevo o un courier nuevo que falla dan otro.
 *
 * `at` es el momento del fallo (E1): el `reported_at` de la parada o el
 * retorno de la salida, el más reciente; null si no hay ninguno (la RPC usa
 * entonces la apertura del caso).
 */
export function reproEpisode(input: {
  orderId: string;
  outputs: readonly EpisodeOutput[];
  /** Las paradas «No entregado» del pedido (las de otro estado se ignoran). */
  failedStops: readonly EpisodeStop[];
}): { key: string; at: string | null } {
  let stop: EpisodeStop | null = null;
  for (const s of input.failedStops) {
    if (s.status != null && s.status !== "no_entregado") continue;
    if (!stop || compareEpisodeStops(s, stop) < 0) stop = s;
  }
  let output: EpisodeOutput | null = null;
  for (const o of input.outputs) {
    if (!guideFailedAfterDispatch(o)) continue;
    if (!output || (o.output_number ?? 0) >= (output.output_number ?? 0)) output = o;
  }
  if (!stop && !output) return { key: `order:${input.orderId}`, at: null };
  const stamps = [stop?.reported_at, output ? output.returned_at ?? output.updated_at ?? output.dispatched_at : null]
    .filter((v): v is string => Boolean(v) && Number.isFinite(Date.parse(v!)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    key: `s:${stop?.id ?? "-"}|o:${output?.id ?? "-"}`,
    at: stamps.length ? new Date(Date.parse(stamps[stamps.length - 1]!)).toISOString() : null,
  };
}

/** La llave del episodio (`lima_repro_cases.episode_key`). */
export function reproEpisodeKey(input: Parameters<typeof reproEpisode>[0]): string {
  return reproEpisode(input).key;
}

// ---------------------------------------------------------------------------
// Dónde está la caja
// ---------------------------------------------------------------------------

/**
 * Dónde está la caja, para decidir y para programar:
 * - `con_motorizado`: la salida propia sigue en la caja de un motorizado de
 *   Grupo GF. `sinReporte`: lo último de esa caja no es «No entregado»
 *   (`caja_sin_reporte`, E11): hay que revisar la parada.
 * - `en_oficina`: la propia se puede tomar tal cual (`ownRetryDecision` dice
 *   «tomar», E11), o la de otro courier ya volvió. `courier`: de quién es la
 *   caja (`propio` o el courier que la devolvió).
 * - `volviendo_courier`: la de otro courier todavía vuelve.
 * - `desconocida`: no consta. `own`: es la salida propia (fuera de la oficina
 *   o en otra solicitud: `block`).
 */
export type BoxLocation =
  | { kind: "con_motorizado"; riderName: string; since: string | null; sinReporte?: boolean }
  | { kind: "en_oficina"; since: string | null; courier?: string | null }
  | { kind: "volviendo_courier"; courier: string }
  | { kind: "desconocida"; own?: boolean; block?: Exclude<OwnRetryBlock, "caja_sin_reporte"> };

export function boxLocation(input: {
  /** La salida propia que se reusa (`ownRetryOutput`), o null. */
  ownLive: { custody_state?: string | null; custody_transferred_at?: string | null } | null;
  /** Su caja activa (`loadActiveBoxes.get(ownLive.id)`), o null. */
  box: { riderName: string; routeDate: string | null; undeliveredReason?: string | null } | null;
  /** La salida propia ya estuvo en otra solicitud de Grupo GF. */
  inOtherRequest?: boolean;
  /** La última salida de otro courier que no entregó (`lastFailedOutput`). */
  lastFailed: { courier: string; returned: boolean; returnedAt?: string | null } | null;
  /** Cuándo se recibió en oficina (`returned_to_office` / `return_received`). */
  receivedAt: string | null;
}): BoxLocation {
  if (input.box) {
    return {
      kind: "con_motorizado",
      riderName: input.box.riderName,
      since: input.box.routeDate || null,
      ...(input.box.undeliveredReason ? {} : { sinReporte: true }),
    };
  }
  if (input.ownLive) {
    const decision = ownRetryDecision(input.ownLive, null, Boolean(input.inOtherRequest));
    if (decision.action === "tomar") return { kind: "en_oficina", since: input.receivedAt, courier: "propio" };
    const block = decision.action === "bloquear" && decision.reason !== "caja_sin_reporte" ? decision.reason : undefined;
    return { kind: "desconocida", own: true, ...(block ? { block } : {}) };
  }
  if (input.lastFailed && !sameCourier(input.lastFailed.courier, "propio")) {
    return input.lastFailed.returned
      ? { kind: "en_oficina", since: input.lastFailed.returnedAt ?? input.receivedAt, courier: input.lastFailed.courier }
      : { kind: "volviendo_courier", courier: input.lastFailed.courier };
  }
  return { kind: "desconocida" };
}

/** ¿La caja es la salida propia de Grupo GF? (con el motorizado, en oficina o perdida). */
export function isOwnBox(box: BoxLocation): boolean {
  if (box.kind === "con_motorizado") return true;
  if (box.kind === "en_oficina") return sameCourier(box.courier, "propio");
  if (box.kind === "desconocida") return Boolean(box.own);
  return false;
}

/**
 * ¿Tiene sentido «No esperar la caja»? Solo con la caja en manos del
 * motorizado o volviendo con su courier (§9.3, fila 2). Una caja que no consta
 * solo cuando el caso reabre un «Desarmar y cerrar» (`reopened`): si Almacén
 * ya la desarmó, se arma otra (E29). Sin reabrir, «No consta» se busca primero
 * («Ya la encontré: programar»).
 */
export function noEsperarCajaAplica(box: BoxLocation, reopened = false): boolean {
  if (box.kind === "con_motorizado" || box.kind === "volviendo_courier") return true;
  return box.kind === "desconocida" && reopened;
}

/** La chapa de la caja en la fila. */
export function boxLocationLabel(box: BoxLocation): string {
  switch (box.kind) {
    case "con_motorizado":
      return `Con ${box.riderName}${box.since ? ` desde ${programDayLabel(box.since)}` : ""}${box.sinReporte ? " · sin reporte de esa caja" : ""}`;
    case "en_oficina": {
      const since = limaDayOf(box.since);
      return `En oficina${since ? ` desde ${programDayLabel(since)}` : ""}`;
    }
    case "volviendo_courier":
      return `Vuelve con ${reproCourierName(box.courier)}`;
    case "desconocida":
      return "No consta dónde está la caja";
  }
}

// ---------------------------------------------------------------------------
// Programa de Grupo GF y materialización
// ---------------------------------------------------------------------------

/** El motivo que escribe el reporte de la parada desde el 10-10-2026 (#908). */
export const RIDER_PROGRAM_REASON_PREFIX = "Reprogramado por el cliente (reporte de la parada";
/** El motivo de todo programa que escribe Repro Lima. */
export const REPRO_PROGRAM_REASON_PREFIX = "Repro Lima:";

export type ProgramOrigin = "motorizado" | "repro_lima" | "grupo_gf";

/** Quién escribió el programa vigente, por su motivo. */
export function programOrigin(reason: string | null | undefined): ProgramOrigin {
  const text = (reason ?? "").trim();
  if (text.startsWith(RIDER_PROGRAM_REASON_PREFIX)) return "motorizado";
  if (text.startsWith(REPRO_PROGRAM_REASON_PREFIX)) return "repro_lima";
  return "grupo_gf";
}

/** «Repro Lima: confirmado con el cliente (Diana, 12/10)». Cabe en 3-200 caracteres (0199). */
export function reproProgramReason(agentName: string | null | undefined, decidedOn: string): string {
  const who = (agentName ?? "").trim().slice(0, 60);
  const day = DAY_RE.test(decidedOn) ? `${decidedOn.slice(8, 10)}/${decidedOn.slice(5, 7)}` : decidedOn;
  return `${REPRO_PROGRAM_REASON_PREFIX} confirmado con el cliente (${who ? `${who}, ` : ""}${day})`;
}

/**
 * Cuándo se escribe el programa de Grupo GF para el acuerdo:
 * - `ahora`: al decidir (la caja está en oficina, o es caja nueva desde stock
 *   con una salida que se puede sacar, o Grupo GF crea la salida al tomarlo);
 * - `al_recibir`: al «Recibir en oficina» la caja del motorizado (D4);
 * - `{no}`: no se programa, y por qué.
 *
 * «Caja nueva desde stock» solo se programa si alguien puede sacar la salida
 * con la que sale la caja nueva:
 * - la caja sigue con el motorizado: «Sacar con salida nueva» en Despacho del
 *   día (§29.13);
 * - la salida propia está en oficina, o estaba y el caso reabrió un «Desarmar
 *   y cerrar» (`desconocida` propia sin bloqueo, E29): Grupo GF la toma con su
 *   misma salida (`ownRetryDecision`);
 * - la caja es de otro courier y el pedido es reintento: Grupo GF crea la
 *   salida al tomarlo.
 * Lo demás (la propia fuera de la oficina o en otra solicitud, o la de otro
 * courier sin reintento) es `falta_salida`: la cola de Despacho del día lo
 * bloquea y nadie crearía la salida prometida.
 */
export type MaterializationBlock = "otro_courier" | "falta_salida" | "falta_ubicar" | "falta_recibir_devolucion";
export type MaterializationPlan = "ahora" | "al_recibir" | { no: MaterializationBlock };

export function materializationPlan(input: {
  courier: ReproCourier;
  boxAction: AgreementBoxAction;
  box: BoxLocation;
  /**
   * El pedido entra a la cola de Grupo GF como reintento de otro courier
   * (`isRetryAdmission`): al tomarlo, Grupo GF crea la salida nueva.
   */
  retryAdmission: boolean;
}): MaterializationPlan {
  if (input.courier !== "propio") return { no: "otro_courier" };
  if (input.boxAction === "caja_nueva_stock") {
    const box = input.box;
    if (box.kind === "con_motorizado") return "ahora";
    if (isOwnBox(box)) return box.kind === "en_oficina" || (box.kind === "desconocida" && !box.block) ? "ahora" : { no: "falta_salida" };
    return input.retryAdmission ? "ahora" : { no: "falta_salida" };
  }
  // La de Tanders o Swayp todavía vuelve: se programa cuando llegue (E10).
  if (input.box.kind === "volviendo_courier") return { no: "falta_recibir_devolucion" };
  switch (input.boxAction) {
    case "desarmar_rearmar":
      // Con la caja de otro courier en oficina, Grupo GF crea la salida al
      // tomarlo (E13). Con la propia viva, Kapta todavía no la anula: laguna.
      return input.retryAdmission && input.box.kind === "en_oficina" && !isOwnBox(input.box) ? "ahora" : { no: "falta_salida" };
    case "salida_nueva_rearmar":
      return input.retryAdmission ? "ahora" : { no: "falta_salida" };
    case "mantener":
    case "reimprimir_misma_salida":
      if (input.box.kind === "con_motorizado") return "al_recibir";
      if (input.box.kind === "en_oficina") return "ahora";
      return { no: "falta_ubicar" };
  }
}

/** El programa vigente de Grupo GF (`gf_dispatch_programs`). */
export interface ReproProgram {
  scheduled_for: string;
  reason: string | null;
  set_at?: string | null;
}

/** Lo del caso que hace falta para su estado. */
export interface ReproAgreementFacts {
  agreed_on: string | null;
  agreed_courier: string | null;
  box_action: string | null;
  materialized_at: string | null;
  materialized_on: string | null;
}

export type AgreementStateKind =
  | "sin_acuerdo"
  | "otro_courier"
  | "falta_salida"
  | "falta_ubicar"
  | "falta_recibir_devolucion"
  | "acuerdo_vencido"
  | "esperando_caja"
  | "por_programar"
  | "deriva_quitado"
  | "deriva_movido"
  | "falta_sacar"
  | "programado_vencido"
  | "programado";

export type AgreementState =
  | { kind: Exclude<AgreementStateKind, "deriva_movido"> }
  | { kind: "deriva_movido"; gfDay: string; reason: string | null };

/**
 * Los estados que piden a alguien: van primero en «Programados». Las derivas,
 * lo vencido, lo que falta y lo que no se programó.
 */
export const PROBLEM_STATES: ReadonlySet<AgreementStateKind> = new Set<AgreementStateKind>([
  "deriva_quitado",
  "deriva_movido",
  "programado_vencido",
  "otro_courier",
  "falta_salida",
  "falta_ubicar",
  "falta_recibir_devolucion",
  "falta_sacar",
  "por_programar",
  "acuerdo_vencido",
]);

export function isProblemState(kind: AgreementStateKind): boolean {
  return PROBLEM_STATES.has(kind);
}

/**
 * ¿Un acuerdo con Grupo GF para hoy, sin programar, ya no alcanza hoy? (E25)
 * Lo mismo que rechazaría «Programar ahora» o «Ya la encontré»
 * (`agreementDateProblem`): pasó el corte, o su acción se prepara la noche
 * anterior. Si espera la caja (`al_recibir`) solo cuenta el corte: recibida
 * antes, «Recibir en oficina» la programa. Sin el minuto de Lima, no.
 */
function missedToday(
  c: ReproAgreementFacts,
  plan: MaterializationPlan | null,
  today: string,
  nowMinute: number | null | undefined,
  cutoff: string | null | undefined,
): boolean {
  if (nowMinute == null || !sameCourier(c.agreed_courier, "propio")) return false;
  // Solo vence lo que Kapta programaría hoy: «Programar ahora» (`ahora`) o «Ya
  // la encontré» (`falta_ubicar`). A un acuerdo al que le falta la salida
  // nueva ningún botón lo programa: hecho la noche anterior, sigue en pie.
  if (plan && typeof plan === "object" && plan.no !== "falta_ubicar") return false;
  if (plan === "al_recibir") return nowMinute > sameDayCutoffMinute(cutoff);
  const boxAction = isBoxAction(c.box_action) ? c.box_action : null;
  return agreementDateProblem({ day: today, today, nowMinute, cutoff, courier: "propio", boxAction }) != null;
}

/**
 * El estado del acuerdo frente al programa vigente. El caso nunca se reescribe
 * (D5): lo que hizo Grupo GF se enseña como deriva.
 *
 * 1. Sin acuerdo → `sin_acuerdo`.
 * 2. No materializado:
 *    - con fecha pasada → `acuerdo_vencido` (E8), antes que cualquier otro: un
 *      acuerdo de otro courier o al que le falta algo también vence;
 *    - con Grupo GF para hoy y ya no alcanza hoy (`missedToday`: pasó el corte,
 *      o lo rechazaría «Programar ahora»; solo si un botón lo programaría:
 *      `ahora`, `al_recibir` o `falta_ubicar`) → `acuerdo_vencido` (E25);
 *    - lo que impide programar (`otro_courier`, `falta_*`), según el plan;
 *    - `esperando_caja` (al recibir) o `por_programar`.
 * 3. Materializado sin programa: con fecha pasada → `acuerdo_vencido`, también
 *    si Grupo GF lo quitó (§9.5, regla 4: su día pasó); si no, `deriva_quitado`
 *    si Grupo GF lo quitó o lo reemplazó después; sin evento, falló la
 *    escritura → `por_programar` (E9), o `acuerdo_vencido` si ya no alcanza hoy.
 * 4. Materializado con programa: `deriva_movido` (otro día), `falta_sacar`
 *    (caja nueva desde stock con la caja todavía con el motorizado),
 *    `programado_vencido` (su día pasó) o `programado`. Lo que diga el plan ya
 *    no manda: «Ya la encontré: programar» (E12) materializa un `falta_ubicar`
 *    y desde entonces cuenta el programa.
 */
export function agreementState(input: {
  c: ReproAgreementFacts | null;
  program: ReproProgram | null;
  box: BoxLocation;
  /** El plan con los hechos de ahora (`materializationPlan`); null sin acuerdo. */
  plan: MaterializationPlan | null;
  today: string;
  /** El último `dispatch_program_cleared` o `dispatch_program_overridden` (E9). */
  programRemovedAt?: string | null;
  /** Minuto del día en Lima (`limaClock().minute`); sin él no se mira el corte. */
  nowMinute?: number | null;
  /** El corte del mismo día del proveedor (`same_day_cutoff`). */
  cutoff?: string | null;
}): AgreementState {
  const c = input.c;
  if (!c?.agreed_on) return { kind: "sin_acuerdo" };
  const agreedOn = c.agreed_on.slice(0, 10);
  const missed = agreedOn === input.today && missedToday(c, input.plan, input.today, input.nowMinute, input.cutoff);
  if (!c.materialized_at) {
    if (agreedOn < input.today || missed) return { kind: "acuerdo_vencido" };
    if (input.plan && typeof input.plan === "object") return { kind: input.plan.no };
    return { kind: input.plan === "al_recibir" ? "esperando_caja" : "por_programar" };
  }

  const program = input.program;
  if (!program) {
    if (agreedOn < input.today) return { kind: "acuerdo_vencido" };
    const removed = input.programRemovedAt && Date.parse(input.programRemovedAt) > Date.parse(c.materialized_at);
    if (removed) return { kind: "deriva_quitado" };
    return { kind: missed ? "acuerdo_vencido" : "por_programar" };
  }
  const gfDay = program.scheduled_for.slice(0, 10);
  if (gfDay !== (c.materialized_on ?? agreedOn).slice(0, 10)) return { kind: "deriva_movido", gfDay, reason: program.reason };
  if (c.box_action === "caja_nueva_stock" && input.box.kind === "con_motorizado") return { kind: "falta_sacar" };
  if (gfDay < input.today) return { kind: "programado_vencido" };
  return { kind: "programado" };
}

/**
 * La chapa del estado del acuerdo en la fila y en la hoja. Con `today`, un
 * acuerdo vencido el mismo día dice que ya no alcanza hoy (E25).
 */
export function agreementStateLabel(
  state: AgreementState,
  agreement: { agreed_on: string | null; agreed_courier: string | null } | null,
  box?: BoxLocation | null,
  today?: string | null,
): string {
  const day = agreement?.agreed_on ? programDayLabel(agreement.agreed_on.slice(0, 10)) : "el día acordado";
  const courier = reproCourierName(agreement?.agreed_courier);
  if (state.kind === "acuerdo_vencido" && today && agreement?.agreed_on?.slice(0, 10) === today) {
    return `El acuerdo era para hoy (${day}) y ya no alcanza: confírmalo de nuevo`;
  }
  switch (state.kind) {
    case "sin_acuerdo":
      return "Sin acuerdo";
    case "otro_courier":
      return `Sale ${day} con ${courier} · crea la salida en la Mesa de ruta`;
    case "falta_salida":
      return "Falta la salida nueva";
    case "falta_ubicar":
      return "No consta dónde está la caja: búscala antes de programar";
    case "falta_recibir_devolucion":
      return `Vuelve con ${box?.kind === "volviendo_courier" ? reproCourierName(box.courier) : "su courier"}: se programa cuando llegue (Devoluciones)`;
    case "acuerdo_vencido":
      return `El acuerdo era para el ${day} y ya pasó: confírmalo de nuevo`;
    case "esperando_caja":
      return `Sale ${day} con ${courier} · esperando la caja`;
    case "por_programar":
      return `Sale ${day} con ${courier} · falta programarlo`;
    case "deriva_quitado":
      return `Grupo GF no tiene la fecha (acordado ${day})`;
    case "deriva_movido":
      return `Grupo GF lo movió al ${programDayLabel(state.gfDay)}${state.reason?.trim() ? ` («${state.reason.trim()}»)` : ""}`;
    case "falta_sacar":
      return "Falta: Sacar con salida nueva";
    case "programado_vencido":
      return `Programado para el ${day} y no salió`;
    case "programado":
      return `Programado · sale ${day} con ${courier}`;
  }
}

// ---------------------------------------------------------------------------
// Listas, orden y chapas
// ---------------------------------------------------------------------------

/** Lo del caso abierto que hace falta para la lista. */
export interface ReproOpenCaseFacts extends ReproAgreementFacts {
  episode_key: string;
  next_call_at: string | null;
  closed_at?: string | null;
}

/** El último caso cerrado del pedido. */
export interface ReproClosedCaseFacts {
  episode_key: string;
  close_reason: string | null;
  closed_at: string | null;
}

export type ReproChipKey =
  | "toca_llamar"
  | "acuerdo_anterior"
  | "acuerdo_vencido"
  | "programado_gf_sin_acuerdo"
  | "programado_acuerdo_anterior"
  | "fecha_motorizado"
  | "pidio";

export interface ReproChip {
  key: ReproChipKey;
  text: string;
}

export interface ReproListResult {
  list: ReproList;
  /** Vencido: llamada que ya toca o acuerdo cuya fecha pasó (rango 1). */
  overdue: boolean;
  chips: ReproChip[];
}

/** «Toca llamar · 15:00» (hoy) o «Toca llamar · sáb 10/10 15:00». */
function callChip(iso: string, now: Date): ReproChip {
  const t = Date.parse(iso);
  const at = limaClock(new Date(t));
  const sameDay = at.day === limaClock(now).day;
  return { key: "toca_llamar", text: `Toca llamar · ${sameDay ? "" : `${programDayLabel(at.day)} `}${hhmm(at.minute)}` };
}

/**
 * La lista de la fila (E7). Un caso de otro episodio cuenta como ausente: el
 * servidor lo cierra (`nuevo_intento`) y la fila se lee como nueva. Reglas, en
 * orden:
 * 1. Sin caso abierto y el último cerrado es «Desarmar y cerrar» del mismo
 *    episodio → «Cerrados» (espera que Shopify anule la venta).
 * 2. Acuerdo no vencido → «Programados» (con «Toca llamar» si hay llamada).
 * 3. Próxima llamada futura → «Llamar después» («Acuerdo anterior» si quedó uno).
 * 4. Acuerdo vencido (sin materializar y su día pasó o ya no alcanza hoy, o su
 *    programa pasó) → «Por decidir», vencido. La chapa dice cuál: el día
 *    acordado pasó, ya no alcanza hoy, o Grupo GF lo programó antes y ese día
 *    pasó sin salir (el día acordado todavía no llega).
 * 5. Programa sin acuerdo vivo: de Grupo GF → «Programados»; de un acuerdo
 *    anterior o del motorizado (#908, D9) → «Por decidir», con su chapa.
 * 6. Lo demás → «Por decidir» (una llamada que ya toca es vencida).
 */
export function reproList(input: {
  open: ReproOpenCaseFacts | null;
  latestClosed: ReproClosedCaseFacts | null;
  episodeKey: string;
  /** `agreementState` del caso abierto. */
  state: AgreementState;
  program: ReproProgram | null;
  now: Date;
  /** Día de Lima; por defecto el de `now`. */
  today?: string;
  /** La fecha que pidió el cliente en la parada (`requested_date`). */
  requestedDate?: string | null;
}): ReproListResult {
  const today = input.today ?? limaClock(input.now).day;
  const nowMs = input.now.getTime();
  const live = input.open && !input.open.closed_at && input.open.episode_key === input.episodeKey ? input.open : null;
  const state: AgreementState = live ? input.state : { kind: "sin_acuerdo" };
  const hasAgreement = Boolean(live?.agreed_on) && state.kind !== "sin_acuerdo";
  const programDay = input.program?.scheduled_for.slice(0, 10) ?? null;
  const nextCall = live?.next_call_at && Number.isFinite(Date.parse(live.next_call_at)) ? live.next_call_at : null;
  const callDue = nextCall ? Date.parse(nextCall) <= nowMs : false;
  const callLater = nextCall ? Date.parse(nextCall) > nowMs : false;

  const agreementOverdue = hasAgreement && (
    state.kind === "acuerdo_vencido" ||
    state.kind === "programado_vencido" ||
    (Boolean(live?.materialized_at) && programDay != null && programDay < today)
  );
  const hasAgreementLive = hasAgreement && !agreementOverdue;

  const chips: ReproChip[] = [];
  const requested = (input.requestedDate ?? "").slice(0, 10);
  // La fecha que pidió el cliente, mientras no haya un acuerdo vivo (D9).
  const requestedChip = (): void => {
    if (!DAY_RE.test(requested) || hasAgreementLive) return;
    chips.push({ key: "pidio", text: `Pidió ${programDayLabel(requested)} · ${requested < today ? "ya pasó" : "sin confirmar"}` });
  };

  // 1. Cerrados: «Desarmar y cerrar» del episodio vigente, sin caso abierto.
  if (!live && input.latestClosed?.close_reason === "desarmar_cerrar" && input.latestClosed.episode_key === input.episodeKey) {
    return { list: "cerrados", overdue: false, chips };
  }

  // 2. Acuerdo vigente.
  if (hasAgreementLive) {
    if (nextCall) chips.push(callChip(nextCall, input.now));
    return { list: "programados", overdue: false, chips };
  }

  // 3. Llamar después.
  if (callLater) {
    if (hasAgreement && live?.agreed_on) {
      chips.push({ key: "acuerdo_anterior", text: `Acuerdo anterior: ${programDayLabel(live.agreed_on.slice(0, 10))} con ${reproCourierName(live.agreed_courier)}` });
    }
    requestedChip();
    return { list: "llamar_despues", overdue: false, chips };
  }

  // 4. Acuerdo vencido.
  if (agreementOverdue && live?.agreed_on) {
    if (nextCall) chips.push(callChip(nextCall, input.now));
    const agreedOn = live.agreed_on.slice(0, 10);
    const text = agreedOn < today
      ? `Acuerdo vencido: era para el ${programDayLabel(agreedOn)}`
      : live.materialized_at && programDay != null && programDay < today
        ? `Grupo GF lo programó para el ${programDayLabel(programDay)} y no salió; acordado ${programDayLabel(agreedOn)}`
        : "Acuerdo vencido: era para hoy y ya no alcanza";
    chips.push({ key: "acuerdo_vencido", text });
    requestedChip();
    return { list: "por_decidir", overdue: true, chips };
  }

  if (callDue && nextCall) chips.push(callChip(nextCall, input.now));

  // 5. Programa sin acuerdo vivo.
  if (input.program && programDay) {
    const origin = programOrigin(input.program.reason);
    if (origin === "grupo_gf") {
      chips.push({ key: "programado_gf_sin_acuerdo", text: "Programado en Grupo GF · sin acuerdo" });
      requestedChip();
      return { list: "programados", overdue: callDue, chips };
    }
    chips.push(
      origin === "motorizado"
        ? { key: "fecha_motorizado", text: `Fecha del motorizado sin confirmar: ${programDayLabel(programDay)}` }
        : { key: "programado_acuerdo_anterior", text: "Programado por un acuerdo anterior" },
    );
  }

  // 6. Por decidir.
  requestedChip();
  return { list: "por_decidir", overdue: callDue, chips };
}

/**
 * El último día de reparto antes de hoy: ayer, o el sábado si hoy es lunes
 * (el domingo no hay rutas).
 */
export function lastRouteDay(today: string): string {
  return shiftDay(today, weekdayOf(today) === 1 ? -2 : -1);
}

/**
 * El rango en «Por decidir» (D13; E19):
 * 0 = el fallo es del último día de reparto;
 * 1 = vencido (una llamada que ya toca o un acuerdo cuya fecha pasó);
 * 2 = más de 7 días en la etapa;
 * 3 = lo demás.
 */
export function porDecidirRank(input: {
  macroSince: string | null;
  today: string;
  overdue: boolean;
  /** Día de Lima del fallo (ruta de la parada o fallo de la salida); por defecto, el de `macroSince`. */
  failedOn?: string | null;
}): 0 | 1 | 2 | 3 {
  const failed = input.failedOn && DAY_RE.test(input.failedOn.slice(0, 10)) ? input.failedOn.slice(0, 10) : limaDayOf(input.macroSince);
  if (failed && failed >= lastRouteDay(input.today) && failed < input.today) return 0;
  if (input.overdue) return 1;
  const since = limaDayOf(input.macroSince);
  if (since && daysFromTo(since, input.today) > 7) return 2;
  return 3;
}

/** Lo que hace falta de una fila para ordenarla. */
export interface ReproSortable {
  list: ReproList;
  /** `porDecidirRank` (solo cuenta en «Por decidir»). */
  rank: number;
  macroSince: string | null;
  nextCallAt: string | null;
  state: { kind: AgreementStateKind };
  agreedOn: string | null;
  /** El día del programa vigente, para «Programados» sin acuerdo. */
  programDay?: string | null;
  closedAt: string | null;
  /** Desempate estable. */
  orderName?: string | null;
}

function cmpText(a: string | null | undefined, b: string | null | undefined): number {
  // Lo que no tiene valor va al final.
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpTime(a: string | null | undefined, b: string | null | undefined): number {
  const ta = Date.parse(a ?? "");
  const tb = Date.parse(b ?? "");
  const fa = Number.isFinite(ta);
  const fb = Number.isFinite(tb);
  if (!fa && !fb) return 0;
  if (!fa) return 1;
  if (!fb) return -1;
  return ta - tb;
}

/**
 * El orden dentro de cada lista:
 * - «Por decidir»: por rango; en 0-2 lo más antiguo en la etapa primero, en 3 lo
 *   más reciente primero;
 * - «Llamar después»: por la hora de la llamada;
 * - «Programados»: los estados que piden a alguien primero, después por el día
 *   acordado (o el del programa);
 * - «Cerrados»: el cierre más reciente primero.
 */
export function compareRepro(a: ReproSortable, b: ReproSortable): number {
  const byList = REPRO_LISTS.indexOf(a.list) - REPRO_LISTS.indexOf(b.list);
  if (byList) return byList;
  let out = 0;
  switch (a.list) {
    case "por_decidir":
      out = a.rank - b.rank || (a.rank === 3 ? -cmpTime(a.macroSince, b.macroSince) : cmpTime(a.macroSince, b.macroSince));
      break;
    case "llamar_despues":
      out = cmpTime(a.nextCallAt, b.nextCallAt);
      break;
    case "programados":
      out = Number(isProblemState(b.state.kind)) - Number(isProblemState(a.state.kind)) ||
        cmpText(a.agreedOn ?? a.programDay, b.agreedOn ?? b.programDay);
      break;
    case "cerrados":
      out = -cmpTime(a.closedAt, b.closedAt);
      break;
  }
  return out || cmpText(a.orderName, b.orderName);
}

/** Una copia ordenada (no toca la original). */
export function sortRepro<T extends ReproSortable>(rows: readonly T[]): T[] {
  return [...rows].sort(compareRepro);
}

/** Intentos sin respuesta y días desde la recepción para sugerir cerrar (decisión 10). */
export const DISMANTLE_NO_ANSWER_MIN = 3;
export const DISMANTLE_DAYS_MIN = 10;

/**
 * ¿Se sugiere «Desarmar y cerrar»? Tres «No contesta» o más y diez días o más
 * desde la recepción en oficina. Solo una chapa: la merma no se automatiza
 * (principio 11 del MOM). `receivedAt` es la recepción de la caja del
 * episodio que está en oficina (`en_oficina.since`): una recepción anterior a
 * que volviera a salir no cuenta, y sin caja en oficina no hay sugerencia.
 */
export function dismantleSuggested(input: { receivedAt: string | null; noAnswerCount: number; today: string }): boolean {
  if (input.noAnswerCount < DISMANTLE_NO_ANSWER_MIN) return false;
  const received = limaDayOf(input.receivedAt);
  return received != null && daysFromTo(received, input.today) >= DISMANTLE_DAYS_MIN;
}

// ---------------------------------------------------------------------------
// El fallo, en una línea (§11.7: motivo, nota y foto antes de llamar)
// ---------------------------------------------------------------------------

export type ReproFailure =
  | {
      kind: "parada";
      riderName: string | null;
      /** Día de la ruta (YYYY-MM-DD). */
      routeDate: string | null;
      outcomeReason: string | null;
      note: string | null;
    }
  | {
      kind: "courier";
      courier: string;
      reportedStatus: string | null;
      swaypState?: number | null;
      /** Día del fallo (YYYY-MM-DD o ISO), cuando el courier lo sella (Aliclik al anular). */
      failedOn?: string | null;
      /**
       * Día en que salió el intento fallido, cuando es lo único fijo que hay
       * (Tanders y Swayp: `guideFailedAt` se ancla en la salida). Se dice como
       * salida, nunca como el día del fallo.
       */
      dispatchedOn?: string | null;
    };

/**
 * «No entregado por Roy el sáb 10/10 · Rechazó el pedido · «nota»». Sin motivo
 * se escribe la ausencia (§11.7): la falta de dato no es «no lo rechazó».
 * `rejected`: el cliente lo rechazó en la puerta. De otro courier, con solo el
 * día de la salida: «Salió el lun 12/10 con Swayp · motivo».
 */
export function failureLine(f: ReproFailure): { text: string; rejected: boolean } {
  if (f.kind === "parada") {
    const day = f.routeDate && DAY_RE.test(f.routeDate.slice(0, 10)) ? ` el ${programDayLabel(f.routeDate.slice(0, 10))}` : "";
    const who = f.riderName?.trim() || "el motorizado";
    const reason = f.outcomeReason?.trim()
      ? NON_DELIVERY_REASONS.find((r) => r.code === f.outcomeReason)?.label ?? f.outcomeReason.trim()
      : "sin motivo del motorizado · no consta si lo rechazó en la puerta";
    const note = f.note?.trim() ? ` · «${f.note.trim()}»` : "";
    return { text: `No entregado por ${who}${day} · ${reason}${note}`, rejected: f.outcomeReason === "rechazado" };
  }
  const motivo = motivoDelCourier(f.reportedStatus).texto;
  const rejected = guideDoorRejection({
    courier: f.courier,
    delivery_status: "",
    reported_status: f.reportedStatus,
    swayp_state: f.swaypState ?? null,
  });
  const dispatchedOn = limaDayOf(f.dispatchedOn ?? null);
  if (dispatchedOn) {
    return { text: `Salió el ${programDayLabel(dispatchedOn)} con ${reproCourierName(f.courier)} · ${motivo}`, rejected };
  }
  const failedOn = limaDayOf(f.failedOn ?? null);
  const day = failedOn ? ` el ${programDayLabel(failedOn)}` : "";
  return { text: `No entregado por ${reproCourierName(f.courier)}${day} · ${motivo}`, rejected };
}

// ---------------------------------------------------------------------------
// Candado y notas del historial
// ---------------------------------------------------------------------------

export type ClaimView = "libre" | "mio" | "otro";

/** El candado del caso visto por quien mira. Vencido o vacío = libre. */
export function claimView(
  by: string | null | undefined,
  until: string | null | undefined,
  me: string,
  now: Date = new Date(),
): ClaimView {
  const t = Date.parse(until ?? "");
  if (!by || !Number.isFinite(t) || t <= now.getTime()) return "libre";
  return by === me ? "mio" : "otro";
}

/**
 * La nota del evento (`lima_repro_call`, `lima_repro_agreed`,
 * `lima_repro_closed`) que se lee en el historial del pedido:
 * - «Repro Lima · Confirma (llamada): sale el jue 15/10 con Grupo GF. Caja: Mantener. Cambios: dirección.»
 * - «Repro Lima · No contesta (intento 2). Próxima: hoy 15:00.»
 * - «Repro Lima · Llamar el lun 13/10 15:00.»
 * - «Repro Lima · No quiere: «…». Desarmar y cerrar; no anula la venta.»
 */
export function reproEventNote(input: {
  outcome: ReproOutcome;
  channel: ReproChannel;
  now?: Date;
  agreedOn?: string | null;
  courier?: ReproCourier | null;
  boxAction?: BoxAction | null;
  changes?: Partial<ReproChanges> | null;
  nextCallAt?: string | null;
  note?: string | null;
  /** Intentos sin respuesta contando este (`no_answer_count` después de la llamada). */
  attempt?: number | null;
}): string {
  const now = input.now ?? new Date();
  const note = input.note?.trim() || null;
  const tail = note ? ` Nota: «${note}».` : "";
  switch (input.outcome) {
    case "confirma": {
      const day = input.agreedOn ? programDayLabel(input.agreedOn.slice(0, 10)) : "el día acordado";
      const courier = input.courier ? REPRO_COURIER_LABEL[input.courier] : "su courier";
      const box = input.boxAction ? ` Caja: ${BOX_ACTION_LABEL[input.boxAction]}.` : "";
      const changes = reproChangesText(input.changes);
      return `Repro Lima · Confirma (${REPRO_CHANNEL_LABEL[input.channel]}): sale el ${day} con ${courier}.${box} ${changes ? `Cambios: ${changes}.` : "Sin cambios."}${tail}`;
    }
    case "no_contesta": {
      const detail = [
        input.channel === "whatsapp" ? "WhatsApp" : null,
        input.attempt && input.attempt > 0 ? `intento ${input.attempt}` : null,
      ].filter(Boolean).join(", ");
      const next = input.nextCallAt ? ` Próxima: ${reproCallTimeLabel(input.nextCallAt, now)}.` : "";
      return `Repro Lima · No contesta${detail ? ` (${detail})` : ""}.${next}${tail}`;
    }
    case "llamar_despues": {
      const when = input.nextCallAt ? reproCallTimeLabel(input.nextCallAt, now) : "más tarde";
      const prefix = /^(hoy|mañana|más tarde)/.test(when) ? "" : "el ";
      return `Repro Lima · Llamar ${prefix}${when}.${tail}`;
    }
    case "no_quiere": {
      const reason = note ? `«${note}»` : "sin motivo";
      return input.channel === "sin_contacto"
        ? `Repro Lima · Desarmar y cerrar sin llamada: ${reason}. No anula la venta.`
        : `Repro Lima · No quiere: ${reason}. Desarmar y cerrar; no anula la venta.`;
    }
  }
}
