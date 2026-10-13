// Almacén: «Reintentos por salir» (fase 1, entrega 1c; MOM §9.5). Reglas
// PURAS: sin IO, para el servidor y la pantalla.
//
// Qué cajas de «En curso · Por reprogramar Lima» salen hoy (lo vencido
// incluido) o mañana, qué hacer con cada una, dónde debería estar y qué está
// mal. Parte de la fila de Repro Lima (`ReproRow`, lib/repro-lima-access.ts):
// una sola fuente para las dos pantallas.
//
// - El día lo manda el programa vigente de Grupo GF, el mismo que ordena
//   «Programados hoy» en Despacho del día (§29.6); sin programa, el acuerdo
//   vigente de Repro Lima. Sin ninguno de los dos no hay fecha: la caja se
//   queda en el estante.
// - La acción es la guardada en el caso (§9.3): Almacén no la elige. Si con
//   los hechos de ahora Kapta calcularía otra, la fila lo dice; el caso nunca
//   se reescribe (D5). Sin acuerdo, la de la tabla sin cambios declarados,
//   marcada «Por defecto» (decisión 1 del owner, 13-10-2026).
// - «Hoy», «Mañana» y los apartados son etiquetas de esta pantalla, no
//   subetapas. Los pedidos que ya están en «Por armar» se listan aparte y no
//   se cuentan: los cuenta «Por armar».

import type { ReproRow } from "@/lib/repro-lima-access";
import { limaClock, nextDay, sameDayCutoffLabel, sameDayCutoffMinute } from "@/lib/grupo-gf-courier";
import { programDayLabel } from "@/lib/dispatch-day";
import { sameCourier } from "@/lib/shipment-output";
import { reproBoxAction, type ReproBoxActionInput } from "@/lib/repro-box-action";
import { REPRO_NO_LO_QUIERE_CHIP } from "@/lib/repro-lima-program";
import {
  BOX_ACTION_LABEL,
  NIGHT_BEFORE_BOX_ACTIONS,
  NO_REPRO_CHANGES,
  REPRO_COURIER_LABEL,
  boxLocationLabel,
  isAgreementBoxAction,
  isOwnBox,
  isProblemState,
  isReproCourier,
  reproChangesText,
  reproCourierName,
  type AgreementStateKind,
  type BoxAction,
  type BoxLocation,
  type ReproChipKey,
  type ReproCourier,
} from "@/lib/repro-lima";

export { BOX_ACTION_LABEL, NIGHT_BEFORE_BOX_ACTIONS, REPRO_NO_LO_QUIERE_CHIP, type BoxAction };

// ---------------------------------------------------------------------------
// Textos (el MOM los cita tal cual, §9.5)
// ---------------------------------------------------------------------------

export const RETRY_HELP = "Cajas de «Por reprogramar Lima» que salen hoy o mañana, con lo que Kapta dice que hagas con cada una. No cuentan en «Por empacar».";
/** El corte sale del proveedor (`sameDayCutoffLabel`), nunca fijo (D6). */
export const RETRY_HOY_HELP = (cutoff: string): string =>
  `Lo programado hasta el corte de las ${cutoff} sale esta tarde; lo vencido sigue aquí hasta que salga o se reprograme.`;
export const RETRY_MANANA_HELP = "Déjalo listo esta tarde: primero lo que se prepara la noche anterior.";
export const RETRY_DEFAULT_CHIP = "Por defecto: sin acuerdo de Repro Lima";
export const RETRY_UNCONFIRMED = "No va al anaquel hasta que Repro Lima la confirme.";
export const RETRY_FACTS_CHANGED = "Los hechos cambiaron desde el acuerdo: confírmalo con Repro Lima antes de tocarla.";
export const RETRY_NO_ANAQUEL_DESARMAR = "No va al anaquel aunque Grupo GF lo programó: avisa a Despacho GF.";
export const RETRY_NO_GF_PROGRAM = "Sin programa en Grupo GF";
export const RETRY_OVERDUE = (day: string): string => `Vencido · era para el ${day}`;
export const RETRY_ADDED_TODAY = (time: string): string => `Agregado hoy ${time}`;
export const RETRY_ADDED_LATE = (time: string): string => `Agregado hoy ${time}, después del corte`;
export const RETRY_NIGHT_BEFORE_MANANA = "Prepárala hoy: se prepara la noche anterior";
export const RETRY_NIGHT_BEFORE_HOY = "Se prepara la noche anterior y se programó hoy: prepárala ya";
export const RETRY_NO_RECEPTION_OWN = "Kapta la cuenta en oficina, pero nadie registró su recepción: búscala en el estante.";
export const RETRY_NO_RECEPTION_OTHER = (courier: string): string => `${courier} la da por devuelta; nadie la escaneó en Devoluciones.`;
export const RETRY_ADDRESS_CHANGED = (day: string): string =>
  `La dirección cambió el ${day}, después de armar la caja: el rótulo tiene la anterior. Avisa a Repro Lima.`;
