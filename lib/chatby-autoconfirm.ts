// Confirmación automática por Chatby y guía Aliclik automática con tope diario
// (MOM §6.1, «Confirmó por Chatby», decisión del owner del 01-11-2026).
//
// POR QUÉ. La clienta de Provincia COD que compra en la web responde al bot de
// confirmación de Chatby con un mensaje armado por la tienda: «Hola equipo
// Aurela, deseo confirmar mi pedido AUR900226 y pagaré S/ 178.00 en casa.», el
// producto y «Dirección: Jr huallaga 765 barrio huayco, San Martín, Tarapoto».
// Ese mensaje ya dice lo que la asesora valida al teléfono (§6.1: producto,
// monto y dirección), y el pedido seguía en «Por confirmar» hasta que alguien
// abría la ficha, leía la pestaña Chatby y marcaba «Confirmó el pedido».
//
// QUÉ HACE. Una pasada periódica lee la conversación de Chatby (los mismos dos
// GET de lib/chatby-api.ts, solo lectura) de los pedidos de Provincia COD en Por
// confirmar de las últimas 72 h y, si el mensaje DE LA CLIENTA nombra el
// pedido, dice confirmar, dice pagar en casa, el monto coincide con el total
// (menos de S/ 1 de diferencia, lib/payment-rounding.ts) y la dirección es
// completa y la misma del pedido, confirma por el mismo camino que la mesa
// (`register_confirmation_attempt_v2`, sin actor, origen `chatby`). Después, a
// los que confirmó, les crea la guía Aliclik por el mismo camino que el botón
// (lib/aliclik-guide.ts), hasta `daily_cap` guías por día de Lima.
//
// QUÉ NO HACE. No escribe nunca por Chatby. No guarda la conversación ni la
// dirección: solo el id del mensaje y el motivo. No adivina: lo que no cuadra
// (otro monto, otra dirección, un «no lo quiero», un mensaje después que no es
// un «gracias») queda para la asesora, con el motivo en la línea de tiempo, y
// no se vuelve a mirar.
//
// Este archivo es PURO. El servidor (lib/chatby-autoconfirm-server.ts) carga
// los datos, lee Chatby, escribe y llama a los caminos existentes.

import { createHash } from "node:crypto";
import { chatbyMentionsOrder, type ChatbyMessage } from "@/lib/chatby-conversation";
import { classifyOperation } from "@/lib/order-macro-stage";
import { limaDayKey } from "@/lib/order-confirmation";
import { PAYMENT_ROUNDING_TOLERANCE_CENTS } from "@/lib/payment-rounding";
import { explicitRejection } from "@/lib/swayp-auto-policy";
import { direccionConNumero, esRecojoEnAgencia } from "@/lib/swayp-por-confirmar-auto";
import { approxModeFrom, type ApproxMode } from "@/lib/geocode-approx";

/** El origen que llevan los hechos que escribe la pasada (`order_events.source`). */
export const CHATBY_SOURCE = "chatby";
export const CHATBY_AUTO_POLICY = "chatby-autoconfirm-v1";
/** El hecho que deja un mensaje de confirmación que la pasada no pudo dar por bueno. */
export const CHATBY_CONFIRMATION_HELD = "chatby_confirmation_held";
/** Lo que el texto de la guía y del hecho dicen del origen. */
export const CHATBY_GUIDE_ORIGIN = "confirmado_chatby";

// ---------------------------------------------------------------------------
// Ajustes por organización (`chatby_auto_settings`, 0297)
// ---------------------------------------------------------------------------

export interface ChatbyAutoSettings {
  org_id: string;
  /** El interruptor de toda la pasada: leer, confirmar y crear guías. */
  enabled: boolean;
  /** Crear la guía Aliclik de lo que confirmó. Apagado, solo confirma. */
  guide_enabled: boolean;
  /** Guías automáticas por día de Lima, en toda la organización. */
  daily_cap: number;
  /** Antigüedad máxima del pedido que se mira, en horas. */
  window_hours: number;
  /** Pedidos (2 GET de Chatby cada uno) por pasada. */
  max_orders_per_run: number;
  /** Cada cuánto se vuelve a leer un pedido que todavía no confirmó. */
  recheck_minutes: number;
  /** La coordenada por dirección (Google, solo el edificio) para la guía (0301). */
  geocode_enabled: boolean;
  /** «Aceptar ubicación aproximada en la calle correcta» (0316): Apagado / Simulación / Activo. */
  approx_mode: ApproxMode;
  /** «Pedir sola la dirección o la ubicación» (0318, lib/chatby-auto-ask.ts): Apagado / Simulación / Activo. */
  ask_mode: ApproxMode;
  /**
   * «Guía automática para clientas con entregas» (0317, lib/history-guide-auto.ts):
   * Apagado / Simulación / Activo.
   */
  history_guide_mode: ApproxMode;
}

export const DEFAULT_CHATBY_AUTO_SETTINGS: Omit<ChatbyAutoSettings, "org_id"> = {
  enabled: true,
  guide_enabled: true,
  daily_cap: 20,
  window_hours: 72,
  max_orders_per_run: 20,
  recheck_minutes: 30,
  geocode_enabled: true,
  approx_mode: "apagado",
  ask_mode: "apagado",
  history_guide_mode: "apagado",
};

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/**
 * La fila de la base, con cada número dentro de su rango. Un valor fuera de
 * rango vuelve al de la migración: la base ya lo impide con su `check`, esto
 * es por si alguien lo cambia a mano sin él.
 */
