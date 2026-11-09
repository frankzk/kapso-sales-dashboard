// «Pago solo online (lista automática)» — la regla, pura (MOM §41.11, pedido
// de las tiendas del 09-11-2026, docs/kapta/pago-solo-online.md).
//
// QUÉ DECIDIÓ EL OWNER.
//   * Un cliente es su celular: los ÚLTIMOS 9 DÍGITOS, con el historial de
//     Kenku y Aurela juntos (la organización), TODO el historial y solo los
//     pedidos contra entrega (`coverage` = `lima` o `provincia_cod`).
//   * Entra a la lista si tiene al menos UNA entrega fallida —`devuelto`, o
//     `anulado` después de salir (`dispatched_at` con fecha)— y NINGUNA
//     recibida (`entregado`). Un anulado antes de salir no es una falla.
//   * Kapta calcula la lista una vez al día (05:00 de Lima), la manda entera a
//     cada tienda (cada envío la reemplaza) y la usa como freno en sus propios
//     pedidos (Kapta, Chatby, el bot, las asesoras).
//   * En los pedidos de Kapta, el cliente de la lista paga un ADELANTO
//     (decisión del owner del 09-11-2026, «Adelanto (regla §8)»), con la
//     opción de cambiarlo a «Pago completo» en Automatizaciones.
//
// La consulta SQL de la 0326 (`pago_online_compute`) es la que corre de
// verdad; `pagoOnlineListOf` es la misma regla en TypeScript, para las pruebas
// y para que la definición se lea en un solo sitio.
//
// Puro: sin base ni red. NADA de aquí escribe un celular en un texto que salga
// de Kapta: los mensajes de alerta y los resúmenes llevan solo cuentas.

import { orderFullyPaid, type OrderPaymentFacts } from "@/lib/order-paid";
import { ADELANTO_MINIMO_LABEL } from "@/lib/adelanto-minimo";

/** Cómo se llama en pantalla. */
export const PAGO_ONLINE_LABEL = "Pago solo online (lista automática)";
/** La clave del catálogo y del historial (`automation_switch_events.automation`). */
export const PAGO_ONLINE_KEY = "pago_solo_online";
/** La clave del historial del ajuste «qué se cobra». */
export const PAGO_ONLINE_REQUIREMENT_KEY = "pago_solo_online_cobro";

/** Lo que dice la ficha del pedido (pedido de la coordinación, 09-11-2026). */
export const PAGO_ONLINE_HEADLINE = "Cliente con entrega fallida y ninguna recibida: solo pago online o adelanto";

/** La ruta de COD Core en cada tienda (docs/kapta/pago-solo-online.md §4). */
export const COD_CORE_API_PREFIX = "/wp-json/cod-core/v1";
export const PAGO_ONLINE_ENDPOINT_PATH = "/pago-solo-online";

/** Los topes de la tienda (§4.2): más de esto responde 413. */
export const PAGO_ONLINE_MAX_PHONES = 50_000;
export const PAGO_ONLINE_MAX_EMAILS = 50_000;

/** Reintentos (§4.3): 1, 5 y 15 minutos después de cada intento fallido. */
export const PAGO_ONLINE_RETRY_DELAYS_MIN: readonly number[] = [1, 5, 15];
/** El primer envío más los tres reintentos. */
export const PAGO_ONLINE_MAX_ATTEMPTS = PAGO_ONLINE_RETRY_DELAYS_MIN.length + 1;

/** El freno de cambio brusco (§4.5): más del doble o menos de la mitad. */
export const PAGO_ONLINE_GUARD_FACTOR = 2;

/** Cuántos días se guardan los celulares de una corrida que ya no es la vigente. */
export const PAGO_ONLINE_KEEP_DAYS = 7;

/** El motivo de una excepción de Kapta: el mismo mínimo que la lista de pago adelantado. */
export const PAGO_ONLINE_REASON_MIN = 8;
export const PAGO_ONLINE_REASON_MAX = 500;

// ── El celular ──────────────────────────────────────────────────────────────

/**
 * La llave del cliente: los últimos 9 dígitos del celular, como la tienda
 * (§2: «da igual si vienen con 51, +51 o espacios»). Con menos de 9 dígitos no
 * hay cliente: null. Es `right(regexp_replace(phone, '\D', '', 'g'), 9)` de la
 * consulta de referencia, con su `length = 9`. Pura.
 */
export function pagoOnlinePhoneKey(raw: string | null | undefined): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 9) return null;
  return digits.slice(-9);
}