export const RETRY_ANAQUEL = (day: string): string => `Debería estar en el anaquel del ${day}`;
export const RETRY_TRAY = (day: string): string => `En el estante · bandeja del ${day}`;
export const RETRY_TRAY_OLD = "En el estante · bandeja «sin fecha / más de 7 días»";
export const RETRY_OTHER_SALIDA_EXISTS = (courier: string): string =>
  `La salida de ${courier} ya existe: rearma la caja del estante con su etiqueta y retira la vieja.`;
export const RETRY_GF_STILL_LIVE = "La salida de Grupo GF sigue viva: avisa a Despacho GF.";
export const HANDOFF_GROUP = "Ya en «Por armar»";
export const HANDOFF_NOTE = "Se cuentan en «Por armar».";
export const HANDOFF_LINE_GF = "Pega el rótulo de la salida nueva encima del anterior, tapando su QR, y escanéala.";
export const HANDOFF_LINE_OTHER = (courier: string): string => `Rearma la caja del estante con la etiqueta de ${courier} y retira la vieja.`;
export const HANDOFF_LINE_DESARMAR = "Desarma la caja del estante y arma otra con la salida nueva.";
export const HANDOFF_LINE_CAJA_NUEVA = "Arma la caja nueva desde stock con la salida nueva; la anterior se desarma al recibirla.";
/** La chapa de la fila de «Por armar» cuyo pedido es un reintento («Reintento · Salida nueva y rearmado»). */
export const POR_ARMAR_CHIP = (action: string): string => `Reintento · ${action}`;
export const RETRY_ERROR = "No pudimos cargar «Reintentos por salir».";
export const RETRY_EMPTY_HOY = "Nada de reintentos sale hoy.";
export const RETRY_EMPTY_MANANA = "Nada de reintentos sale mañana.";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type RetryBucket = "hoy" | "manana";
export type RetryGroup = "con_aviso" | "anaquel" | "fuera";
export type RetryDayFrom = "programa" | "acuerdo";
export type RetryActionSource = "acuerdo" | "por_defecto" | "cerrado";
export type RetryChipTone = "neutral" | "info" | "warn" | "crit";

/** Una chapa: el tono va siempre con su texto (§ Estados). */
export interface RetryChip {
  tone: RetryChipTone;
  text: string;
}

export interface WarehouseRetryRow {
  orderId: string;
  storeId: string;
  storeName: string;
  orderName: string;
  customerName: string;
  district: string | null;
  bucket: RetryBucket;
  /** El día que sale (YYYY-MM-DD): el del programa o el del acuerdo. */
  day: string;
  /** «jue 15/10». */
  dayLabel: string;
  /** Su día ya pasó y sigue aquí («Hoy»). */
  overdue: boolean;
  dayFrom: RetryDayFrom;
  courierName: string;
  /** La chapa de la acción; null si la tabla da un problema (sin acuerdo). */
  action: BoxAction | null;
  actionSource: RetryActionSource | null;
  /** Qué hacer con la caja, en una línea (o el problema). */
  actionLine: string | null;
  /** Lo que cambió el cliente, sin prefijo («dirección, monto»): la pantalla dice «Cambió: …». */
  changesText: string | null;
  /** «Decidió Diana 12/10 15:20». */
  decidedLine: string | null;
  /** El motivo del programa sin acuerdo, tal cual: la pantalla dice «Motivo: «…»». */
  programReason: string | null;
  /** Se prepara la noche anterior (`NIGHT_BEFORE_BOX_ACTIONS`). */
  nightBefore: boolean;
  /** La chapa de la caja de Repro Lima («Con Roy desde lun 12/10», «Vuelve con Tanders»). */
  boxLabel: string;
  /** Dónde debería estar en oficina: anaquel o bandeja. Solo con la caja en oficina. */
  whereLine: string | null;
  inOffice: boolean;
  group: RetryGroup;
  chips: RetryChip[];
  /** «Imprimir rótulo» de la misma salida (`/api/pedidos/rotulos?ids=`). */
  label: { shipmentId: string; code: string | null } | null;
}

/** Un acuerdo cuya salida nueva ya nació: el pedido está en «Por armar». No se cuenta. */
export interface WarehouseHandoffRow {
  orderId: string;
  orderName: string;
  storeName: string;
  customerName: string;
  district: string | null;
  bucket: RetryBucket;
  day: string;
  dayLabel: string;
  overdue: boolean;
  action: BoxAction;
  courierName: string;
  /** Qué se hace con la caja del estante (`handoffLine`). */
  line: string;
  /** La salida nueva; null si no se encontró (no se adivina). */
  salida: { code: string | null; armed: boolean; readyAt: string | null } | null;
}