export function chatbyAutoSettingsFrom(row: Record<string, unknown>): ChatbyAutoSettings | null {
  const orgId = typeof row.org_id === "string" ? row.org_id : null;
  if (!orgId) return null;
  const d = DEFAULT_CHATBY_AUTO_SETTINGS;
  return {
    org_id: orgId,
    enabled: row.enabled === true,
    guide_enabled: row.guide_enabled !== false,
    daily_cap: intIn(row.daily_cap, 0, 200, d.daily_cap),
    window_hours: intIn(row.window_hours, 1, 168, d.window_hours),
    max_orders_per_run: intIn(row.max_orders_per_run, 1, 100, d.max_orders_per_run),
    recheck_minutes: intIn(row.recheck_minutes, 5, 1440, d.recheck_minutes),
    // Sin la columna (antes de la 0301) no se consulta a Google.
    geocode_enabled: row.geocode_enabled === true,
    // Sin la columna (antes de la 0316) o con un valor raro: Apagado.
    approx_mode: approxModeFrom(row.approx_mode),
    // Sin la columna (antes de la 0318) o con un valor raro: Apagado.
    ask_mode: approxModeFrom(row.ask_mode),
    // Sin la columna (antes de la 0317) o con un valor raro: Apagado.
    history_guide_mode: approxModeFrom(row.history_guide_mode),
  };
}

// ---------------------------------------------------------------------------
// Qué pedido se mira
// ---------------------------------------------------------------------------

type Destination = {
  shipping_mode?: string | null;
  coverage?: string | null;
  region?: string | null;
  province?: string | null;
  district?: string | null;
};

/** La operación del pedido con la misma regla del Master (`classifyOperation`). */
function operationOf(d: Destination) {
  return classifyOperation({
    shipping_mode: d.shipping_mode ?? null,
    coverage: d.coverage ?? null,
    region: d.region ?? null,
    province: d.province ?? null,
    district: d.district ?? null,
  });
}

/** Subetapas donde la pasada puede confirmar: nadie pactó fecha ni abono. */
const SUBETAPAS = new Set(["sin_llamar", "por_confirmar"]);
const NO_PAYMENT = new Set(["", "sin_pago"]);

export interface ChatbyCandidate {
  master: {
    macro_stage?: string | null;
    macro_substage?: string | null;
    shipping_mode?: string | null;
    coverage?: string | null;
    region?: string | null;
    province?: string | null;
    district?: string | null;
    address?: string | null;
    reference?: string | null;
    payment_state?: string | null;
    customer_phone?: string | null;
  };
  order: {
    name: string | null;
    created_at: string;
    cancelled_at: string | null;
    total_amount: number | null;
    total_refunded: number | null;
    currency: string | null;
    shopify_note: string | null;
  };
  /** Las notas de los intentos de confirmación del pedido. */
  contactNotes: (string | null)[];
}

export type ChatbyOrderSkip =
  | "etapa"
  | "no_provincia_cod"
  | "fuera_de_ventana"
  | "pedido_invalido"
  | "con_pago"
  | "sin_celular"
  | "agencia"
  | "rechazo_registrado";

/**
 * Por qué este pedido no se lee en Chatby, o null si se lee. Todo lo que se
 * decide sin salir de la base: no se gastan dos lecturas de Chatby en un
 * pedido que no podría confirmarse.
 */
export function chatbyOrderSkip(c: ChatbyCandidate, s: Pick<ChatbyAutoSettings, "window_hours">, now: Date): ChatbyOrderSkip | null {
  const m = c.master;
  const o = c.order;
  if (m.macro_stage !== "por_confirmar" || !SUBETAPAS.has(m.macro_substage ?? "")) return "etapa";
  // Solo Provincia COD: Lima no pasa por confirmación (§6.1) y Agencia confirma
  // con el pago validado, no con un mensaje.
  if (operationOf(m) !== "provincia_cod") return "no_provincia_cod";
  const hours = (now.getTime() - Date.parse(o.created_at)) / 3_600_000;
  if (!Number.isFinite(hours) || hours < 0 || hours > s.window_hours) return "fuera_de_ventana";
  if (o.cancelled_at || (Number(o.total_refunded) || 0) > 0 || !(Number(o.total_amount) > 0) || o.currency !== "PEN" || !o.name) {
    return "pedido_invalido";
  }
  if (!NO_PAYMENT.has((m.payment_state ?? "").trim())) return "con_pago";
  if (!(m.customer_phone ?? "").trim()) return "sin_celular";
  if (esRecojoEnAgencia(m.address, m.reference)) return "agencia";
  const notes = [o.shopify_note, ...c.contactNotes].filter(Boolean).join("\n");
  if (notes && explicitRejection(notes)) return "rechazo_registrado";
  return null;
}

/** Lo que la pasada dejó escrito de un pedido (`chatby_auto_checks`). */
export interface ChatbyCheckState {
  outcome: ChatbyCheckOutcome;
  checked_at: string;
}

/**
 * - `confirmado`: lo confirmó la pasada.
 * - `para_asesora`: había un mensaje de confirmación y no cuadró. Queda para la
 *   asesora con su motivo y no se vuelve a leer (salvo lo que espera la
 *   ubicación: `sin_ubicacion`, y la dirección incompleta a la que se le pidió
 *   desde la ficha, `chatbyHeldWatchDue` en lib/chatby-location-ask.ts).
 * - `sin_confirmacion` / `sin_conversacion`: todavía no escribió. Se vuelve a
 *   leer cada `recheck_minutes` mientras siga en la ventana.
 * - `error`: Chatby no respondió o falló la escritura. Se reintenta igual.
 */
export type ChatbyCheckOutcome = "confirmado" | "para_asesora" | "sin_confirmacion" | "sin_conversacion" | "error";

const FINAL_OUTCOMES = new Set<ChatbyCheckOutcome>(["confirmado", "para_asesora"]);

/** ¿Toca leer este pedido en esta pasada? Lo resuelto una vez no se repregunta. */
export function chatbyCheckDue(
  check: ChatbyCheckState | null | undefined,
  now: Date,
  s: Pick<ChatbyAutoSettings, "recheck_minutes">,
): boolean {
  if (!check) return true;
  if (FINAL_OUTCOMES.has(check.outcome)) return false;
  const at = Date.parse(check.checked_at);
  return !Number.isFinite(at) || now.getTime() - at >= s.recheck_minutes * 60_000;
}

/**
 * El orden de la pasada: primero los que nunca se leyeron (el más nuevo
 * primero: es el que acaba de recibir la plantilla), después los que hace más
 * que se leyeron. Así el tope de lecturas va rotando por toda la ventana.
 */