/** «••• ••• 321»: lo único que se muestra de un celular de la lista o de una excepción. Pura. */
export function pagoOnlineMaskedPhone(phone9: string | null | undefined): string {
  const p = String(phone9 ?? "");
  return p.length === 9 ? `••• ••• ${p.slice(6)}` : "•••";
}

// ── La regla ────────────────────────────────────────────────────────────────

/** Las coberturas contra entrega: las únicas que cuentan (§2). */
export const PAGO_ONLINE_COD_COVERAGES: readonly string[] = ["lima", "provincia_cod"];

/** Lo que la regla mira de cada pedido (`order_master`). */
export interface PagoOnlineOrderFact {
  customer_phone: string | null;
  coverage: string | null;
  general_status: string | null;
  dispatched_at: string | null;
}

/** ¿El pedido cuenta para la regla? Solo contra entrega. Pura. */
export function isCodOrder(o: Pick<PagoOnlineOrderFact, "coverage">): boolean {
  return PAGO_ONLINE_COD_COVERAGES.includes((o.coverage ?? "").trim());
}

/** ¿Es una entrega fallida? `devuelto`, o `anulado` con fecha de salida. Pura. */
export function isFailedDelivery(o: Pick<PagoOnlineOrderFact, "general_status" | "dispatched_at">): boolean {
  const s = (o.general_status ?? "").trim();
  if (s === "devuelto") return true;
  return s === "anulado" && !!o.dispatched_at;
}

/** ¿Es una entrega recibida? Pura. */
export function isReceivedDelivery(o: Pick<PagoOnlineOrderFact, "general_status">): boolean {
  return (o.general_status ?? "").trim() === "entregado";
}

/** La regla sobre las cuentas de un cliente: 1+ fallida y 0 recibidas. Pura. */
export function pagoOnlineListed(counts: { failed: number; received: number }): boolean {
  return counts.failed >= 1 && counts.received === 0;
}

export interface PagoOnlineListItem {
  phone: string;
  failed: number;
}

/**
 * La lista de una organización, desde sus pedidos: los celulares (9 dígitos)
 * que cumplen la regla, sin los exceptuados por Kapta, ordenados. Es la misma
 * regla de `pago_online_compute` (0326). Pura.
 */
export function pagoOnlineListOf(orders: readonly PagoOnlineOrderFact[], exceptions: ReadonlySet<string> = new Set()): PagoOnlineListItem[] {
  const byPhone = new Map<string, { failed: number; received: number }>();
  for (const o of orders) {
    if (!isCodOrder(o)) continue;
    const phone = pagoOnlinePhoneKey(o.customer_phone);
    if (!phone) continue;
    const c = byPhone.get(phone) ?? { failed: 0, received: 0 };
    if (isFailedDelivery(o)) c.failed++;
    if (isReceivedDelivery(o)) c.received++;
    byPhone.set(phone, c);
  }
  return [...byPhone]
    .filter(([phone, c]) => pagoOnlineListed(c) && !exceptions.has(phone))
    .map(([phone, c]) => ({ phone, failed: c.failed }))
    .sort((a, b) => a.phone.localeCompare(b.phone));
}

/** Un correo que se puede mandar: en minúsculas, con arroba y dominio. Null si no sirve. Pura. */
export function pagoOnlineEmailKey(raw: string | null | undefined): string | null {
  const e = String(raw ?? "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 254 ? e : null;
}

/**
 * Los correos que van con la lista (§3.2, opcional): solo los de un celular
 * de la lista, y solo si ese correo aparece con UN solo celular en los pedidos
 * de la organización. Un correo compartido (la familia, el de una asesora)
 * bloquearía a alguien que no está en la lista. Pura.
 */
export function pagoOnlineEmailsOf(
  rows: readonly { customer_phone: string | null; email: string | null }[],
  listed: ReadonlySet<string>,
): string[] {
  const phonesOf = new Map<string, Set<string>>();
  for (const r of rows) {
    const email = pagoOnlineEmailKey(r.email);
    const phone = pagoOnlinePhoneKey(r.customer_phone);
    if (!email || !phone) continue;
    phonesOf.set(email, (phonesOf.get(email) ?? new Set()).add(phone));
  }
  return [...phonesOf]
    .filter(([, phones]) => phones.size === 1 && listed.has([...phones][0]!))
    .map(([email]) => email)
    .sort();
}

// ── El envío ────────────────────────────────────────────────────────────────

/** «1+ entrega fallida y 0 recibidas, Kenku Peru y Aurela, calculada 2026-11-10 05:00» (§4.2). Pura. */
export function pagoOnlineRegla(storeNames: readonly string[], computedAt: Date): string {
  const lima = new Date(computedAt.getTime() - 5 * 3_600_000).toISOString();
  const names = storeNames.length <= 1 ? (storeNames[0] ?? "") : `${storeNames.slice(0, -1).join(", ")} y ${storeNames[storeNames.length - 1]}`;
  return `1+ entrega fallida y 0 recibidas, ${names}, calculada ${lima.slice(0, 10)} ${lima.slice(11, 16)}`;
}

export interface PagoOnlinePayload {
  celulares: string[];
  correos: string[];
  regla: string;
}

/** El cuerpo del POST (§4.2): la lista ENTERA, sin repetidos. Pura. */
export function pagoOnlinePayload(phones: readonly string[], emails: readonly string[], regla: string): PagoOnlinePayload {
  return {
    celulares: [...new Set(phones.map(pagoOnlinePhoneKey).filter((p): p is string => !!p))].sort(),
    correos: [...new Set(emails.map(pagoOnlineEmailKey).filter((e): e is string => !!e))].sort(),
    regla,
  };
}

/** Lo que devuelve la tienda (§4.3 y §4.4), sin fiarse de su forma. Pura. */
export interface CodCoreTotals {
  celulares: number | null;
  correos: number | null;
  descartados: number | null;
  actualizado: string | null;
  regla: string | null;
}

export function parseCodCoreTotals(raw: unknown): CodCoreTotals {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);
  return { celulares: n(r.celulares), correos: n(r.correos), descartados: n(r.descartados), actualizado: s(r.actualizado), regla: s(r.regla) };
}