export interface WarehouseRetriesData {
  today: string;
  nowIso: string;
  /** «12:00»: el corte del proveedor. */
  cutoffLabel: string;
  rows: WarehouseRetryRow[];
  handoffs: WarehouseHandoffRow[];
  /** Solo las filas de la etapa: los de «Ya en «Por armar»» nunca cuentan. */
  counts: { hoy: number; manana: number; hoyEnOficina: number; hoyFuera: number; mananaNoche: number };
  /** Candidatos que pasaron el tope de lectura. */
  omitted: number;
  /** Más de una tienda a la vista: la fila dice la suya. */
  showStore: boolean;
  error?: string;
}

/** Lo que la proyección necesita además de las filas. */
export interface RetryContext {
  today: string;
  /** El corte de la cabecera; cada fila usa el de su proveedor (`ReproRow.cutoff`) si lo tiene. */
  cutoffMinute: number;
  /** La salida propia de cada fila (`ReproRow.ownOutput`): dirección y armado. */
  ownShipments: ReadonlyMap<string, { addressUpdatedAt: string | null; readyAt: string | null }>;
}

// ---------------------------------------------------------------------------
// Fechas de Lima
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
/** Bandejas fijas: una por día de recepción hasta 7 días; después, «sin fecha / más de 7 días». */
const TRAY_DAYS = 7;

function limaStamp(iso: string | null | undefined): { day: string; minute: number } | null {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? limaClock(new Date(t)) : null;
}

function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** «12/10». */
function ddmm(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS);
}

// ---------------------------------------------------------------------------
// Qué día sale
// ---------------------------------------------------------------------------

/**
 * El día de la caja; la primera regla que aplica gana:
 * 1. el programa vigente de Grupo GF. Si Grupo GF movió el día (`deriva_movido`),
 *    manda el suyo y la fila lo dice; el caso no se reescribe (D5);
 * 2. sin programa, el acuerdo vigente («Programados» de Repro Lima);
 * 3. lo demás no se lista: sin fecha la caja se queda en el estante, un
 *    acuerdo vencido vuelve a «Por decidir» y un «Desarmar y cerrar» sin
 *    programa no sale.
 */
export function retryDay(r: Pick<ReproRow, "program" | "agreement" | "list">): { day: string; dayFrom: RetryDayFrom } | null {
  if (r.program) return { day: r.program.scheduledFor.slice(0, 10), dayFrom: "programa" };
  if (r.agreement && r.list === "programados") return { day: r.agreement.agreedOn.slice(0, 10), dayFrom: "acuerdo" };
  return null;
}

/**
 * «Hoy» es su día o uno que pasó sin salir (vencido); «Mañana», el día
 * siguiente del calendario, como Despacho del día (el sábado, el domingo).
 * Lo de después no se lista.
 */
export function retryBucket(day: string, today: string): { bucket: RetryBucket; overdue: boolean } | null {
  if (day <= today) return { bucket: "hoy", overdue: day < today };
  if (day === nextDay(today)) return { bucket: "manana", overdue: false };
  return null;
}

// ---------------------------------------------------------------------------
// Qué hacer con la caja
// ---------------------------------------------------------------------------

export interface RetryAction {
  action: BoxAction | null;
  actionSource: RetryActionSource | null;
  actionLine: string | null;
  /** Lo que dice `reproBoxAction` con los hechos de ahora; null si no coincide o no hay acción. */
  newSalida: boolean | null;
  courierName: string;
  changesText: string | null;
  decidedLine: string | null;
  programReason: string | null;
  /** Las chapas de la acción, en orden. */
  chips: RetryChip[];
  /** «No lo quiere» o los hechos cambiaron: «Con aviso», primero. */
  critical: boolean;
  /** La fecha es del motorizado o de un acuerdo anterior. */
  unconfirmed: boolean;
  /** Sin acuerdo, la tabla da un problema: no hay acción que leer. */
  defaultProblem: boolean;
  /** La salida del otro courier ya existe con la de Grupo GF viva (laguna 1 de 1a). */
  otherSalidaExists: boolean;
}

/** Las chapas de 1a que pasan tal cual a una fila sin acuerdo, con el tono de Repro Lima. */
const PASS_THROUGH_CHIPS: Partial<Record<ReproChipKey, RetryChipTone>> = {
  programado_gf_sin_acuerdo: "info",
  fecha_motorizado: "warn",
  programado_acuerdo_anterior: "warn",
};

/** Lo de la caja que `reproBoxAction` lee de la fila; el courier lo pone quien llama. */
function boxFacts(r: ReproRow, courier: ReproCourier | null): Omit<ReproBoxActionInput, "outcome" | "courier" | "changes"> {
  return {
    box: r.box,
    ownLiveCourier: r.boxInputs.ownLiveCourier,
    lastFailedCourier: r.boxInputs.lastFailedCourier,
    otherLiveCourier: r.boxInputs.otherLiveCourier,
    hadPropio: r.boxInputs.hadPropio,
    totalOutputs: r.boxInputs.totalOutputs,
    priorWithCourier: courier ? r.boxInputs.priorByCourier[courier] : 0,
    ownReplace: r.boxInputs.ownReplace,
    reopened: r.reopened,
    retryAdmission: r.retryAdmission,
  };
}

