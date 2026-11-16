// Guía Aliclik y Swayp del día programado en Lima (owner, 16-11-2026; MOM §9.5,
// §6.2 y §40).
//
// POR QUÉ. Desde el 16-11-2026 Repro Lima programa en lote con un courier
// («con un botón ya lo dejamos programados exactamente para un courier»). Con
// GF Courier la guía queda creada al programar; con Aliclik o Swayp quedaba
// programado y la guía dependía de que alguien se acordara de crearla ese día.
// El owner eligió «Kapta la crea ese día».
//
// QUÉ HACE. En las pasadas de la mañana (8:00, 10:00 y 12:00 de Lima) crea la
// guía de Aliclik (AUTOECOM si se puede) de lo de Lima programado para HOY con
// Aliclik: el «Programar envío» con courier (`order_master.dispatch_courier`,
// 0348) y el acuerdo de Repro Lima (`lima_repro_cases.agreed_courier`). Swayp
// arma su ruta el día anterior (`agreementDateProblem`), así que su guía se crea
// la víspera, en las mismas pasadas y en la de las 15:00, con la fecha de
// despacho programada.
//
// QUÉ NO HACE. No toca lo que ya tiene guía de ese courier, ni lo que no es de
// Lima, ni un acuerdo de otro episodio. No levanta compuertas: lo que una
// compuerta frena (pago exigido, la ubicación, la caja que no volvió) falla,
// deja el hecho en el historial y avisa por Telegram de ESE pedido. Un intento
// por pedido y día: lo que falló lo toma una persona.
//
// Pura: lo que lee la base y llama a los couriers vive en
// lib/lima-courier-auto-server.ts.

import { RETRY_MODE_LABEL, isRetryMode, type RetryMode } from "@/lib/lima-retry-auto";
import { isSwaypDispatchDay } from "@/lib/swayp-dispatch-days";
import { programDayLabel } from "@/lib/dispatch-day";
import { classifyOperation } from "@/lib/order-macro-stage";
import { escapeHtml } from "@/lib/telegram";
import type { OrderMasterRow } from "@/lib/types";

/** El hecho que deja un intento fallido. Es también lo que impide repetirlo ese día. */
export const LIMA_COURIER_AUTO_FAILED = "lima_courier_auto_failed";
export const LIMA_COURIER_AUTO_POLICY = "lima-courier-auto-v1";

export type LimaAutoCourier = "aliclik" | "fenix";
export const LIMA_AUTO_COURIERS: readonly LimaAutoCourier[] = ["aliclik", "fenix"];
export const LIMA_AUTO_COURIER_LABEL: Record<LimaAutoCourier, string> = { aliclik: "Aliclik", fenix: "Swayp" };

export function isLimaAutoCourier(value: unknown): value is LimaAutoCourier {
  return value === "aliclik" || value === "fenix";
}

/**
 * Las pasadas, en hora de Lima (`0 13,15,17,20 * * *` en vercel.json; Lima es
 * UTC−5 todo el año): 8:00, 10:00 y 12:00 para Aliclik, antes de su corte, y
 * además 15:00 para Swayp, que necesita la guía la víspera. Varias y no una: lo
 * que se programa a media mañana también entra.
 */
export const LIMA_COURIER_AUTO_PASS_HOURS_LIMA = [8, 10, 12, 15] as const;
const ALICLIK_LAST_HOUR = 12;

/** ¿Es hora de una pasada que crea? De 8:00 a 15:59 de Lima. Fuera de eso, solo la simulación a mano (`?dry=1`). */
export function limaCourierAutoPassOpen(limaHour: number): boolean {
  return limaHour >= LIMA_COURIER_AUTO_PASS_HOURS_LIMA[0] && limaHour <= LIMA_COURIER_AUTO_PASS_HOURS_LIMA[3];
}

