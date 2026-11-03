// Guía Aliclik automática el día programado (MOM §6.2, 16-10-2026, pedido de
// Frankz).
//
// POR QUÉ. «Programar envío» dejó escrito el día acordado con la clienta, pero
// la guía seguía dependiendo de que alguien se acordara de crearla ese día. Un
// pedido de provincia programado para el lunes es exactamente uno que se olvida
// el lunes.
//
// QUÉ HACE. Cada hora de 8:00 a 13:00 de Lima —antes del corte de Aliclik, para
// que lo recojan ese mismo día— crea la guía de los pedidos de Provincia COD que
// están en Preparación · Por generar rótulo con fecha programada para HOY. Por
// el mismo camino que el botón (lib/aliclik-guide.ts) y con la transportadora
// que el panel preselecciona: la más barata de las que se pueden agendar.
//
// QUÉ NO HACE. No toca un pedido sin fecha programada, ni uno de Lima o Agencia,
// ni uno cuya fecha es otro día. No escribe motivos por nadie: si una compuerta
// pide una excepción (pago exigido por el historial, pin dudoso), el automático
// no la levanta. Falla, deja el hecho en el historial del pedido y avisa por
// Telegram de ESE pedido. Un intento por pedido y fecha: lo que falló lo toma
// una persona.
//
// Pura: lo que lee la base y llama a Aliclik vive en lib/aliclik-scheduled-server.ts.

import { classifyOperation } from "@/lib/order-macro-stage";
import { dispatchDateLabel } from "@/lib/dispatch-date";
import { limaDayKey } from "@/lib/order-confirmation";
import { escapeHtml } from "@/lib/telegram";
import type { OrderMasterRow } from "@/lib/types";

/** Lo que se le dice a quien programa un pedido de Provincia COD. */
export const AUTO_GUIDE_HINT =
  "Si sale otro día, ese día Kapta crea sola la guía Aliclik (8:00 a. m. a 1:00 p. m.), salvo que vaya por Shalom o tenga un pago registrado. Si no puede, avisa por Telegram.";

/** El hecho que deja un intento fallido. Es también lo que impide repetirlo. */
export const ALICLIK_AUTO_FAILED = "aliclik_auto_guide_failed";
export const ALICLIK_AUTO_POLICY = "aliclik-programado-v1";
/**
 * Las pasadas: cada hora de 8:00 a 13:00 de Lima (13–18 UTC en vercel.json),
 * todas antes del corte de Aliclik (~14:00) para que lo recojan ese mismo día.
 * Varias y no una: un pedido programado para hoy a media mañana también entra.
 */
export const FIRST_PASS_HOUR_LIMA = 8;
export const LAST_PASS_HOUR_LIMA = 13;
/** Cuánto del motivo cabe en la alerta. El resto está en el historial del pedido. */
const ALERT_REASON_MAX = 600;

export type ScheduledRow = Pick<
  OrderMasterRow,
  | "dispatch_scheduled_on"
  | "macro_stage"
  | "macro_substage"
  | "shipping_mode"
  | "coverage"
  | "region"
  | "province"
  | "district"
>;

export type ScheduledSkip = "otro_dia" | "otra_etapa" | "no_provincia_cod";

/** Por qué este pedido no entra a la pasada de hoy, o null si entra. */
export function scheduledSkip(row: ScheduledRow, todayLima: string): ScheduledSkip | null {
  if (!row.dispatch_scheduled_on || row.dispatch_scheduled_on !== todayLima) return "otro_dia";
  if (row.macro_stage !== "preparacion" || row.macro_substage !== "por_generar_rotulo") return "otra_etapa";
  if (classifyOperation(row) !== "provincia_cod") return "no_provincia_cod";
  return null;
}

export type ScheduledHold = "shalom" | "con_pago" | "programado_hoy";

/** Los estados de cobro que no dicen nada de la ruta: sin pagos registrados. */
const NO_PAYMENT = new Set(["", "sin_pago"]);