/** «Decidió Diana 12/10 15:20». */
function decidedLineOf(name: string | null, at: string | null): string | null {
  const stamp = limaStamp(at);
  if (!stamp) return name ? `Decidió ${name}` : null;
  return `Decidió ${name ? `${name} ` : ""}${ddmm(stamp.day)} ${hhmm(stamp.minute)}`;
}

/**
 * La acción de la caja; la primera regla que aplica gana:
 * a) «Cerrados» (el último caso del episodio es «Desarmar y cerrar») y Grupo GF
 *    lo programó: se desarma y no va al anaquel; avisa a Despacho GF.
 * b) Un acuerdo: la acción guardada. Se recalcula como al guardar
 *    (app/dashboard/pedidos/repro-lima/actions.ts); si ahora sale otra, «Los
 *    hechos cambiaron…», salvo que el problema sea la salida del otro courier
 *    acordado, que ya existe: eso no es deriva (laguna 1 de 1a).
 * c) Un programa sin acuerdo vivo: la de la tabla con Grupo GF y sin cambios
 *    declarados, «Por defecto: sin acuerdo de Repro Lima»; con un problema, sin
 *    acción. La fecha del motorizado o de un acuerdo anterior no va al anaquel
 *    hasta que Repro Lima la confirme.
 */