/** ¿Esta pasada atiende a ese courier? Aliclik hasta las 12:59 (después, su recojo es de mañana); Swayp, todas. */
export function limaCourierServes(courier: LimaAutoCourier, limaHour: number): boolean {
  if (!limaCourierAutoPassOpen(limaHour)) return false;
  return courier === "fenix" || limaHour <= ALICLIK_LAST_HOUR;
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * El día de despacho que atiende la pasada de hoy, por courier: Aliclik, hoy;
 * Swayp, su próximo día de despacho después de hoy (de lunes a sábado). Pura.
 */
export function limaCourierTargetDay(courier: LimaAutoCourier, today: string): string {
  if (courier === "aliclik") return today;
  let day = shiftDay(today, 1);
  while (!isSwaypDispatchDay(day)) day = shiftDay(day, 1);
  return day;
}

/** Apagado / Simulación / Activo: las mismas tres posiciones que el resto del panel. */
export type LimaCourierAutoMode = RetryMode;
export const LIMA_COURIER_AUTO_MODE_LABEL = RETRY_MODE_LABEL;

/** La posición guardada; sin fila, sin la 0349 o con un valor raro, Apagado. */
export function limaCourierAutoModeFrom(value: unknown): LimaCourierAutoMode {
  return isRetryMode(value) ? value : "apagado";
}

export type LimaCourierEnvioRow = Pick<
  OrderMasterRow,
  | "dispatch_scheduled_on"
  | "dispatch_courier"
  | "macro_stage"
  | "macro_substage"
  | "shipping_mode"
  | "coverage"
  | "region"
  | "province"
  | "district"
>;

/**
 * Con qué courier la pasada de hoy crea la guía de un «Programar envío», o
 * null: en Preparación · Por generar rótulo, de Lima, programado con Aliclik
 * para hoy o con Swayp para su próximo día de despacho. Pura.
 */
export function limaCourierEnvioCourier(row: LimaCourierEnvioRow, today: string): LimaAutoCourier | null {
  if (!isLimaAutoCourier(row.dispatch_courier)) return null;
  if (row.macro_stage !== "preparacion" || row.macro_substage !== "por_generar_rotulo") return null;
  if (classifyOperation(row) !== "lima") return null;
  return row.dispatch_scheduled_on === limaCourierTargetDay(row.dispatch_courier, today) ? row.dispatch_courier : null;
}

/** Lo de un caso de Repro Lima que hace falta para saber si la pasada lo toma. */
export interface LimaCourierCase {
  id: string;
  order_id: string;
  agreed_on: string | null;
  agreed_courier: string | null;
  agreement_call_id: string | null;
  closed_at: string | null;
}

/** Con qué courier la pasada de hoy crea la guía de un acuerdo de Repro Lima, o null. Pura. */
export function limaCourierCaseCourier(c: LimaCourierCase, today: string): LimaAutoCourier | null {
  if (c.closed_at || !c.agreement_call_id || !c.agreed_on || !isLimaAutoCourier(c.agreed_courier)) return null;
  return c.agreed_on.slice(0, 10) === limaCourierTargetDay(c.agreed_courier, today) ? c.agreed_courier : null;
}

type EventLike = { kind: string; payload?: unknown };

/** ¿Ya lo intentó hoy y falló? Entonces es de una persona hasta mañana. */
export function limaCourierTriedOn(events: readonly EventLike[], today: string): boolean {
  return events.some((e) => e.kind === LIMA_COURIER_AUTO_FAILED && (e.payload as { date?: unknown } | null | undefined)?.date === today);
}

/** El motivo que queda en la guía: quién la pidió y para qué día. */
export function limaCourierReason(courier: LimaAutoCourier, day: string, origin: "envio" | "acuerdo"): string {
  const from = origin === "acuerdo" ? "acuerdo de Repro Lima" : "envío programado";
  return `Guía ${LIMA_AUTO_COURIER_LABEL[courier]} automática del ${programDayLabel(day)} (${from}).`;
}

/**
 * El motivo de la salida adicional en Lima, cuando el pedido ya tuvo otra: lo
 * escribe la regla que el owner encendió, y el texto lo dice (como el
 * reintento de Lima, `MOTIVE_ORIGIN_KINDS`).
 */
export function limaCourierMotive(courier: LimaAutoCourier, day: string, origin: "envio" | "acuerdo"): string {
  return origin === "acuerdo"
    ? `Acuerdo de Repro Lima: sale el ${programDayLabel(day)} con ${LIMA_AUTO_COURIER_LABEL[courier]} (guía automática del día programado).`
    : `Programado para el ${programDayLabel(day)} con ${LIMA_AUTO_COURIER_LABEL[courier]} desde Repro Lima (guía automática del día programado).`;
}

export const LIMA_COURIER_AUTO_OUTCOMES = ["simulada", "creada", "fallo", "en_curso"] as const;
export type LimaCourierAutoOutcome = (typeof LIMA_COURIER_AUTO_OUTCOMES)[number];

export function isLimaCourierAutoOutcome(value: unknown): value is LimaCourierAutoOutcome {
  return typeof value === "string" && (LIMA_COURIER_AUTO_OUTCOMES as readonly string[]).includes(value);
}

export const LIMA_COURIER_AUTO_OUTCOME_LABEL: Record<LimaCourierAutoOutcome, string> = {
  simulada: "Habría creado la guía",
  creada: "Guía creada",
  fallo: "No se pudo crear",
  en_curso: "Creándose: se mira en la pasada siguiente",
};

/** En Simulación, `fallo` es lo que Activo haría: no la crearía. */
export function limaCourierAutoOutcomeLabel(outcome: LimaCourierAutoOutcome, mode: "simulacion" | "activo"): string {
  return mode === "simulacion" && outcome === "fallo" ? "No la crearía" : LIMA_COURIER_AUTO_OUTCOME_LABEL[outcome];
}

/**
 * Por qué Activo no crearía nada, o null (§40): sin la escritura de Aliclik ni
 * la integración de Swayp en el servidor, no hay con qué crear. Con una sola,
 * corre con esa y lo del otro courier falla con su motivo.
 */
export function limaCourierAutoActivoBlocker(input: { aliclikWrite: boolean; swaypEnabled: boolean }): string | null {
  if (!input.aliclikWrite && !input.swaypEnabled) {
    return "Aliclik (ALICLIK_WRITE_ENABLED) y Swayp están apagados en el servidor: no se crea ninguna guía.";
  }
  return null;
}

/** Lo que queda en el historial del pedido cuando no se pudo. */
export function limaCourierFailedNote(courier: LimaAutoCourier, day: string): string {
  return `No se pudo crear la guía ${LIMA_AUTO_COURIER_LABEL[courier]} automática del ${programDayLabel(day)}. Hoy no se vuelve a intentar: créala a mano desde la Mesa de ruta.`;
}

/** Cuánto del motivo cabe en la alerta. El resto está en el historial del pedido. */
const ALERT_REASON_MAX = 600;

/** La alerta de Telegram de un pedido que no salió. */
export function limaCourierFailureTelegram(input: {
  storeName: string;
  orderName: string | null;
  customerName: string | null;
  district: string | null;
  courier: LimaAutoCourier;
  day: string;
  error: string;
  url: string;
}): string {
  const reason = input.error.length > ALERT_REASON_MAX ? `${input.error.slice(0, ALERT_REASON_MAX - 1)}…` : input.error;
  const who = [input.customerName, input.district].filter(Boolean).join(" · ");
  return [
    `⚠️ <b>Guía ${escapeHtml(LIMA_AUTO_COURIER_LABEL[input.courier])} automática no creada</b> · ${escapeHtml(input.storeName)}`,
    `${escapeHtml(input.orderName ?? "Pedido")}${who ? ` · ${escapeHtml(who)}` : ""}`,
    `Programado para el ${escapeHtml(programDayLabel(input.day))}.`,
    `Motivo: ${escapeHtml(reason)}`,
    `Créala a mano desde la Mesa de ruta: ${escapeHtml(input.url)}`,
  ].join("\n");
}
