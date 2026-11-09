// «Pago solo online (lista automática)» — la regla, pura (MOM §41.11, pedido
// de las tiendas del 09-11-2026, docs/kapta/pago-solo-online.md).
//
// QUÉ DECIDIÓ EL OWNER.
//   * Un cliente es su celular: los ÚLTIMOS 9 DÍGITOS, con el historial de
//     Kenku y Aurela juntos (la organización), TODO el historial y solo los
//     pedidos contra entrega (`coverage` = `lima` o `provincia_cod`).
//   * Cuentan solo los pedidos contra entrega SIN un hecho de la migración de
//     plataforma (`cancelled_woocommerce`, `legacy_shopify_sale_cancelled`,
//     `woo_sale_ended_pending_return`). Con CERO `entregado` —en CUALQUIER
//     pedido: contra entrega, agencia o de la migración (owner 09-11-2026,
//     0328)—, entra:
//     (A) quien tiene al menos un `devuelto`; o
//     (B) el «anulador»: 5 o más pedidos con el 75 % o más `anulado`
//         (cualquier anulado, antes o después de salir).
//     Un anulado después de salir, solo, ya no basta (cambio del owner del
//     09-11-2026 sobre la consulta de referencia de las tiendas).
//   * Kapta calcula la lista una vez al día (05:00 de Lima), la manda entera a
//     cada tienda (cada envío la reemplaza) y la usa como freno en sus propios
//     pedidos (Kapta, Chatby, el bot, las asesoras).
//   * En los pedidos de Kapta, el cliente de la lista paga un ADELANTO
//     (decisión del owner del 09-11-2026, «Adelanto (regla §8)»), con la
//     opción de cambiarlo a «Pago completo» en Automatizaciones.
//
// La consulta SQL de la 0326 (`pago_online_candidates`) es la que corre de
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

/** La ruta de COD Core en cada tienda (docs/kapta/pago-solo-online.md §4). */
export const COD_CORE_API_PREFIX = "/wp-json/cod-core/v1";
export const PAGO_ONLINE_ENDPOINT_PATH = "/pago-solo-online";
/** La versión de COD Core que trae el endpoint (§8 del pedido). */
export const PAGO_ONLINE_COD_CORE_VERSION = "0.10.45";

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

/**
 * El «anulador» (regla B, owner 09-11-2026): con CERO entregados, entra quien
 * tiene al menos `PAGO_ONLINE_ANULADOR_MIN_ORDERS` pedidos contra entrega (el
 * owner: «más de 4») y el `PAGO_ONLINE_ANULADOR_RATIO` o más de ellos
 * `anulado` (cualquier anulado, antes o después de salir). Los MISMOS números
 * están en `pago_online_candidates` (0326): si cambian, cambian en los dos.
 */
export const PAGO_ONLINE_ANULADOR_MIN_ORDERS = 5;
export const PAGO_ONLINE_ANULADOR_RATIO = 0.75;

/**
 * Los hechos de la línea de tiempo (`order_events.kind`) que marcan un pedido
 * como artefacto de la migración de Shopify a WooCommerce (MOM §38): la
 * cancelación que llegó de WooCommerce, la venta vieja de Shopify cancelada y
 * la venta de Woo terminada con devolución pendiente. Un pedido con uno de
 * estos NO cuenta para la regla, ni como falla ni como entrega (owner,
 * 09-11-2026).
 */
export const PAGO_ONLINE_MIGRATION_EVENT_KINDS: readonly string[] = [
  "cancelled_woocommerce",
  "legacy_shopify_sale_cancelled",
  "woo_sale_ended_pending_return",
];

/** Lo que la regla mira de cada pedido (`order_master`). */
export interface PagoOnlineOrderFact {
  customer_phone: string | null;
  coverage: string | null;
  general_status: string | null;
  dispatched_at?: string | null;
  /** Los `order_events.kind` del pedido; solo importan los de la migración. */
  event_kinds?: readonly string[] | null;
}