export function retryAction(r: ReproRow): RetryAction {
  const out: RetryAction = {
    action: null,
    actionSource: null,
    actionLine: null,
    newSalida: null,
    courierName: REPRO_COURIER_LABEL.propio,
    changesText: null,
    decidedLine: null,
    programReason: null,
    chips: [],
    critical: false,
    unconfirmed: false,
    defaultProblem: false,
    otherSalidaExists: false,
  };

  // a) No lo quiere y Grupo GF lo programó igual.
  if (r.list === "cerrados" && r.program) {
    const closed = reproBoxAction({ outcome: "no_quiere", courier: null, changes: NO_REPRO_CHANGES, ...boxFacts(r, null) });
    out.action = "desarmar_cerrar";
    out.actionSource = "cerrado";
    out.actionLine = "action" in closed ? closed.label : null;
    out.chips.push({ tone: "crit", text: REPRO_NO_LO_QUIERE_CHIP }, { tone: "crit", text: RETRY_NO_ANAQUEL_DESARMAR });
    out.critical = true;
    return out;
  }

  // b) La acción guardada en el acuerdo.
  if (r.agreement) {
    const agreement = r.agreement;
    out.courierName = agreement.courierName;
    out.changesText = reproChangesText(agreement.changes);
    out.decidedLine = decidedLineOf(agreement.decidedByName, agreement.decidedAt);
    // Un acuerdo siempre guarda su acción (CHECK de 0251); sin ella no hay qué leer.
    const stored = isAgreementBoxAction(agreement.boxAction) ? agreement.boxAction : null;
    if (!stored) {
      out.chips.push({ tone: "crit", text: RETRY_FACTS_CHANGED });
      out.critical = true;
      return out;
    }
    out.action = stored;
    out.actionSource = "acuerdo";
    const courier = isReproCourier(agreement.courier) ? agreement.courier : null;
    const now = reproBoxAction({ outcome: "confirma", courier, changes: agreement.changes, ...boxFacts(r, courier) });
    if ("action" in now && now.action === stored) {
      out.actionLine = now.label;
      out.newSalida = now.newSalida;
      return out;
    }
    const other = r.boxInputs.otherLiveCourier;
    if ("problem" in now && courier && courier !== "propio" && other && sameCourier(other, courier)) {
      out.actionLine = RETRY_OTHER_SALIDA_EXISTS(agreement.courierName);
      out.chips.push({ tone: "warn", text: RETRY_GF_STILL_LIVE });
      out.otherSalidaExists = true;
      return out;
    }
    out.actionLine = BOX_ACTION_LABEL[stored];
    out.chips.push({ tone: "crit", text: RETRY_FACTS_CHANGED });
    out.critical = true;
    return out;
  }

  // c) Programa sin acuerdo vivo: la tabla, sin cambios declarados (decisión 1).
  if (r.program) {
    const byDefault = reproBoxAction({ outcome: "confirma", courier: "propio", changes: NO_REPRO_CHANGES, ...boxFacts(r, "propio") });
    if ("action" in byDefault) {
      out.action = byDefault.action;
      out.actionSource = "por_defecto";
      out.actionLine = byDefault.label;
      out.newSalida = byDefault.newSalida;
      out.chips.push({ tone: "neutral", text: RETRY_DEFAULT_CHIP });
    } else {
      out.actionLine = byDefault.problem;
      out.defaultProblem = true;
    }
    for (const chip of r.chips) {
      const tone = PASS_THROUGH_CHIPS[chip.key];
      if (tone) out.chips.push({ tone, text: chip.text });
    }
    out.programReason = r.program.reason?.trim() || null;
    if (r.program.origin === "motorizado" || r.program.origin === "repro_lima") {
      out.chips.push({ tone: "warn", text: RETRY_UNCONFIRMED });
      out.unconfirmed = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Apartados y orden
// ---------------------------------------------------------------------------

/** Lo que decide el apartado de una fila. */
export interface RetryGroupFacts {
  box: BoxLocation;
  state: AgreementStateKind;
  /** Una chapa roja que pide parar: no lo quiere, los hechos cambiaron o no consta la caja. */
  critical: boolean;
  unconfirmed: boolean;
  defaultProblem: boolean;
  /** En oficina sin recepción registrada. */
  noReception: boolean;
  /** La dirección cambió después de armar la caja. */
  addressDrift: boolean;
  otherSalidaExists: boolean;
}

/** Los estados del acuerdo que piden a alguien antes de que la caja salga. */
const WARN_STATES: ReadonlySet<AgreementStateKind> = new Set<AgreementStateKind>([
  "otro_courier",
  "falta_salida",
  "falta_ubicar",
  "por_programar",
  "deriva_quitado",
]);

/**
 * El apartado; la primera regla que aplica gana:
 * 1. «Con aviso» con una chapa roja (no lo quiere, los hechos cambiaron, no
 *    consta la caja);
 * 2. «Todavía fuera»: con el motorizado o volviendo con su courier;
 * 3. «Con aviso»: sin confirmar, un estado que pide a alguien, un problema de
 *    la tabla, sin recepción registrada, la dirección cambió o la salida del
 *    otro courier ya existe;
 * 4. «Al anaquel».
 */
export function retryGroup(f: RetryGroupFacts): RetryGroup {
  if (f.critical) return "con_aviso";
  if (f.box.kind === "con_motorizado" || f.box.kind === "volviendo_courier") return "fuera";
  if (f.unconfirmed || WARN_STATES.has(f.state) || f.defaultProblem || f.noReception || f.addressDrift || f.otherSalidaExists) {
    return "con_aviso";
  }
  return "anaquel";
}

/** Lo que hace falta de una fila para ordenarla. */
export interface RetrySortable {
  group: RetryGroup;
  overdue: boolean;
  day: string;
  dayLabel: string;
  orderName: string;
  chips: readonly RetryChip[];
  /** Día de la bandeja (recepción en oficina, hasta 7 días); null sin fecha. */
  trayDay?: string | null;
}

/** Una chapa roja que no es la del vencido: «Con aviso» de la regla 1. */
function isCritical(row: RetrySortable): boolean {
  const overdue = RETRY_OVERDUE(row.dayLabel);
  return row.chips.some((chip) => chip.tone === "crit" && chip.text !== overdue);
}

function groupRank(row: RetrySortable): number {
  if (row.group === "con_aviso") return isCritical(row) ? 0 : 1;
  return row.group === "anaquel" ? 2 : 3;
}

function cmpText(a: string | null | undefined, b: string | null | undefined): number {
  // Lo que no tiene valor va al final.
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * «Con aviso» (lo rojo antes que lo ámbar), «Al anaquel» y «Todavía fuera».
 * Dentro de cada uno: lo vencido primero, lo más antiguo antes; después por
 * bandeja (las sin fecha al final) y por pedido.
 */
export function compareRetries(a: RetrySortable, b: RetrySortable): number {
  return groupRank(a) - groupRank(b) ||
    Number(b.overdue) - Number(a.overdue) ||
    (a.overdue && b.overdue ? cmpText(a.day, b.day) : 0) ||
    cmpText(a.trayDay, b.trayDay) ||
    cmpText(a.orderName, b.orderName);
}

/** Una copia ordenada (no toca la original). */
export function sortRetries<T extends RetrySortable>(rows: readonly T[]): T[] {
  return [...rows].sort(compareRetries);
}

// ---------------------------------------------------------------------------
// La fila
// ---------------------------------------------------------------------------

/** El minuto (Lima) de la última señal de hoy: el programa escrito o el acuerdo decidido. */
function addedTodayMinute(r: ReproRow, today: string): number | null {
  let latest: number | null = null;
  for (const iso of [r.program?.setAt, r.agreement?.decidedAt]) {
    const at = limaStamp(iso);
    if (at && at.day === today && (latest == null || at.minute > latest)) latest = at.minute;
  }
  return latest;
}

/** La bandeja del día de recepción, si es de los últimos 7 días; si no, null («sin fecha»). */
function trayDayOf(receivedAt: string | null, today: string): string | null {
  const at = limaStamp(receivedAt);
  return at && daysBetween(at.day, today) <= TRAY_DAYS ? at.day : null;
}

/**
 * Cuánto después de la recepción puede quedar escrito el programa que la
 * recepción misma escribe (el gancho de «Recibir en oficina» de Repro Lima,
 * lib/repro-lima-program.ts: el evento de recepción va primero y el programa,
 * milisegundos o segundos después).
 */
export const RECEPTION_PROGRAM_WINDOW_MS = 2 * 60_000;

/**
 * La caja tenía su programa al recibirla, y la recepción la mandó al anaquel
 * de su día: el programa ya existía (`setAt <= receivedAt`) o lo escribió la
 * recepción misma (de Repro Lima y hasta 2 minutos después). No basta con que
 * el acuerdo se marcara después de recibirla: una confirmación posterior
 * también lo hace, y esa caja sigue en su bandeja.
 */
export function programmedAtReception(
  program: Pick<NonNullable<ReproRow["program"]>, "setAt" | "origin"> | null | undefined,
  receivedAt: string | null | undefined,
): boolean {
  const received = Date.parse(receivedAt ?? "");
  const programmed = Date.parse(program?.setAt ?? "");
  if (!program || !Number.isFinite(received) || !Number.isFinite(programmed)) return false;
  if (programmed <= received) return true;
  return program.origin === "repro_lima" && programmed - received <= RECEPTION_PROGRAM_WINDOW_MS;
}

/**
 * Dónde debería estar, solo con la caja en oficina: en el anaquel de su día si
 * tenía su programa al recibirla (`programmedAtReception`: la recepción la
 * manda ahí); si no, en la bandeja del día en que se recibió, o en la de «sin
 * fecha / más de 7 días». Lo que se desarma no va al anaquel.
 */
function whereLineOf(r: ReproRow, action: BoxAction | null, dayLabel: string, today: string): string | null {
  if (r.box.kind !== "en_oficina") return null;
  if (action !== "desarmar_cerrar" && programmedAtReception(r.program, r.receivedAt)) {
    return RETRY_ANAQUEL(dayLabel);
  }
  const tray = trayDayOf(r.receivedAt, today);
  return tray ? RETRY_TRAY(programDayLabel(tray)) : RETRY_TRAY_OLD;
}

/** Cuándo cambió la dirección de la salida propia después de armarla, o null. */
function addressChangedAt(own: { addressUpdatedAt: string | null; readyAt: string | null } | undefined): string | null {
  const changed = Date.parse(own?.addressUpdatedAt ?? "");
  const ready = Date.parse(own?.readyAt ?? "");
  return Number.isFinite(changed) && Number.isFinite(ready) && changed > ready ? own!.addressUpdatedAt : null;
}

/**
 * Las filas de Almacén desde las de Repro Lima: solo lo que sale hoy (con lo
 * vencido) o mañana, con su acción, sus chapas, dónde está la caja y su
 * apartado, ya ordenadas. Las chapas son texto armado aquí: la pantalla no
 * calcula nada.
 */
export function warehouseRetryRows(rows: readonly ReproRow[], ctx: RetryContext): WarehouseRetryRow[] {
  const built: Array<WarehouseRetryRow & { trayDay: string | null }> = [];
  for (const r of rows) {
    const when = retryDay(r);
    if (!when) continue;
    const slot = retryBucket(when.day, ctx.today);
    if (!slot) continue;
    const dayLabel = programDayLabel(when.day);
    const act = retryAction(r);
    const chips: RetryChip[] = [];
    if (slot.overdue) chips.push({ tone: "crit", text: RETRY_OVERDUE(dayLabel) });
    chips.push(...act.chips);

    // Sin programa, Despacho GF no la ve en «Programados hoy»: el estado dice por qué.
    if (when.dayFrom === "acuerdo") {
      chips.push({ tone: "warn", text: RETRY_NO_GF_PROGRAM });
      chips.push({ tone: isProblemState(r.state.kind) ? "warn" : "info", text: r.stateLabel });
    } else if (r.state.kind === "deriva_movido" || r.state.kind === "programado_vencido") {
      chips.push({ tone: "info", text: r.stateLabel });
    }

    // Agregado hoy: no estaba en la cuenta de la mañana. Pasado el corte, sale igual hoy.
    const added = addedTodayMinute(r, ctx.today);
    if (added != null) {
      const cutoff = r.cutoff != null ? sameDayCutoffMinute(r.cutoff) : ctx.cutoffMinute;
      chips.push(slot.bucket === "hoy" && added > cutoff
        ? { tone: "warn", text: RETRY_ADDED_LATE(hhmm(added)) }
        : { tone: "info", text: RETRY_ADDED_TODAY(hhmm(added)) });
    }

    const nightBefore = act.action ? NIGHT_BEFORE_BOX_ACTIONS.has(act.action) : false;
    if (nightBefore && slot.bucket === "manana") chips.push({ tone: "warn", text: RETRY_NIGHT_BEFORE_MANANA });
    if (nightBefore && slot.bucket === "hoy" && added != null) chips.push({ tone: "warn", text: RETRY_NIGHT_BEFORE_HOY });

    // Kapta la cuenta en oficina sin que nadie la haya recibido: no se da por puesta.
    const noReception = r.box.kind === "en_oficina" && !r.receivedAt;
    if (noReception && r.box.kind === "en_oficina") {
      chips.push({
        tone: "warn",
        text: isOwnBox(r.box) ? RETRY_NO_RECEPTION_OWN : RETRY_NO_RECEPTION_OTHER(reproCourierName(r.box.courier)),
      });
    }

    // La dirección cambió después de armar: se dice; la acción no cambia (D5).
    const changedAt = r.ownOutput ? addressChangedAt(ctx.ownShipments.get(r.ownOutput.id)) : null;
    const changedDay = limaStamp(changedAt)?.day ?? null;
    const addressDrift = Boolean(changedDay) && act.action !== "reimprimir_misma_salida";
    if (addressDrift && changedDay) chips.push({ tone: "warn", text: RETRY_ADDRESS_CHANGED(ddmm(changedDay)) });

    const unknown = r.box.kind === "desconocida";
    if (unknown) chips.push({ tone: "crit", text: boxLocationLabel(r.box) });

    const inOffice = r.box.kind === "en_oficina";
    // El rótulo de la misma salida: reimprimir, o la caja nueva con la misma salida (E29).
    const confirmed = act.newSalida !== null;
    const printable = act.action === "reimprimir_misma_salida" || (act.action === "caja_nueva_stock" && act.newSalida === false);
    built.push({
      orderId: r.orderId,
      storeId: r.storeId,
      storeName: r.storeName,
      orderName: r.orderName,
      customerName: r.customerName,
      district: r.district,
      bucket: slot.bucket,
      day: when.day,
      dayLabel,
      overdue: slot.overdue,
      dayFrom: when.dayFrom,
      courierName: act.courierName,
      action: act.action,
      actionSource: act.actionSource,
      actionLine: act.actionLine,
      changesText: act.changesText,
      decidedLine: act.decidedLine,
      programReason: act.programReason,
      nightBefore,
      boxLabel: r.boxLabel,
      whereLine: whereLineOf(r, act.action, dayLabel, ctx.today),
      inOffice,
      group: retryGroup({
        box: r.box,
        state: r.state.kind,
        critical: act.critical || unknown,
        unconfirmed: act.unconfirmed,
        defaultProblem: act.defaultProblem,
        noReception,
        addressDrift,
        otherSalidaExists: act.otherSalidaExists,
      }),
      chips,
      label: r.ownOutput && confirmed && printable ? { shipmentId: r.ownOutput.id, code: r.ownOutput.code } : null,
      trayDay: inOffice ? trayDayOf(r.receivedAt, ctx.today) : null,
    });
  }
  return sortRetries(built).map(({ trayDay: _trayDay, ...row }) => row);
}

/** Las cifras de las dos zonas: solo filas de la etapa (los de «Por armar» no cuentan). */
export function retryCounts(rows: readonly Pick<WarehouseRetryRow, "bucket" | "inOffice" | "nightBefore">[]): WarehouseRetriesData["counts"] {
  let hoy = 0;
  let manana = 0;
  let hoyEnOficina = 0;
  let mananaNoche = 0;
  for (const row of rows) {
    if (row.bucket === "hoy") {
      hoy += 1;
      if (row.inOffice) hoyEnOficina += 1;
    } else {
      manana += 1;
      if (row.nightBefore) mananaNoche += 1;
    }
  }
  return { hoy, manana, hoyEnOficina, hoyFuera: hoy - hoyEnOficina, mananaNoche };
}

/** La respuesta sin filas (sin candidatos, o con `error`). */
export function emptyWarehouseRetries(input: { today: string; nowIso: string; cutoffLabel?: string; error?: string }): WarehouseRetriesData {
  return {
    today: input.today,
    nowIso: input.nowIso,
    cutoffLabel: input.cutoffLabel ?? sameDayCutoffLabel(null),
    rows: [],
    handoffs: [],
    counts: { hoy: 0, manana: 0, hoyEnOficina: 0, hoyFuera: 0, mananaNoche: 0 },
    omitted: 0,
    showStore: false,
    ...(input.error ? { error: input.error } : {}),
  };
}

/** El tope de rótulos de una tanda (`/api/pedidos/rotulos`). */
export const RETRY_LABELS_MAX = 200;

/** «Imprimir rótulo» de una o varias salidas: la misma lectura por RLS de siempre. */
export function retryLabelsHref(shipmentIds: readonly string[]): string {
  const ids = [...new Set(shipmentIds.filter(Boolean))].slice(0, RETRY_LABELS_MAX);
  return `/api/pedidos/rotulos?ids=${ids.join(",")}`;
}

// ---------------------------------------------------------------------------
// Ya en «Por armar»
// ---------------------------------------------------------------------------

/** Las acciones cuya salida nueva saca el pedido de la etapa y lo manda a «Por armar». */
export type HandoffBoxAction = "salida_nueva_rearmar" | "desarmar_rearmar" | "caja_nueva_stock";
export const HANDOFF_BOX_ACTIONS: readonly HandoffBoxAction[] = ["salida_nueva_rearmar", "desarmar_rearmar", "caja_nueva_stock"];

export function isHandoffBoxAction(value: unknown): value is HandoffBoxAction {
  return typeof value === "string" && (HANDOFF_BOX_ACTIONS as readonly string[]).includes(value);
}

/** Qué se hace con la caja del estante cuando la salida nueva ya está en «Por armar». */
export function handoffLine(action: HandoffBoxAction, agreedCourier: string | null | undefined): string {
  switch (action) {
    case "salida_nueva_rearmar":
      return sameCourier(agreedCourier, "propio") ? HANDOFF_LINE_GF : HANDOFF_LINE_OTHER(reproCourierName(agreedCourier));
    case "desarmar_rearmar":
      return HANDOFF_LINE_DESARMAR;
    case "caja_nueva_stock":
      return HANDOFF_LINE_CAJA_NUEVA;
  }
}

/** Una salida del pedido, con lo que hace falta para hallar la nueva. */
export interface HandoffShipment {
  id: string;
  order_id: string | null;
  courier: string | null;
  output_code: string | null;
  output_number: number | null;
  preparation_state: string | null;
  ready_at: string | null;
  created_at: string | null;
  delivery_status: string | null;
}

/**
 * La salida nueva del acuerdo: la de consecutivo más alto que nació después de
 * decidir y no se entregó. El caso no guarda su salida: si nada cuadra, null
 * (la fila sale sin código, no se adivina).
 */
export function handoffSalida(shipments: readonly HandoffShipment[], decidedAt: string | null): WarehouseHandoffRow["salida"] {
  const since = Date.parse(decidedAt ?? "");
  if (!Number.isFinite(since)) return null;
  let best: HandoffShipment | null = null;
  for (const shipment of shipments) {
    if (shipment.delivery_status === "entregado") continue;
    const born = Date.parse(shipment.created_at ?? "");
    if (!Number.isFinite(born) || born <= since) continue;
    if (!best || (shipment.output_number ?? 0) > (best.output_number ?? 0)) best = shipment;
  }
  return best
    ? { code: best.output_code ?? null, armed: best.preparation_state === "listo_despacho", readyAt: best.ready_at ?? null }
    : null;
}

/** «Falta armarla · KP1-S03» o «Armada 10:12 · KP1-S03». */
export function handoffSalidaLine(salida: WarehouseHandoffRow["salida"]): string | null {
  if (!salida) return null;
  const code = salida.code ? ` · ${salida.code}` : "";
  if (!salida.armed) return `Falta armarla${code}`;
  const at = limaStamp(salida.readyAt);
  return `Armada${at ? ` ${hhmm(at.minute)}` : ""}${code}`;
}

/**
 * La fila de un acuerdo que ya está en «Por armar». El día es el del programa
 * vigente si lo hay, sea cual sea su fecha; si no, el acordado. Lo de después
 * de mañana no se lista, tampoco si Grupo GF lo movió para después.
 * La acción es la guardada: aquí no se recalcula, porque fuera de la etapa los
 * hechos de la salida propia ya no se leen igual.
 */
export function warehouseHandoffRow(input: {
  caseRow: { order_id: string; agreed_on: string | null; agreed_courier: string | null; box_action: string | null; decided_at: string | null };
  order: { order_name: string | null; customer_name: string | null; district: string | null };
  storeName: string;
  /** El día del programa vigente de Grupo GF (YYYY-MM-DD), o null. */
  programDay: string | null;
  shipments: readonly HandoffShipment[];
  today: string;
}): WarehouseHandoffRow | null {
  const c = input.caseRow;
  if (!isHandoffBoxAction(c.box_action) || !c.agreed_on) return null;
  const day = (input.programDay ?? c.agreed_on).slice(0, 10);
  const slot = retryBucket(day, input.today);
  if (!slot) return null;
  return {
    orderId: c.order_id,
    orderName: input.order.order_name ?? "Pedido sin código",
    storeName: input.storeName,
    customerName: input.order.customer_name ?? "Cliente sin nombre",
    district: input.order.district,
    bucket: slot.bucket,
    day,
    dayLabel: programDayLabel(day),
    overdue: slot.overdue,
    action: c.box_action,
    courierName: reproCourierName(c.agreed_courier),
    line: handoffLine(c.box_action, c.agreed_courier),
    salida: handoffSalida(input.shipments, c.decided_at),
  };
}

/** Por día (lo vencido primero) y por pedido. */
export function sortHandoffs<T extends Pick<WarehouseHandoffRow, "day" | "orderName">>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => cmpText(a.day, b.day) || cmpText(a.orderName, b.orderName));
}