export function chatbyReadOrder<T extends { createdAt: string; checkedAt: string | null }>(a: T, b: T): number {
  if (!a.checkedAt !== !b.checkedAt) return a.checkedAt ? 1 : -1;
  if (!a.checkedAt && !b.checkedAt) return b.createdAt.localeCompare(a.createdAt);
  return a.checkedAt!.localeCompare(b.checkedAt!);
}

// ---------------------------------------------------------------------------
// El mensaje
// ---------------------------------------------------------------------------

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** ¿Dice confirmar? «deseo confirmar», «confirmo mi pedido», «confirmado». */
export function saysConfirm(text: string): boolean {
  return /\bconfirm(?:o|a|ar|amos|ado|ada|acion|ando)\b/.test(sinTildes(text));
}

/**
 * ¿La clienta dice que no? `explicitRejection` (§11.9, la misma de Swayp) habla
 * de la clienta en tercera persona —es lo que anotan las asesoras—; en el chat
 * ella escribe en primera: «no lo deseo», «ya no quiero», «quiero anular».
 */
export function customerRejects(text: string): boolean {
  if (explicitRejection(text)) return true;
  const t = sinTildes(text);
  return /\bno\s+(?:lo\s+|la\s+|los\s+|las\s+)?(?:deseo|quiero|necesito|voy\s+a\s+recibir|podre\s+recibir)\b|\bya\s+no\s+(?:lo\s+|la\s+)?(?:deseo|quiero)\b|\banul(?:ar|en|e|o)\b/.test(t);
}

/** ¿Dice que paga al recibir? «pagaré … en casa», «contraentrega», «al recibir». */
export function saysPayAtHome(text: string): boolean {
  const t = sinTildes(text);
  return /\ben\s+(?:mi\s+)?casa\b|contra\s*-?\s*entrega|\bal\s+(?:recibir|momento\s+de\s+recibir|llegar)\b|\bpago\s+(?:en\s+efectivo\s+)?al\s+recibir/.test(t);
}

/** «178.00», «178,00», «1,178.00», «1.178,00», «178» → céntimos. */
export function parseSolesCents(raw: string): number | null {
  const t = raw.trim().replace(/\s+/g, "");
  if (!/^\d[\d.,]*$/.test(t)) return null;
  const lastDot = t.lastIndexOf(".");
  const lastComma = t.lastIndexOf(",");
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    normalized = t.split(thousands).join("").replace(decimal, ".");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const parts = t.split(sep);
    const tail = parts[parts.length - 1]!;
    // Un solo separador con tres cifras detrás es de miles («1,178»); con una o
    // dos, de decimales («178.5», «178,00»).
    normalized = parts.length === 2 && tail.length <= 2 ? `${parts[0]}.${tail}` : parts.join("");
  } else {
    normalized = t;
  }
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

const SOLES = /s\s*\/\s*\.?\s*(\d[\d.,]*\d|\d)/gi;

/**
 * El monto que la clienta dice que paga: el que va después de «pagar(é)», y si
 * no hay, el primer «S/ …» del mensaje. El producto también puede llevar
 * precio («Faja x2 S/ 89»), por eso no vale cualquier monto del mensaje.
 */
export function confirmationAmountCents(text: string): number | null {
  const t = sinTildes(text);
  const afterPay = /\bpag(?:are|ar|o|aria)\b[^\n]{0,40}?s\s*\/\s*\.?\s*(\d[\d.,]*\d|\d)/i.exec(t);
  if (afterPay) return parseSolesCents(afterPay[1]!);
  SOLES.lastIndex = 0;
  const first = SOLES.exec(t);
  return first ? parseSolesCents(first[1]!) : null;
}

/** ¿Coincide con el total? Menos de S/ 1 de diferencia, en cualquier sentido. */
export function amountMatchesTotal(cents: number | null, totalAmount: number | null): boolean {
  if (cents === null || !(Number(totalAmount) > 0)) return false;
  return Math.abs(cents - Math.round(Number(totalAmount) * 100)) <= PAYMENT_ROUNDING_TOLERANCE_CENTS;
}

/** La dirección que escribió: lo que sigue a «Dirección:», hasta el fin de la línea o la referencia. */
export function messageAddress(text: string): string | null {
  const m = /direcci[oó]n(?:\s+de\s+(?:entrega|envio|envío))?\s*[:：]\s*([^\n]+)/i.exec(text);
  if (!m) return null;
  const line = m[1]!.split(/\b(?:referencia|ref\.?|producto|total)\s*[:：]/i)[0]!.trim().replace(/[.\s]+$/, "");
  return line || null;
}

/** Tipos de vía y señas que dicen DÓNDE: calle, jirón, avenida, pasaje, manzana y lote… */
const VIA = /\b(?:calle|cl|clle|ca|jr|jiron|av|avd|avda|avenida|psj|psje|pje|pasaje|prolongacion|prol|carretera|carr|ctra|malecon|alameda|ovalo|mz|mza|manzana|lt|lte|lote)\b/;

const MESES = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|setiembre|septiembre|octubre|noviembre|diciembre";

/** Una agencia escrita con la «n» de la voz («Empresa Shalon PAITA»): tampoco es un domicilio. */
const AGENCIA_MAL_ESCRITA = /\bshal[oa]n\b/;

/** «s/n», «S N», «sin número»: la clienta dice que la casa no tiene número. */
const SIN_NUMERO = /\bs\s*\/\s*n\b|(?:^|\s)s\.?\s+n\.?(?=\s|$)|\bsn\b|\bsin\s+(?:numero|nro|num|n°|nº)/;

/** Un mercado o un puesto («Mercado modelo … puesto número 12»): no es una casa. */
const MERCADO = /^\s*mercado\b|\bpuestos?\b|\bstand\b/;

/**
 * Un cruce de calles («Entre Avenida … y Circunvalación», «intersección», «Cruce
 * de …»): no es una puerta. Solo cuando la dirección ES el cruce; «Sucre 116
 * entre Grau y Bolívar» tiene su número y vale.
 */
const CRUCE = /\binterseccion\b|^\s*(?:entre|cru[cs]e)\b/;