/**
 * Por qué este pedido es de una persona y no del automático, o null.
 *
 * INCIDENTE DEL 18 Y 19-10-2026. El automático creó guías Aliclik a cinco
 * pedidos que el equipo estaba mandando por Shalom (#KP142443, #KP140883,
 * #KP142598, #KP142667, #KP142743). Ninguno era Agencia para el Master —el
 * desplegable del checkout decía contraentrega—, pero las tres señales estaban:
 *   - «DNI y agencia Shalom» guardado (`shalom_order_drafts`): la asesora ya
 *     eligió Shalom. Cuatro de los cinco.
 *   - un pago registrado (adelanto cargado o validado, o pagado): en Provincia
 *     COD el adelanto es de Agencia o de un cliente con historial, y en los dos
 *     casos decide una persona — Aliclik además cobraría el total en la puerta
 *     aunque ya se adelantó. Cuatro de los cinco.
 *   - la fecha se acordó HOY, al confirmar: la asesora está con el pedido en
 *     la mano y lo va a despachar ella. #KP142443 se confirmó a la 1:05 p. m.
 *     con «Sale el» hoy; la pasada de la 1:07 le creó la guía y el Shalom se
 *     guardó a la 1:20.
 * El automático es para lo que se acordó OTRO día y quedó esperando su fecha.
 */
export function scheduledHold(input: {
  hasShalomDraft: boolean;
  paymentState: string | null | undefined;
  /** Cuándo se programó la fecha vigente (el `dispatch_date_set` que manda). */
  scheduledAt: string | null | undefined;
  todayLima: string;
}): ScheduledHold | null {
  if (input.hasShalomDraft) return "shalom";
  if (!NO_PAYMENT.has((input.paymentState ?? "").trim())) return "con_pago";
  if (!input.scheduledAt || limaDayKey(input.scheduledAt) >= input.todayLima) return "programado_hoy";
  return null;
}

/**
 * La transportadora del automático: la más barata de las que se pueden agendar
 * ahora. Es la que el panel preselecciona y la que la asesora elige casi siempre
 * (components/aliclik-guide-panel.tsx).
 */
export function autoTransport<T extends { selectable: boolean; deliveryCost: number }>(
  couriers: readonly T[] | null | undefined,
): T | null {
  return [...(couriers ?? [])].filter((c) => c.selectable).sort((a, b) => a.deliveryCost - b.deliveryCost)[0] ?? null;
}

/**
 * ¿Esperar a la pasada siguiente? Con Aliclik en rojo —la sonda de cotización
 * falla o las últimas creaciones fallaron— cada pedido fallaría por lo mismo y
 * avisaría por separado. Se espera, sin avisar, salvo en la última pasada del
 * día: ahí se intenta igual y lo que falle avisa, porque ya no hay otra.
 */
export function waitForAliclik(
  health: { quote: string; create: string },
  limaHour: number,
): boolean {
  if (limaHour >= LAST_PASS_HOUR_LIMA) return false;
  return health.quote === "fallos" || health.create === "degradado";
}

type EventLike = { kind: string; payload?: unknown };

/** ¿El automático ya lo intentó para esta fecha? Si falló, ya no es suyo. */
export function triedOn(events: readonly EventLike[], date: string): boolean {
  return events.some(
    (event) =>
      event.kind === ALICLIK_AUTO_FAILED && (event.payload as { date?: unknown } | null | undefined)?.date === date,
  );
}

/** El motivo del hecho `guide_registered` de una guía automática. */
export function autoGuideReason(date: string): string {
  return `Guía automática: envío programado para el ${dispatchDateLabel(date)}.`;
}

/** La alerta de Telegram de UN pedido cuya guía automática no se pudo crear. */
export function scheduledFailureTelegram(input: {
  storeName: string;
  orderName: string | null;
  customerName: string | null;
  place: string | null;
  date: string;
  error: string;
  url: string;
}): string {
  const reason =
    input.error.length > ALERT_REASON_MAX ? `${input.error.slice(0, ALERT_REASON_MAX - 1)}…` : input.error;
  const who = [input.customerName, input.place].filter(Boolean).join(" · ");
  return [
    `⚠️ <b>${escapeHtml(input.storeName)}</b> · guía Aliclik programada no creada`,
    `<b>${escapeHtml(input.orderName ?? "Pedido sin número")}</b>${who ? ` · ${escapeHtml(who)}` : ""}`,
    `Programado para hoy, ${escapeHtml(dispatchDateLabel(input.date))}.`,
    "",
    `Motivo: ${escapeHtml(reason)}`,
    "",
    "Créala a mano o reprográmala:",
    escapeHtml(input.url),
  ].join("\n");
}