/**
 * En qué terminó UN intento, según la respuesta (§4.3):
 *   * `enviado`: 2xx.
 *   * `sin_endpoint`: 404, la tienda todavía no tiene cod-core 0.10.45. Se
 *     registra y no se reintenta (nada de reintentos en bucle).
 *   * `credenciales`: 401/403. No se reintenta.
 *   * `demasiado_grande`: 413. No se reintenta; se avisa.
 *   * `reintento`: 5xx, tiempo agotado, la red o un 429.
 *   * `rechazado`: otro 4xx, una redirección o una respuesta que no es JSON. No
 *     se reintenta: repetirlo daría lo mismo.
 * Pura.
 */
export type PagoOnlineAttemptOutcome = "enviado" | "sin_endpoint" | "credenciales" | "demasiado_grande" | "reintento" | "rechazado";

export function classifyCodCoreAttempt(input: { status: number | null; kind?: string | null }): PagoOnlineAttemptOutcome {
  const { status } = input;
  const kind = input.kind ?? null;
  if (status != null && status >= 200 && status < 300 && kind == null) return "enviado";
  if (status === 404) return "sin_endpoint";
  if (status === 401 || status === 403) return "credenciales";
  if (status === 413) return "demasiado_grande";
  if (status === 429 || (status != null && status >= 500)) return "reintento";
  if (kind === "tiempo" || kind === "red") return "reintento";
  return "rechazado";
}

/** ¿Este desenlace se vuelve a intentar? Pura. */
export function isRetryableOutcome(outcome: PagoOnlineAttemptOutcome): boolean {
  return outcome === "reintento";
}

/**
 * Cuándo va el próximo intento, o null si ya no hay más: después del intento
 * `attempt` (1 = el primero) que falló con algo reintentable, 1, 5 y 15
 * minutos. Pura.
 */
export function nextRetryAt(attempt: number, outcome: PagoOnlineAttemptOutcome, finishedAt: Date): Date | null {
  if (!isRetryableOutcome(outcome)) return null;
  const delay = PAGO_ONLINE_RETRY_DELAYS_MIN[attempt - 1];
  if (delay == null) return null;
  return new Date(finishedAt.getTime() + delay * 60_000);
}

/** El estado que se guarda en `pago_online_sends.status` (0326). */
export type PagoOnlineSendStatus =
  | "enviando"
  | "enviado"
  | "reintento"
  | "fallido"
  | "sin_endpoint"
  | "credenciales"
  | "demasiado_grande"
  | "freno_cambio"
  | "sin_claves";

/** El estado de la fila según el desenlace y si queda otro intento. Pura. */
export function sendStatusOf(outcome: PagoOnlineAttemptOutcome, hasNext: boolean): PagoOnlineSendStatus {
  if (outcome === "enviado") return "enviado";
  if (outcome === "reintento") return hasNext ? "reintento" : "fallido";
  if (outcome === "rechazado") return "fallido";
  return outcome;
}