/** ¿El pedido tiene un hecho de la migración de plataforma? Pura. */
export function hasMigrationCancel(o: Pick<PagoOnlineOrderFact, "event_kinds">): boolean {
  return (o.event_kinds ?? []).some((k) => PAGO_ONLINE_MIGRATION_EVENT_KINDS.includes(k));
}

/** ¿El pedido cuenta para la regla? Contra entrega y sin hecho de la migración. Pura. */
export function isCodOrder(o: Pick<PagoOnlineOrderFact, "coverage" | "event_kinds">): boolean {
  return PAGO_ONLINE_COD_COVERAGES.includes((o.coverage ?? "").trim()) && !hasMigrationCancel(o);
}

/** Por qué entra un cliente: (A) devolvió, o (B) anula casi todo lo que pide. */
export type PagoOnlineReason = "devuelto" | "anulador";
export const PAGO_ONLINE_REASONS: readonly PagoOnlineReason[] = ["devuelto", "anulador"];

export function isPagoOnlineReason(value: unknown): value is PagoOnlineReason {
  return value === "devuelto" || value === "anulador";
}

/** Las cuentas de un cliente: sus pedidos que cuentan y cuántos de cada estado. */
export interface PagoOnlineCounts {
  orders: number;
  devueltos: number;
  anulados: number;
  received: number;
}

/**
 * La regla sobre las cuentas de un cliente: con CERO entregados, `devuelto`
 * si tiene uno o más devueltos; si no, `anulador` si tiene 5+ pedidos con el
 * 75 % o más anulados. Null: no entra. Pura.
 */
export function pagoOnlineReasonOf(c: PagoOnlineCounts): PagoOnlineReason | null {
  if (c.received > 0) return null;
  if (c.devueltos >= 1) return "devuelto";
  if (c.orders >= PAGO_ONLINE_ANULADOR_MIN_ORDERS && c.anulados >= PAGO_ONLINE_ANULADOR_RATIO * c.orders) return "anulador";
  return null;
}

/** Quién es, para los mensajes: por qué entra, la cuenta que lo hizo entrar y sus pedidos. */
export interface PagoOnlineWho {
  reason: PagoOnlineReason;
  /** Los devueltos (`devuelto`) o los anulados (`anulador`). */
  failed: number | null;
  /** Sus pedidos contra entrega que cuentan. */
  orders: number | null;
}

export interface PagoOnlineListItem extends PagoOnlineWho {
  phone: string;
  failed: number;
  orders: number;
}

/**
 * La lista de una organización, desde sus pedidos: los celulares (9 dígitos)
 * que cumplen la regla, sin los exceptuados por Kapta, ordenados. Es la misma
 * regla de `pago_online_candidates` (0326). Pura.
 */
export function pagoOnlineListOf(orders: readonly PagoOnlineOrderFact[], exceptions: ReadonlySet<string> = new Set()): PagoOnlineListItem[] {
  const byPhone = new Map<string, PagoOnlineCounts>();
  for (const o of orders) {
    const phone = pagoOnlinePhoneKey(o.customer_phone);
    if (!phone) continue;
    const c = byPhone.get(phone) ?? { orders: 0, devueltos: 0, anulados: 0, received: 0 };
    const s = (o.general_status ?? "").trim();
    // «Recibió» es CUALQUIER pedido entregado: contra entrega, agencia o uno de
    // la migración (owner 09-11-2026, 0328). Las fallas, solo contra entrega
    // sin hecho de la migración.
    if (s === "entregado") c.received++;
    if (isCodOrder(o)) {
      c.orders++;
      if (s === "devuelto") c.devueltos++;
      if (s === "anulado") c.anulados++;
    }
    byPhone.set(phone, c);
  }
  const out: PagoOnlineListItem[] = [];
  for (const [phone, c] of byPhone) {
    if (exceptions.has(phone)) continue;
    const reason = pagoOnlineReasonOf(c);
    if (!reason) continue;
    out.push({ phone, reason, failed: reason === "devuelto" ? c.devueltos : c.anulados, orders: c.orders });
  }
  return out.sort((a, b) => a.phone.localeCompare(b.phone));
}