/**
 * Los números que NO son el de la casa, fuera antes de buscarlo: celulares,
 * teléfonos fijos, fechas («9 de diciembre»), años («del 2020»), etapas («III etapa»),
 * kilómetros («Km 4.5», «Km50», «c.f.b.km 6.800»), distancias («a 3 cuadras»)
 * y los que van con su etiqueta: puerta, puesto, piso, interior, dpto, sector,
 * comité, grupo, zona, paradero, tienda, local.
 */
function sinNumerosQueNoSonDeCasa(t: string): string {
  return ` ${t} `
    .replace(/(?:\+?51[\s-]?)?\b9\d{2}[\s.-]?\d{3}[\s.-]?\d{3}\b/g, " ")
    .replace(/\(?\b0\d{1,2}\)?[\s-]?\d{6,7}\b/g, " ")
    .replace(new RegExp(`\\b\\d{1,2}\\s+de\\s+(?:${MESES})\\b`, "g"), " ")
    .replace(/\b(?:ano|anos|del|desde|en|promocion)\s+(?:19|20)\d{2}\b/g, " ")
    .replace(/\b(?:\d+|[ivx]+)\s*(?:ra|da|ta|era|ro|do|to|va|vo|ma|mo)?\s*etapa\b|\betapa\s+(?:\d+|[ivx]+)\b/g, " ")
    .replace(/(?:\bkms?|\bkilometros?)\s*\.?\s*\d+(?:[.,]\d+)?/g, " ")
    .replace(/\b(?:a\s+)?\d+\s*(?:c\w{0,2}dras?|cdas?|metros?|mts?|pasos|minutos|min)\b/g, " ")
    .replace(
      /\b(?:puerta|puesto|stand|piso|interior|int|dpto|depto|departamento|dep|oficina|of|sector|comite|grupo|zona|paradero|tienda|local)\b\.?\s*(?:n(?:ro|umero|um)?\b\.?|[°º#])?\s*\d+[a-z]?\b/g,
      " ",
    );
}

/** Manzana y lote pegados o cortos: «MZ alote11», «Mz B lt3», «mz. c-lote 4». */
const MANZANA_LOTE_CORTO = /\b(?:mz|mza|mzn|manzana)\b\.?\s*[a-z]{1,2}\d{0,2}\s*[-.]?\s*(?:lt|lte|lot|lote)\.?\s*\d{1,4}/;

/** Palabras que no son el nombre de una calle aunque vayan antes de un número. */
const NO_ES_NOMBRE = new Set([
  "con", "del", "las", "los", "entre", "frente", "cerca", "altura", "costado", "espalda", "espaldas",
  "esquina", "numero", "nro", "num", "kms", "telefono", "celular", "cel", "ano", "anos", "sin",
]);
const ROMANO = /^[ivx]+$/;

/** ¿La palabra puede ser el nombre de la calle? Tres letras o más, no un relleno ni un romano («III»). */
function esNombre(word: string | undefined): boolean {
  return !!word && word.length >= 3 && !NO_ES_NOMBRE.has(word) && !ROMANO.test(word);
}

/** La última palabra antes de `index`, saltando «N°», «nro.», «#» y la puntuación. */
function palabraAntes(t: string, index: number): string | undefined {
  const before = t.slice(0, index).replace(/(?:[\s#°º.,:;-]|\b(?:n|nro|no|num|numero)\b)*$/, "");
  return /([a-z]+)$/.exec(before)?.[1];
}

/**
 * El código corto de manzana y lote (owner, 08-11-2026): una o dos letras y su
 * número, «T 13», «A- 11», «F.10», «b6», «ll 21», «BN 17», «E13», después del
 * nombre de la urbanización, el AA.HH., la asociación o la calle («Urb Quinta
 * Tristán T 13», «Juana Blanco b6»). La «y», la «e», la «o» y la «u» sueltas
 * son conjunciones («Magisterial III y 501»), no una manzana; «km» y «s n»
 * tampoco.
 */
const BLOQUE = /(?:^|[^a-z0-9])([a-z]{1,2})(\s*[-.]?\s*)(\d{1,3})(?=[a-z]?(?:[^a-z0-9]|$)|[a-z]{3,})/g;
const NO_ES_BLOQUE = new Set(["km", "n", "no", "nr", "s", "sn", "de", "la", "el", "en", "al", "lo", "mi", "su", "tu", "ok"]);
const CONJUNCION = new Set(["y", "e", "o", "u"]);

function conBloque(t: string): boolean {
  for (const m of t.matchAll(BLOQUE)) {
    const [whole, letras, sep] = [m[0], m[1]!, m[2]!];
    if (NO_ES_BLOQUE.has(letras)) continue;
    if (CONJUNCION.has(letras) && /^\s+$/.test(sep)) continue;
    const start = m.index! + whole.indexOf(letras);
    if (esNombre(palabraAntes(t, start))) return true;
  }
  return false;
}

/**
 * El nombre de la calle y su número sin la palabra «calle» (owner, 08-11-2026):
 * «antenor orrego 341», «Sucre 116A», «Jorge chavez #212», «Chile y Venezuela
 * 154», «Fco de paula vigil 215diego ferre». El número va justo después de una
 * palabra que puede ser un nombre (no «y», no un romano), tiene hasta 5 cifras
 * y una letra («116A»), y un año suelto (1900–2099) no cuenta: sin «calle» no
 * se distingue del de una asociación.
 */
const NUMERO = /(?:^|[\s#°º.,-])(\d{1,5})(?=[a-z]?(?:[^a-z0-9]|$)|[a-z]{3,})/g;

function conNombreYNumero(t: string): boolean {
  for (const m of t.matchAll(NUMERO)) {
    const n = m[1]!;
    if (/^(?:19|20)\d{2}$/.test(n)) continue;
    const start = m.index! + m[0].indexOf(n);
    if (esNombre(palabraAntes(t, start))) return true;
  }
  return false;
}

/**
 * ¿La dirección está completa? Sirve cualquiera de estas, y nunca una agencia
 * (eso no es un domicilio):
 *
 * 1. Un tipo de vía (calle, Jr., Av., Psje., Mz/Lt…) y su número, o manzana y
 *    lote (`direccionConNumero`, §11.13): la regla desde el 01-11-2026, igual.
 * 2. (owner, 08-11-2026) El nombre de la calle y su número aunque no diga
 *    «calle» («antenor orrego 341», «Pasajr los heroes 211»), o el nombre de la
 *    urbanización, AA.HH., APV, asociación o calle con su código corto de
 *    manzana y lote («Urb Quinta Tristán T 13», «Juana Blanco b6», «MZ
 *    alote11»). Aquí no vale: un mercado o un puesto, un cruce («Entre … y …»,
 *    «intersección»),
 *    «s/n», ni un número que es de otra cosa (km, puesto, puerta, piso, sector,
 *    celular, año, fecha, etapa, cuadras). «Magisterial III y 501» queda para la
 *    asesora: el número va después de la «y», no de un nombre.
 *
 * La coordenada sigue pidiendo el edificio en Google (`ROOFTOP`) para crear la
 * guía: esto solo decide si la dirección se puede dar por buena.
 */
export function direccionCompleta(address: string | null | undefined): boolean {
  const t = sinTildes(address ?? "");
  if (!t.trim()) return false;
  if (esRecojoEnAgencia(address) || AGENCIA_MAL_ESCRITA.test(t)) return false;
  if (VIA.test(t) && direccionConNumero(address)) return true;
  if (MERCADO.test(t) || CRUCE.test(t)) return false;
  const u = sinNumerosQueNoSonDeCasa(t);
  if (MANZANA_LOTE_CORTO.test(u)) return true;
  if (SIN_NUMERO.test(t)) return false;
  return conBloque(u) || conNombreYNumero(u);
}

/** Una seña en vez de la puerta: «frente al colegio», «cerca del grifo», «al costado de…». */
const SENA = /\b(?:frente|cerca|costado|espalda|espaldas|altura|junto|paradero)\b|\bal\s+lado\b/;

/**
 * ¿A la dirección incompleta le falta SOLO el número de la casa? (owner,
 * 08-11-2026): la calle sin número («Calle Cordova», «Tupac Amaru»), «s/n» o
 * «sin número». Entonces a la clienta se le pide la calle, el número y una
 * referencia. Si está incompleta por otra cosa —un mercado o un puesto, un
 * cruce, un kilómetro, una seña sin calle («Frente al grifo»), un número que no
 * se sabe de qué es («Magisterial III y 501»)—, no: se le pide solo su
 * ubicación actual de WhatsApp. Una agencia, tampoco (no es un domicilio).
 */
export function direccionSinNumeroDeCasa(address: string | null | undefined): boolean {
  const t = sinTildes(address ?? "");
  if (!t.trim()) return false;
  if (esRecojoEnAgencia(address) || AGENCIA_MAL_ESCRITA.test(t)) return false;
  if (MERCADO.test(t) || CRUCE.test(t)) return false;
  if (/(?:\bkms?|\bkilometros?)\s*\.?\s*\d/.test(t)) return false;
  if (SIN_NUMERO.test(t)) return true;
  if (!VIA.test(t) && SENA.test(t)) return false;
  return !/\d/.test(sinNumerosQueNoSonDeCasa(t));
}

/** Palabras que no dicen nada del lugar: no cuentan al comparar. */
const RELLENO = new Set([
  "n", "nro", "no", "num", "numero", "de", "del", "la", "las", "el", "los", "y", "e",
  "peru", "departamento", "dpto", "dep", "provincia", "prov", "distrito", "dist", "region",
]);

function tokens(value: string | null | undefined): string[] {
  return sinTildes(value ?? "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t && !RELLENO.has(t));
}

export type AddressMismatch = "direccion_distinta" | "destino_distinto";

/**
 * ¿La dirección del mensaje es la del pedido? Las tres cosas:
 *
 * 1. Toda la dirección del pedido está en el mensaje (palabra por palabra: la
 *    calle y su número).
 * 2. El mensaje no dice nada más que eso, la referencia y los nombres del
 *    destino del pedido. Otra calle, otro número u otro distrito («…, San
 *    Martín, Morales» en un pedido de Tarapoto) es otra dirección.
 * 3. Nombra el distrito o la provincia del pedido: el departamento solo no
 *    dice a qué ciudad va.
 *
 * El mensaje lo arma la tienda con los datos del pedido, así que cuando la
 * clienta no lo tocó coincide palabra por palabra. Si lo cambió, es justo lo
 * que tiene que ver una asesora.
 */
export function addressMatchesOrder(
  messageAddr: string,
  order: { address?: string | null; reference?: string | null; district?: string | null; province?: string | null; region?: string | null },
): { ok: true } | { ok: false; reason: AddressMismatch } {
  const msg = new Set(tokens(messageAddr));
  const street = tokens(order.address);
  const placeNames = [order.district, order.province, order.region];
  const places = new Set(placeNames.flatMap(tokens));
  const reference = new Set(tokens(order.reference));
  if (!street.length || !street.every((t) => msg.has(t))) return { ok: false, reason: "direccion_distinta" };
  const streetSet = new Set(street);
  if ([...msg].some((t) => !streetSet.has(t) && !places.has(t) && !reference.has(t))) {
    // Una palabra de más que no es del pedido: si parece un lugar (va después de
    // la calle, separada por coma) es otro destino; si no, otra dirección.
    const tail = messageAddr.split(",").slice(1).flatMap(tokens);
    return { ok: false, reason: tail.some((t) => !places.has(t) && !streetSet.has(t)) ? "destino_distinto" : "direccion_distinta" };
  }
  const named = [order.district, order.province].some((name) => {
    const t = tokens(name);
    return t.length > 0 && t.every((x) => msg.has(x));
  });
  return named ? { ok: true } : { ok: false, reason: "destino_distinto" };
}

/** Un número de pedido de las tiendas («#KP200123», «AUR900226»). */
const ORDER_NUMBER = /(?:^|[^A-Za-z0-9])#?([A-Za-z]{2,4}\d{5,})(?![A-Za-z0-9])/g;

function namesAnotherOrder(text: string, orderName: string): boolean {
  const own = orderName.replace(/^#/, "").toUpperCase();
  ORDER_NUMBER.lastIndex = 0;
  for (const m of text.matchAll(ORDER_NUMBER)) {
    if (m[1]!.toUpperCase() !== own) return true;
  }
  return false;
}

/** Palabras de cortesía: un «gracias 🙏» después de confirmar no cambia nada. */
const CORTESIA = new Set([
  "ok", "okey", "okay", "oki", "si", "sii", "listo", "gracias", "muchas", "mil", "perfecto", "ya", "de", "acuerdo",
  "bien", "genial", "excelente", "dale", "entendido", "vale", "igualmente", "hola", "buenas", "buenos", "buen",
  "dia", "dias", "tarde", "tardes", "noche", "noches", "bendiciones", "amen", "a", "ud", "usted", "ustedes",
  "senorita", "joven", "lo", "espero", "esperamos", "quedo", "atenta", "atento", "super", "claro", "porfa",
  "por", "favor", "graciass", "grx", "thanks",
]);

/** ¿Es solo cortesía (o solo emojis)? */
export function isCourtesy(text: string): boolean {
  const words = sinTildes(text).replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  return words.every((w) => CORTESIA.has(w));
}

/** Por qué un mensaje de confirmación no se dio por bueno. */
export type ChatbyHoldReason =
  | "rechazo"
  | "anulado_en_chat"
  | "sin_pago_en_casa"
  | "sin_monto"
  | "monto_distinto"
  | "sin_direccion"
  | "direccion_incompleta"
  | "direccion_distinta"
  | "destino_distinto"
  | "mensaje_posterior"
  // La confirmación cuadró pero la guía no se pudo crear: sigue en Por
  // confirmar, porque solo sale de ahí con la guía creada (owner, 02-11-2026).
  | "sin_ubicacion"
  | "pin_sin_respaldo"
  | "shalom"
  | "programado"
  | "guia_no_creada";

export const CHATBY_HOLD_REASONS: Record<ChatbyHoldReason, string> = {
  rechazo: "La clienta escribió que no quiere el pedido.",
  anulado_en_chat: "En Chatby quedó una nota de anulación.",
  sin_pago_en_casa: "El mensaje no dice que paga al recibir (en casa o contraentrega).",
  sin_monto: "El mensaje no dice el monto que va a pagar.",
  monto_distinto: "El monto del mensaje no coincide con el total del pedido.",
  sin_direccion: "El mensaje no trae la dirección.",
  direccion_incompleta: "La dirección no tiene el nombre de la calle con su número, ni manzana y lote (o su código corto, «B8»).",
  direccion_distinta: "La dirección del mensaje no es la del pedido.",
  destino_distinto: "El distrito o la provincia del mensaje no son los del pedido.",
  mensaje_posterior: "La clienta escribió algo más después de confirmar.",
  sin_ubicacion:
    "La clienta no mandó su ubicación por WhatsApp en esta compra, y Aliclik la exige. Pídesela: Kapta sigue mirando el chat 72 h y, cuando llegue, crea la guía y confirma sola.",
  pin_sin_respaldo: "La ubicación que mandó no cae en el departamento ni en la ciudad del pedido.",
  shalom: "Tiene «DNI y agencia Shalom» guardado: la salida la decide una persona.",
  programado: "Tiene envío programado: la guía es la del día programado.",
  guia_no_creada: "Aliclik no dejó crear la guía.",
};

/** ¿El motivo es de la guía (la confirmación sí cuadró)? */
export function isGuideHoldReason(reason: ChatbyHoldReason): boolean {
  return GUIDE_HOLD_REASONS.has(reason);
}
const GUIDE_HOLD_REASONS = new Set<ChatbyHoldReason>(["sin_ubicacion", "pin_sin_respaldo", "shalom", "programado", "guia_no_creada"]);

export type ChatbyVerdict =
  | { confirm: true; messageId: string; at: string | null; amountCents: number }
  /** Había un mensaje de confirmación y no cuadró: para la asesora, una sola vez. */
  | { confirm: false; final: true; reason: ChatbyHoldReason; messageId: string | null; amountCents?: number | null }
  /** Todavía no hay un mensaje de confirmación de este pedido. */
  | { confirm: false; final: false; reason: "sin_confirmacion" };

/** Un mensaje anterior al pedido no puede ser su confirmación. Media hora de margen por los relojes. */
const BEFORE_ORDER_MARGIN_MS = 30 * 60_000;

/**
 * El veredicto sobre la conversación de UN pedido. Solo cuentan los mensajes
 * de la clienta (`type = in`), nunca los del bot ni los del equipo, y solo los
 * de después de crearse el pedido: una misma clienta puede tener en el chat
 * pedidos de las dos marcas, viejos y nuevos.
 */
export function evaluateChatbyConfirmation(input: {
  messages: readonly ChatbyMessage[];
  orderName: string;
  orderCreatedAt: string;
  totalAmount: number | null;
  order: { address?: string | null; reference?: string | null; district?: string | null; province?: string | null; region?: string | null };
}): ChatbyVerdict {
  const since = Date.parse(input.orderCreatedAt) - BEFORE_ORDER_MARGIN_MS;
  const after = input.messages.filter((m) => {
    const at = m.at ? Date.parse(m.at) : NaN;
    // Sin hora no se sabe si es de este pedido: no se usa.
    return Number.isFinite(at) && at >= since;
  });
  const own = (m: ChatbyMessage) => !namesAnotherOrder(m.text, input.orderName) || chatbyMentionsOrder(m, input.orderName);
  const fromClient = after.filter((m) => m.kind === "cliente" && own(m));

  let index = -1;
  for (let i = fromClient.length - 1; i >= 0; i--) {
    const m = fromClient[i]!;
    if (!m.button && !m.media && chatbyMentionsOrder(m, input.orderName) && saysConfirm(m.text)) {
      index = i;
      break;
    }
  }

  // Un «no lo quiero» de la clienta, o una nota del equipo que lo anula, pesa
  // más que cualquier confirmación: aunque haya mensaje, es de la asesora.
  const rejected = fromClient.some((m) => !m.button && m.text && customerRejects(m.text));
  const annulled = after.some((m) => m.kind === "nota" && own(m) && /\banulad|\bcancelad/.test(sinTildes(m.text)));
  if (index < 0) {
    if (rejected || annulled) {
      return { confirm: false, final: true, reason: rejected ? "rechazo" : "anulado_en_chat", messageId: null };
    }
    return { confirm: false, final: false, reason: "sin_confirmacion" };
  }

  const message = fromClient[index]!;
  const hold = (reason: ChatbyHoldReason, amountCents: number | null = null): ChatbyVerdict => ({
    confirm: false,
    final: true,
    reason,
    messageId: message.id,
    amountCents,
  });
  if (rejected) return hold("rechazo");
  if (annulled) return hold("anulado_en_chat");
  if (!saysPayAtHome(message.text)) return hold("sin_pago_en_casa");
  const amountCents = confirmationAmountCents(message.text);
  if (amountCents === null) return hold("sin_monto");
  if (!amountMatchesTotal(amountCents, input.totalAmount)) return hold("monto_distinto", amountCents);

  const addr = messageAddress(message.text);
  if (!addr) return hold("sin_direccion", amountCents);
  if (!direccionCompleta(addr) || !direccionCompleta(input.order.address)) return hold("direccion_incompleta", amountCents);
  const match = addressMatchesOrder(addr, input.order);
  if (!match.ok) return hold(match.reason, amountCents);

  // Lo que escribió DESPUÉS: un «gracias» o su ubicación no cambian nada; un
  // «¿puede ser el lunes?» o un audio, sí, y eso lo lee una persona.
  const later = fromClient.slice(index + 1);
  const changes = later.some((m) => {
    if (m.location) return false;
    if (m.media) return true;
    if (m.button) return !saysConfirm(m.text);
    return !isCourtesy(m.text);
  });
  if (changes) return hold("mensaje_posterior", amountCents);

  return { confirm: true, messageId: message.id, at: message.at, amountCents };
}

/**
 * ¿La clienta pulsó el botón «Confirmar pedido» de ESTE pedido? Devuelve la hora
 * del último botón así, o null (owner, 08-11-2026; MOM §6.1 y §42.10).
 *
 * NO CONFIRMA NADA: el botón solo no dice el monto, que paga al recibir ni la
 * dirección, y por eso `evaluateChatbyConfirmation` no lo cuenta (01-11-2026).
 * Se anota en `chatby_auto_checks.evidence.boton_confirmar_at` para que el
 * equipo (y el agente de IA) encuentre a las clientas que dijeron que sí con el
 * botón y todavía no mandaron su mensaje: una llamada corta las confirma.
 *
 * Es de este pedido si es de después de crearse (con el mismo margen de media
 * hora), el botón no nombra otro pedido y el último mensaje del bot o del equipo
 * antes del botón tampoco: con dos pedidos en el mismo chat, el botón de la
 * plantilla del otro no cuenta. PURA.
 */
export function chatbyConfirmButtonAt(messages: readonly ChatbyMessage[], orderName: string, orderCreatedAt: string): string | null {
  const since = Date.parse(orderCreatedAt) - BEFORE_ORDER_MARGIN_MS;
  if (!Number.isFinite(since)) return null;
  const timed = messages
    .map((m) => ({ m, at: m.at ? Date.parse(m.at) : NaN }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at);
  let found: string | null = null;
  for (let i = 0; i < timed.length; i++) {
    const { m, at } = timed[i]!;
    if (at < since || m.kind !== "cliente" || !m.button || !saysConfirm(m.text) || namesAnotherOrder(m.text, orderName)) continue;
    let prompt: ChatbyMessage | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const p = timed[j]!.m;
      if (p.kind === "bot" || p.kind === "equipo") {
        prompt = p;
        break;
      }
    }
    if (prompt && namesAnotherOrder(prompt.text, orderName)) continue;
    found = m.at;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Lo que se escribe
// ---------------------------------------------------------------------------

/**
 * El `operation_id` del intento: el mismo pedido y el mismo mensaje dan siempre
 * el mismo, así que un reintento devuelve el intento ya escrito (§6.1) y no
 * duplica la confirmación ni gasta otro día.
 */
export function chatbyOperationId(orderId: string, messageId: string): string {
  const h = createHash("sha256").update(`chatby:${orderId}:${messageId}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function soles(cents: number): string {
  return `S/ ${(cents / 100).toFixed(2)}`;
}

function limaStamp(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = limaDayKey(iso); // «2026-11-01»
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return ` del ${day.slice(8, 10)}-${day.slice(5, 7)} a las ${time}`;
}

/**
 * La nota del intento: qué dijo, sin copiar la dirección ni el nombre. Lo
 * demás está en Chatby, a un clic desde la ficha.
 */
export function chatbyConfirmationNote(input: {
  orderName: string;
  at: string | null;
  amountCents: number;
  location?: boolean;
  /** (0318) La clienta completó la dirección cuando Kapta se la pidió. */
  addressCorrected?: boolean;
}): string {
  // (owner, 08-11-2026) La dirección escrita estaba incompleta y la clienta
  // mandó después su ubicación de WhatsApp: la guía va con esa ubicación.
  const where = input.addressCorrected
    ? input.location
      ? "la dirección que completó por Chatby y su ubicación de WhatsApp"
      : "la dirección que completó por Chatby"
    : input.location
      ? "la dirección del pedido y su ubicación de WhatsApp (la dirección escrita estaba incompleta)"
      : "la dirección del pedido";
  return (
    `Confirmó por Chatby: mensaje de la clienta${limaStamp(input.at)} con el pedido ${input.orderName}, ` +
    `${soles(input.amountCents)} contra entrega y ${where}.`
  );
}

/** La nota del hecho `chatby_confirmation_held`. */
export function chatbyHoldNote(reason: ChatbyHoldReason, detail?: string | null): string {
  if (isGuideHoldReason(reason)) {
    const why = detail?.trim() ? `${CHATBY_HOLD_REASONS[reason]} (${detail.trim().slice(0, 300)})` : CHATBY_HOLD_REASONS[reason];
    return (
      `La clienta confirmó por Chatby, pero Kapta no creó la guía de Aliclik: ${why} ` +
      "Sigue en Por confirmar: crea la guía desde el panel de Aliclik y registra la confirmación en la mesa."
    );
  }
  return `La clienta escribió por Chatby para confirmar, pero Kapta no lo confirmó solo: ${CHATBY_HOLD_REASONS[reason]} Revísalo en la pestaña Chatby y regístralo en la mesa de confirmación.`;
}

// ---------------------------------------------------------------------------
// La guía
// ---------------------------------------------------------------------------

/**
 * Por qué la guía automática no se intenta para un pedido de Provincia COD en
 * Por confirmar, o null. Uno con envío programado es de la guía del día
 * programado (§6.2): la asesora lo confirma cuando toca.
 */
export function chatbyGuideBlock(row: { dispatch_scheduled_on?: string | null }): "programado" | null {
  return row.dispatch_scheduled_on ? "programado" : null;
}

/** Lo que es de una persona, como en la guía del día programado (§6.2): Shalom elegido o un pago. */
export function chatbyGuideHold(input: { hasShalomDraft: boolean; paymentState: string | null | undefined }): "shalom" | "con_pago" | null {
  if (input.hasShalomDraft) return "shalom";
  if (!NO_PAYMENT.has((input.paymentState ?? "").trim())) return "con_pago";
  return null;
}

/** Cuántas guías automáticas quedan hoy. El tope es de la organización y del día de Lima. */
export function guideCapLeft(createdToday: number, dailyCap: number): number {
  return Math.max(0, Math.floor(dailyCap) - Math.max(0, createdToday));
}

/** El comienzo del día de Lima de `now`, en ISO: desde ahí se cuenta el tope. */
export function limaDayStartIso(now: Date): string {
  return `${limaDayKey(now.toISOString())}T00:00:00-05:00`;
}

/** El motivo del hecho `guide_registered` de una guía automática por Chatby. */
export function chatbyGuideReason(orderName: string | null): string {
  return `Guía automática: ${orderName ?? "el pedido"} confirmó por Chatby.`;
}

// ---------------------------------------------------------------------------
// La coordenada de la guía automática (owner, 02-11-2026)
//
// Aliclik exige coordenada para cotizar, y los pedidos de WooCommerce no traen
// ninguna: las 10 primeras guías automáticas fallaron todas por eso. La que usa
// la asesora en el panel es la ubicación que mandó la clienta por WhatsApp
// (§38); la guía automática usa la misma, con dos condiciones que en el panel
// pone la persona que la mira: que sea de la clienta (nunca del bot ni del
// equipo) y que sea de esta compra, no de un pedido de hace meses. Y pasa por
// la misma puerta del pin respaldado: si el pedido contradice el pin, no hay
// guía automática.

/** Lo más que puede preceder la ubicación al pedido: la conversación que lo trajo. */
export const CHATBY_PIN_MAX_DAYS_BEFORE_ORDER = 3;

/**
 * La ubicación de WhatsApp para la guía automática, como par «lat, lng», o null
 * si la clienta no mandó ninguna en esta compra. Solo la última de la clienta:
 * si esa es vieja, no se busca otra más vieja todavía. Sin fecha no se puede
 * saber si es de esta compra, así que tampoco vale.
 */
export function chatbyGuidePin(
  messages: readonly Pick<ChatbyMessage, "kind" | "location" | "at">[],
  orderCreatedAt: string | null | undefined,
): { coordinate: string; at: string } | null {
  const created = Date.parse(orderCreatedAt ?? "");
  if (!Number.isFinite(created)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind !== "cliente" || !m.location) continue;
    const at = Date.parse(m.at ?? "");
    if (!Number.isFinite(at)) return null;
    if (at < created - CHATBY_PIN_MAX_DAYS_BEFORE_ORDER * 86_400_000) return null;
    return { coordinate: `${m.location.lat}, ${m.location.lng}`, at: m.at! };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mirar el chat hasta que llegue la ubicación (owner, 02-11-2026)
//
// Sin ubicación no hay guía, y sin guía no se confirma: el pedido queda para la
// asesora, que se la pide a la clienta. Mientras dure la ventana, la pasada
// vuelve a leer el chat cada `recheck_minutes`, y cuando la clienta la manda,
// crea la guía (y confirma, si seguía en Por confirmar).

export type ChatbyWatchVerdict =
  | { kind: "confirm"; messageId: string; at: string | null; amountCents: number }
  /** Algo cambió (un rechazo, otra dirección…): ya es de la asesora. */
  | { kind: "hold"; reason: ChatbyHoldReason }
  /** Todavía nada: se vuelve a mirar en la pasada siguiente. */
  | { kind: "wait" };

/**
 * ¿La confirmación del pedido que esperaba su ubicación sigue en pie? La misma
 * evaluación de siempre, con una sola diferencia: lo que escribió después de
 * confirmar (le pidieron la ubicación y contestó «ya te mando») no la anula si
 * lo ÚLTIMO que mandó es su ubicación. Si escribió otra cosa al final, se espera:
 * puede estar por mandarla, y un «¿puede ser el lunes?» lo lee una persona.
 */
export function chatbyLocationWatch(input: Parameters<typeof evaluateChatbyConfirmation>[0]): ChatbyWatchVerdict {
  const v = evaluateChatbyConfirmation(input);
  if (v.confirm) return { kind: "confirm", messageId: v.messageId, at: v.at, amountCents: v.amountCents };
  if (!v.final) return { kind: "wait" };
  if (v.reason !== "mensaje_posterior") return { kind: "hold", reason: v.reason };
  const fromClient = input.messages.filter((m) => m.kind === "cliente");
  const last = fromClient[fromClient.length - 1];
  const original = input.messages.find((m) => m.id === v.messageId);
  if (!last?.location || !v.messageId || v.amountCents == null || !original) return { kind: "wait" };
  return { kind: "confirm", messageId: v.messageId, at: original.at, amountCents: v.amountCents };
}