export const PAGO_ONLINE_SEND_STATUS_LABEL: Record<PagoOnlineSendStatus, string> = {
  enviando: "Enviando",
  enviado: "Enviada",
  reintento: "Falló; se reintenta",
  fallido: "Falló",
  sin_endpoint: "La tienda todavía no tiene el endpoint (404)",
  credenciales: "La tienda rechazó las claves (401/403)",
  demasiado_grande: "La lista supera el tope de la tienda (413)",
  freno_cambio: "No se mandó: cambio brusco",
  sin_claves: "La tienda no tiene las claves de la API guardadas",
};

/**
 * ¿El día cuenta como fallido para la alerta de «dos días seguidos» (§4.3)?
 * Solo lo que terminó mal de verdad. `sin_endpoint` no: es la tienda que
 * todavía no instaló cod-core 0.10.45 y se sabe. `freno_cambio` y
 * `demasiado_grande` avisan solos, el mismo día. Pura.
 */
export function isFailedDay(status: PagoOnlineSendStatus | null): boolean {
  return status === "fallido" || status === "credenciales" || status === "sin_claves";
}

/**
 * ¿Avisar hoy de esta tienda? Si el último estado de hoy y el del día anterior
 * (los envíos diarios, del más nuevo al más viejo) son fallidos. Pura.
 */
export function shouldAlertTwoDays(dailyFinals: readonly { runDate: string; status: PagoOnlineSendStatus | null }[], today: string): boolean {
  const days = [...dailyFinals].sort((a, b) => b.runDate.localeCompare(a.runDate));
  const t = days.find((d) => d.runDate === today);
  if (!t || !isFailedDay(t.status)) return false;
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const y = days.find((d) => d.runDate === yesterday);
  return !!y && isFailedDay(y.status);
}

// ── El freno de cambio brusco (§4.5) ────────────────────────────────────────

export type PagoOnlineGuard =
  | { ok: true; kind: "primera" | "ok"; baseline: number | null }
  | { ok: false; kind: "bloqueado"; baseline: number; reason: string };

/**
 * ¿Se puede usar la lista nueva? Se compara con la última que se usó (para
 * el freno de Kapta) o la última que se mandó bien (para cada tienda). Sin una
 * anterior (o una anterior vacía), pasa: es la primera. Más del doble o menos
 * de la mitad, no: suele ser un error del cálculo. Pura.
 */
export function pagoOnlineGuard(next: number, baseline: number | null | undefined): PagoOnlineGuard {
  if (baseline == null || !Number.isFinite(baseline) || baseline <= 0) return { ok: true, kind: "primera", baseline: baseline ?? null };
  if (next > baseline * PAGO_ONLINE_GUARD_FACTOR || next * PAGO_ONLINE_GUARD_FACTOR < baseline) {
    const verb = next > baseline ? "más del doble" : "menos de la mitad";
    return {
      ok: false,
      kind: "bloqueado",
      baseline,
      reason: `La lista nueva tiene ${next.toLocaleString("es-PE")} celulares, ${verb} que la anterior (${baseline.toLocaleString("es-PE")}).`,
    };
  }
  return { ok: true, kind: "ok", baseline };
}

// ── Lo que se cobra en los pedidos de Kapta ─────────────────────────────────

export const PAGO_ONLINE_REQUIREMENTS = ["adelanto", "pago_completo"] as const;
export type PagoOnlineRequirement = (typeof PAGO_ONLINE_REQUIREMENTS)[number];
/** Decisión del owner del 09-11-2026: adelanto. */
export const PAGO_ONLINE_DEFAULT_REQUIREMENT: PagoOnlineRequirement = "adelanto";
export const PAGO_ONLINE_REQUIREMENT_LABEL: Record<PagoOnlineRequirement, string> = {
  adelanto: "Adelanto (regla §8)",
  pago_completo: "Pago completo",
};

export function isPagoOnlineRequirement(value: unknown): value is PagoOnlineRequirement {
  return typeof value === "string" && (PAGO_ONLINE_REQUIREMENTS as readonly string[]).includes(value);
}

/** Los estados de cobro que dicen «el adelanto ya está validado» (`aliclikRiskGate`, §8). */
export const ADVANCE_VALIDATED_STATES: readonly string[] = ["adelanto_validado", "diferencia_cargada", "pago_completo"];

/**
 * ¿El pedido cumple lo que se le pide al cliente de la lista? Pura.
 *   * `pago_completo`: `orderFullyPaid`, como la lista de pago adelantado.
 *   * `adelanto`: el adelanto validado de la escalera del §8 (S/ 20,
 *     `ADELANTO_MINIMO`) o el pago completo. No es un estado nuevo: es el
 *     mismo `payment_state` que mira `aliclikRiskGate`.
 */