/**
 * El titular de la ficha y de los mensajes, con las cuentas del propio
 * cliente y nada de otros:
 *   * «Cliente con entrega devuelta y ninguna recibida»;
 *   * «Cliente que anuló 5 de 6 pedidos y nunca recibió».
 * Pura.
 */
export function pagoOnlineWhoText(who: PagoOnlineWho): string {
  if (who.reason === "anulador" && who.failed && who.orders) return `Cliente que anuló ${who.failed} de ${who.orders} pedidos y nunca recibió`;
  if (who.reason === "anulador") return "Cliente que anula casi todos sus pedidos y nunca recibió";
  return "Cliente con entrega devuelta y ninguna recibida";
}

/** El titular con lo que le queda: «… : solo pago online o adelanto» (o «solo pago online» con pago completo). Pura. */
export function pagoOnlineHeadline(who: PagoOnlineWho, requirement: PagoOnlineRequirement = PAGO_ONLINE_DEFAULT_REQUIREMENT): string {
  return `${pagoOnlineWhoText(who)}: ${requirement === "adelanto" ? "solo pago online o adelanto" : "solo pago online"}`;
}

/** Las cuentas entre paréntesis para un `devuelto` («(2 devueltos, 0 recibidas)»); el anulador ya las dice. Pura. */
function whoCounts(who: PagoOnlineWho): string {
  if (who.reason !== "devuelto" || !who.failed) return "";
  return ` (${who.failed} ${who.failed === 1 ? "devuelto" : "devueltos"}, 0 recibidas)`;
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

/**
 * «1+ devuelto, o 5+ pedidos con 75 % anulados, y 0 recibidas, Kenku Peru y
 * Aurela, calculada 2026-11-10 05:00» (§4.2: texto libre que la tienda
 * muestra en su panel). Pura.
 */
export function pagoOnlineRegla(storeNames: readonly string[], computedAt: Date): string {
  const lima = new Date(computedAt.getTime() - 5 * 3_600_000).toISOString();
  const names = storeNames.length <= 1 ? (storeNames[0] ?? "") : `${storeNames.slice(0, -1).join(", ")} y ${storeNames[storeNames.length - 1]}`;
  return `1+ devuelto, o ${PAGO_ONLINE_ANULADOR_MIN_ORDERS}+ pedidos con ${Math.round(PAGO_ONLINE_ANULADOR_RATIO * 100)} % anulados, y 0 recibidas, ${names}, calculada ${lima.slice(0, 10)} ${lima.slice(11, 16)}`;
}

export interface PagoOnlinePayload {
  celulares: string[];
  correos: string[];
  /** Sin `regla` al vaciar: el cuerpo es `{"celulares": [], "correos": []}` (§4.2). */
  regla?: string;
}

/** El cuerpo para vaciar la lista automática de una tienda (§4.2), tal cual. Pura. */
export function pagoOnlineEmptyPayload(): PagoOnlinePayload {
  return { celulares: [], correos: [] };
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
export function pagoOnlineBlockMessage(point: PagoOnlinePoint, requirement: PagoOnlineRequirement, who: PagoOnlineWho): string {
  const head = `${pagoOnlineHeadline(who, requirement)}${whoCounts(who)}.`;
  const what = requirement === "adelanto" ? `el adelanto de ${ADELANTO_MINIMO_LABEL} validado (o el pago online completo)` : "el pago completo validado (online o Yape)";
  if (point === "confirmar") return `${head} No se confirma contra entrega sin ${what}.`;
  return `${head} La guía no sale sin ${what}.`;
}

/**
 * Lo que se dice al CREAR un pedido para un celular de la lista (el bot de
 * Kapso y «Generar pedido» de Leads), sin datos de otros clientes. Pura.
 *   * `bot`: el bot no crea pedidos contra entrega para este celular, en las
 *     dos posiciones: no sabe cobrar. Deriva a una asesora, que cobra el
 *     adelanto de S/ 20 (`adelanto`) o el pago completo (`pago_completo`).
 *   * `pedido`, con `pago_completo`: «Generar pedido» no lo crea (la venta va
 *     por la web, con el pago online, como la lista de pago adelantado).
 *   * `pedido_aviso`, con `adelanto`: «Generar pedido» SÍ lo crea —es donde
 *     se registra el adelanto, en «Cómo sale el pedido» (§25.2)— y el aviso
 *     dice que no se confirma ni sale sin el adelanto validado.
 */
export function pagoOnlineOrderMessage(point: "bot" | "pedido" | "pedido_aviso", requirement: PagoOnlineRequirement, who: PagoOnlineWho): string {
  const head = `${pagoOnlineHeadline(who, requirement)}${whoCounts(who)}.`;
  if (point === "bot") {
    return requirement === "adelanto"
      ? `${head} El bot no crea pedidos contra entrega para este celular: deriva la conversación a una asesora, que cobra el adelanto de ${ADELANTO_MINIMO_LABEL} (o el pago online completo) antes de confirmar el pedido.`
      : `${head} El bot no crea pedidos contra entrega para este celular: deriva la conversación a una asesora, que cobra el pago completo (o que pague online en la web).`;
  }
  if (point === "pedido") {
    return requirement === "adelanto"
      ? `${head} El pedido no se confirma ni sale sin el adelanto de ${ADELANTO_MINIMO_LABEL} validado.`
      : `${head} Kapta no crea pedidos contra entrega para este celular: que pague online en la web, o cobra el pago completo por adelantado (link de pago o Yape) antes de generarlo.`;
  }
  return `Ojo: ${head} No se confirma ni sale sin el adelanto de ${ADELANTO_MINIMO_LABEL} validado: regístralo en «Cómo sale el pedido».`;
}

/** La llave de un celular de la lista vigente para marcar filas: organización + 9 dígitos. Pura. */
export function pagoOnlineListedKey(orgId: string, phone9: string): string {
  return `${orgId}|${phone9}`;
}

/**
 * Marca las filas de una página del Master con `pago_online_listed`, desde UNA
 * lectura del servidor (llaves `pagoOnlineListedKey`). Cada fila con la
 * organización de SU tienda. Sin lectura (`null`), no afirma nada. Pura.
 */
export function withPagoOnlineListed<T extends { customer_phone?: string | null; store_id?: string | null }>(
  rows: T[],
  listed: ReadonlySet<string> | null,
  storeOrg: ReadonlyMap<string, string>,
): (T & { pago_online_listed?: boolean })[] {
  if (!listed) return rows;
  return rows.map((r) => {
    const key = pagoOnlinePhoneKey(r.customer_phone ?? null);
    const org = r.store_id ? storeOrg.get(r.store_id) : undefined;
    return { ...r, pago_online_listed: !!key && !!org && listed.has(pagoOnlineListedKey(org, key)) };
  });
}

/**
 * EL FRENO DE LA LISTA AUTOMÁTICA PARA UN PEDIDO. Pura: recibe si el celular
 * está en la lista vigente (Activo y sin excepción), lo que se exige y los
 * hechos del cobro.
 */
export function pagoOnlineBrakeDecision(input: {
  listed: boolean;
  who?: PagoOnlineWho | null;
  requirement: PagoOnlineRequirement;
  facts: OrderPaymentFacts;
  point: PagoOnlinePoint;
}): PagoOnlineBrake {
  if (!input.listed) return { state: "ok", listed: false };
  if (pagoOnlineRequirementMet(input.requirement, input.facts)) return { state: "ok", listed: true, met: true };
  const who = input.who ?? { reason: "devuelto", failed: null, orders: null };
  return { state: "blocked", listed: true, met: false, message: pagoOnlineBlockMessage(input.point, input.requirement, who) };
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