export function pagoOnlineRequirementMet(requirement: PagoOnlineRequirement, facts: OrderPaymentFacts): boolean {
  if (orderFullyPaid(facts)) return true;
  if (requirement === "pago_completo") return false;
  return ADVANCE_VALIDATED_STATES.includes(facts.paymentState ?? "");
}

export type PagoOnlineBrake =
  | { state: "ok"; listed: false }
  | { state: "ok"; listed: true; met: true }
  | { state: "blocked"; listed: true; met: false; message: string };

export type PagoOnlinePoint = "confirmar" | "guia";

/** El mensaje del freno, sin ningún dato de otros clientes. Pura. */
export function pagoOnlineBlockMessage(point: PagoOnlinePoint, requirement: PagoOnlineRequirement, failed: number | null): string {
  const counts = failed && failed > 0 ? ` (${failed} ${failed === 1 ? "entrega fallida" : "entregas fallidas"}, 0 recibidas)` : "";
  const head = `${PAGO_ONLINE_HEADLINE}${counts}.`;
  const what = requirement === "adelanto" ? `el adelanto de ${ADELANTO_MINIMO_LABEL} validado (o el pago online completo)` : "el pago completo validado (online o Yape)";
  if (point === "confirmar") return `${head} No se confirma contra entrega sin ${what}.`;
  return `${head} La guía no sale sin ${what}.`;
}

/**
 * EL FRENO DE LA LISTA AUTOMÁTICA PARA UN PEDIDO. Pura: recibe si el celular
 * está en la lista vigente (Activo y sin excepción), lo que se exige y los
 * hechos del cobro.
 */
export function pagoOnlineBrakeDecision(input: {
  listed: boolean;
  failed?: number | null;
  requirement: PagoOnlineRequirement;
  facts: OrderPaymentFacts;
  point: PagoOnlinePoint;
}): PagoOnlineBrake {
  if (!input.listed) return { state: "ok", listed: false };
  if (pagoOnlineRequirementMet(input.requirement, input.facts)) return { state: "ok", listed: true, met: true };
  return { state: "blocked", listed: true, met: false, message: pagoOnlineBlockMessage(input.point, input.requirement, input.failed ?? null) };
}

// ── Posición, alertas y validaciones ────────────────────────────────────────

export const PAGO_ONLINE_MODES = ["apagado", "simulacion", "activo"] as const;
export type PagoOnlineMode = (typeof PAGO_ONLINE_MODES)[number];
export const PAGO_ONLINE_MODE_LABEL: Record<PagoOnlineMode, string> = { apagado: "Apagado", simulacion: "Simulación", activo: "Activo" };

export function isPagoOnlineMode(value: unknown): value is PagoOnlineMode {
  return typeof value === "string" && (PAGO_ONLINE_MODES as readonly string[]).includes(value);
}

/** El motivo de una excepción: null si sirve, o qué le falta. Pura. */
export function pagoOnlineReasonProblem(raw: unknown): string | null {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < PAGO_ONLINE_REASON_MIN) return `Escribe el motivo (al menos ${PAGO_ONLINE_REASON_MIN} caracteres).`;
  if (reason.length > PAGO_ONLINE_REASON_MAX) return `El motivo es demasiado largo (máx. ${PAGO_ONLINE_REASON_MAX}).`;
  return null;
}

/**
 * El texto de una alerta de Telegram. NUNCA lleva celulares ni correos
 * (§7): la tienda, qué pasó y cuántos. Pura (el que llama lo escapa).
 */
export function pagoOnlineAlertText(input: {
  kind: "dos_dias" | "freno_cambio" | "demasiado_grande";
  storeName: string;
  detail?: string | null;
  phones?: number | null;
}): string {
  const where = `«${PAGO_ONLINE_LABEL}» · ${input.storeName}`;
  switch (input.kind) {
    case "dos_dias":
      return `⚠️ ${where}: el envío de la lista falló dos días seguidos. La tienda sigue con la lista anterior.${input.detail ? ` Último error: ${input.detail}` : ""} Revísalo en Automatizaciones.`;
    case "freno_cambio":
      return `⚠️ ${where}: la lista de hoy no se mandó por un cambio brusco.${input.detail ? ` ${input.detail}` : ""} Revísalo en Automatizaciones antes de aceptarla.`;
    case "demasiado_grande":
      return `⚠️ ${where}: la tienda rechazó la lista por tamaño (413, ${(input.phones ?? 0).toLocaleString("es-PE")} celulares). Hay que avisar a la tienda.`;
  }
}

/** La fecha de Lima (UTC−5, sin horario de verano) de un instante: «2026-11-10». Pura. */
export function limaDateOf(at: Date): string {
  return new Date(at.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
}
