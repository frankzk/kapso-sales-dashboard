// Consultar un pedido que YA existe, para el bot de Kapso (MOM §38.13,
// docs/kapso-pedidos-kapta.md sección 10). Solo lectura.
//
// EL CASO (24-10-2026). El checkout de WooCommerce (plugin «COD Core») termina
// en una página de gracias con un botón de WhatsApp que abre el chat con el bot
// de ventas de Kapso con el texto ya escrito: «… deseo confirmar mi pedido
// KP200001 y pagaré S/ 599.60 en casa» + productos + dirección. El bot no sabía
// que ese pedido ya existía: lo volvió a cotizar con sus precios (S/ 665) y
// ofreció «Confirmar pedido», que habría creado un SEGUNDO pedido. El arreglo de
// fondo es una regla del workflow de Kapso (la edita el owner en Kapso, no este
// repo); lo que pone Kapta es esto: una forma autenticada de preguntar «¿existe
// este pedido, y qué dice?» sin crear nada.
//
//   POST /api/internal/orders/<storeId>/lookup
//   Authorization: Bearer <el MISMO secreto del bot>   (Ajustes → «Bot de Kapso → pedidos por Kapta»)
//   { "order_name": "KP200001", "phone": "51965391481" }
//
// LA PRIVACIDAD MANDA. Cualquiera puede escribirle al bot «deseo confirmar mi
// pedido KP200001». Por eso Kapta busca el pedido por su número Y por el celular
// de la conversación A LA VEZ, en la misma consulta (`orders` por el índice
// (store_id, customer_phone) de la 0004): nunca lee el pedido de otro celular, y
// así «no existe» y «existe, pero es de otro celular» son la MISMA respuesta,
// 404 `not_found`, con el mismo cuerpo. No es cortesía: Kapta tampoco sabe cuál
// de las dos es. Un código aparte para «es de otro» le confirmaría a quien
// escribe que ese número de pedido existe (y cuándo, y de qué tienda), y al
// workflow no le sirve de nada: en los dos casos hace lo mismo (una consulta
// más y, si sigue igual, una asesora).
//
// QUÉ CELULAR CUENTA. El del pedido (`orders.customer_phone`: el de facturación
// y, si falta, el de envío, normalizado con `normalizePhone`), comparado con el
// `phone_number` de la conversación de Kapso, también normalizado: con o sin
// 51, +51, espacios o guiones son el mismo. NO el de la guía: la fila del Master
// toma el de la guía solo cuando el pedido no trae celular, y el de la guía es
// el de quien RECIBE (lo pudo escribir el equipo para el courier), no prueba
// que la conversación sea de la clienta. Un pedido sin celular nunca se
// devuelve: lo ve una asesora.
//
// SOLO LECTURA, Y SOLO KAPTA. No escribe nada (ni el último uso de Ajustes, que
// es del endpoint que crea), no llama a WooCommerce ni a Shopify, y no mira la
// plataforma de la tienda: contesta con lo que Kapta tiene. Un pedido que la
// entrada todavía no trajo (el webhook tarda unos segundos; el WooCommerce de
// Kenku aún no está conectado) es `not_found`, reintentable una vez.
//
// TODO TIENE TOPE, como al crear: cada paso de la base espera como mucho
// `BOT_ORDER_DB_TIMEOUT_MS` (`withTimeout`), y son tres como mucho (el secreto,
// el pedido, su fila del Master): la respuesta sale antes de `maxDuration`.
//
// SIN DATOS DE LA CLIENTA EN LOS REGISTROS: una línea `[bot-orders-lookup]` por
// llamada con la tienda, el número de pedido consultado, el resultado, el código
// HTTP y los milisegundos. Nunca el celular ni la dirección.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BOT_ORDER_DB_TIMEOUT_MS,
  StepTimeout,
  authenticateBotCall,
  botOrdersEndpointUrl,
  scrubForLog,
  withTimeout,
} from "@/lib/bot-orders";
import { macroStageLabel, macroSubstageLabel } from "@/lib/order-macro-stage";
import { orderFullyPaid } from "@/lib/order-paid";
import type { PaymentGateway } from "@/lib/payment-gateway";
import { normalizePhone } from "@/lib/phone";
import { shopifyShippingAddress } from "@/lib/shopify-address";

// ---------------------------------------------------------------------------
// Constantes del contrato (docs/kapso-pedidos-kapta.md, sección 10)
// ---------------------------------------------------------------------------

/** Lo que se le suma a la dirección del bot (`botOrdersEndpointUrl`). */
export const BOT_ORDER_LOOKUP_SUFFIX = "/lookup";

/** La dirección de la consulta: la de crear + `/lookup`. */
export function botOrderLookupUrl(appUrl: string, storeId: string): string {
  return `${botOrdersEndpointUrl(appUrl, storeId)}${BOT_ORDER_LOOKUP_SUFFIX}`;
}

/** El cuerpo, como mucho: son dos campos cortos. */
export const BOT_ORDER_LOOKUP_MAX_BODY_BYTES = 2_048;

/** Los campos que acepta el cuerpo. Cualquier otro es un error (un typo no se ignora). */
export const BOT_ORDER_LOOKUP_FIELDS = ["order_name", "phone"] as const;

/**
 * Cuánto esperar antes de la ÚNICA consulta más (`not_found` y los fallos
 * reintentables): lo que suele tardar el webhook de WooCommerce en traer un
 * pedido recién hecho, con margen.
 */
export const BOT_ORDER_LOOKUP_RETRY_AFTER_S = 10;
/** Cuántas consultas más hace el bot por mensaje antes de derivar a una asesora. */
export const BOT_ORDER_LOOKUP_MAX_RETRIES = 1;

/** Los códigos que el bot lee. Estables: cambiar uno rompe el workflow de Kapso. */
export const BOT_ORDER_LOOKUP_CODES = [
  "unauthorized",
  "body_too_large",
  "invalid_body",
  "not_found",
  "store_unavailable",
  "migration_missing",
  "internal_error",
] as const;
export type BotOrderLookupCode = (typeof BOT_ORDER_LOOKUP_CODES)[number];

/** El código HTTP de cada uno. Los que comparte con el endpoint que crea, con el mismo. */
export const BOT_ORDER_LOOKUP_HTTP: Readonly<Record<BotOrderLookupCode, number>> = Object.freeze({
  unauthorized: 401,
  body_too_large: 413,
  invalid_body: 400,
  not_found: 404,
  store_unavailable: 503,
  migration_missing: 503,
  internal_error: 500,
});

/** ¿Una consulta más puede salir bien? (Una sola: `BOT_ORDER_LOOKUP_MAX_RETRIES`.) */
export const BOT_ORDER_LOOKUP_RETRYABLE: ReadonlySet<BotOrderLookupCode> = new Set<BotOrderLookupCode>([
  "not_found",
  "store_unavailable",
  "internal_error",
]);

/** Lo que se le dice al bot ante `not_found`: lo mismo exista o no el pedido con otro celular. */
export const BOT_ORDER_LOOKUP_NOT_FOUND_MESSAGE =
  "Kapta no tiene un pedido con ese número para este celular. Puede que todavía no haya llegado: consulta una vez más en 10 s; si sigue igual, deriva a una asesora. No cotices ni crees otro pedido.";

export const BOT_ORDER_LOOKUP_MIGRATION_MISSING = "Falta aplicar la migración 0277 (pedidos del bot) en la base.";

// ---------------------------------------------------------------------------
// El cuerpo
// ---------------------------------------------------------------------------

/**
 * El número de un pedido: letras (el prefijo de la tienda) y dígitos, con o sin
 * «#» delante. Un espacio solo después del «#» o entre el prefijo y los
 * dígitos: «pedido KP200001» NO es «#PEDIDOKP200001».
 */
const ORDER_NAME_RE = /^#*\s*([A-Z]{1,10})\s*([0-9]{1,12})$/;

/**
 * El número de pedido como lo guarda Kapta (`orders.name`, «#KP200001»), o null
 * si no es uno. Acepta lo que puede llegar de un mensaje: con o sin «#», en
 * minúsculas, con un espacio («kp 200001»), en ancho completo. PURA.
 */
export function normalizeBotOrderName(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const m = ORDER_NAME_RE.exec(raw.normalize("NFKC").trim().toUpperCase());
  return m ? `#${m[1]}${m[2]}` : null;
}

/**
 * El celular de la conversación, normalizado (`normalizePhone`: dígitos, con
 * el 51 en un celular peruano de 9), o null. No exige que sea peruano: la
 * clienta puede escribir desde un WhatsApp extranjero y haber dejado ese número
 * en el checkout. Solo que parezca un número (de 8 a 15 dígitos, E.164). PURA.
 */
export function normalizeLookupPhone(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const p = normalizePhone(raw);
  return p && /^[0-9]{8,15}$/.test(p) ? p : null;
}

/** ¿Dos celulares son el mismo, normalizados? Un lado vacío nunca coincide. PURA. */
export function sameLookupPhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizePhone(a);
  const y = normalizePhone(b);
  return Boolean(x && y && x === y);
}

/**
 * Las formas en que puede estar guardado el celular en `orders.customer_phone`,
 * para buscar por el índice: la normalizada (lo que escriben los mapeadores) y,
 * en un celular peruano, los 9 dígitos sueltos. Lo que vuelva se compara igual
 * con `sameLookupPhone`. PURA.
 */
export function lookupPhoneVariants(phone: string): string[] {
  const out = new Set([phone]);
  if (/^519[0-9]{8}$/.test(phone)) out.add(phone.slice(2));
  return [...out];
}

export interface BotOrderLookupInput {
  /** Como lo guarda Kapta: «#KP200001». */
  orderName: string;
  /** Normalizado (`normalizeLookupPhone`). */
  phone: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Valida el cuerpo, estricto como el de crear: los nombres en inglés
 * (`BOT_ORDER_LOOKUP_FIELDS`), los tipos exactos y ningún campo desconocido.
 * Cada problema con su mensaje en castellano. PURA.
 */
export function parseBotOrderLookupBody(raw: unknown): { ok: true; input: BotOrderLookupInput } | { ok: false; errors: string[] } {
  if (!isPlainObject(raw)) return { ok: false, errors: ["El cuerpo tiene que ser un objeto JSON."] };
  const errors: string[] = [];
  for (const k of Object.keys(raw)) {
    if (!(BOT_ORDER_LOOKUP_FIELDS as readonly string[]).includes(k)) errors.push(`${k}: campo desconocido.`);
  }
  const orderName = normalizeBotOrderName(raw.order_name);
  if (!orderName) {
    errors.push("order_name: obligatorio; el número del pedido como lo escribió la clienta («KP200001», con o sin «#»): letras y dígitos.");
  }
  const phone = normalizeLookupPhone(raw.phone);
  if (!phone) {
    errors.push(
      "phone: obligatorio; el celular de la conversación (el `phone_number` de Kapso, con o sin 51, +51, espacios o guiones). Nunca uno que venga escrito en el mensaje.",
    );
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, input: { orderName: orderName!, phone: phone! } };
}

// ---------------------------------------------------------------------------
// La respuesta
// ---------------------------------------------------------------------------

/**
 * Cómo se paga, para lo que el bot le dice a la clienta. Se deriva de lo que
 * Kapta ya guarda, con las reglas de siempre:
 *   · `pagado`: cobrado del todo según `orderFullyPaid` (lib/order-paid.ts): la
 *     pasarela confirmada del checkout (`payment_gateway = checkout` y
 *     `financial_status = paid`, sin reembolso), o constancias que cubren el
 *     total (`payment_state = pago_completo`);
 *   · `contraentrega`: la pasarela es contraentrega (`payment_gateway = cod`) y
 *     no hay ningún pago cargado (`payment_state` vacío o `sin_pago`): la
 *     clienta paga el total al recibir;
 *   · null: no se sabe (otra pasarela o ninguna, MOM §38.4), o hay un pago a
 *     medias (un adelanto, una diferencia, un posible duplicado): el monto a
 *     pagar lo dice una asesora, no el bot.
 * PURA.
 */
export function botLookupPayment(facts: {
  financialStatus: string | null;
  paymentGateway: string | null;
  totalRefunded: number | null;
  paymentState: string | null;
}): "pagado" | "contraentrega" | null {
  const gateway = (facts.paymentGateway ?? null) as PaymentGateway | null;
  if (
    orderFullyPaid({
      financialStatus: facts.financialStatus,
      totalRefunded: facts.totalRefunded,
      paymentGateway: gateway,
      paymentState: facts.paymentState,
    })
  ) {
    return "pagado";
  }
  if (gateway === "cod" && (facts.paymentState == null || facts.paymentState === "sin_pago")) return "contraentrega";
  return null;
}

/** `orders.shipping_mode` con las palabras del contrato (las mismas que el bot manda al crear). */
const DELIVERY_MODE: Readonly<Record<string, "contraentrega" | "agencia">> = Object.freeze({
  cod: "contraentrega",
  agency: "agencia",
});

/** El pedido, para el bot. Cada campo está en el contrato (sección 10). */
export interface BotOrderLookupOrder {
  /** «#KP200001», como en Kapta. */
  name: string;
  platform: "shopify" | "woocommerce";
  /** La fecha del pedido (ISO, UTC). */
  created_at: string | null;
  /** El total que Kapta tiene HOY (`orders.total_amount`): el que se le dice a la clienta. */
  total: number | null;
  currency: string | null;
  payment: "pagado" | "contraentrega" | null;
  /** Anulado en la tienda (`cancelled_at`) o en Kapta (estado general «Anulado»). */
  cancelled: boolean;
  delivery: {
    /** `contraentrega` (a domicilio), `agencia` (recoge en agencia) o null (el pedido no lo dice). */
    mode: "contraentrega" | "agencia" | null;
    district: string | null;
    address1: string | null;
  };
  /** Los productos: título, variante (talla, color) y cantidad. Sin precios: el monto es `total`. */
  items: { title: string; variant: string | null; quantity: number }[];
  /** El estado en el Master, con sus nombres de pantalla; null si su fila todavía no está. */
  master: { stage: string; stage_label: string; substage: string; substage_label: string } | null;
}

export interface BotOrderLookupSuccessBody {
  ok: true;
  order: BotOrderLookupOrder;
}
export interface BotOrderLookupFailureBody {
  ok: false;
  code: BotOrderLookupCode;
  message: string;
  /** Una consulta más puede salir bien (UNA: `BOT_ORDER_LOOKUP_MAX_RETRIES`). */
  retryable: boolean;
  retry_after_seconds?: number;
  /** Solo `invalid_body`: cada problema. */
  errors?: string[];
}
export type BotOrderLookupBody = BotOrderLookupSuccessBody | BotOrderLookupFailureBody;
export interface BotOrderLookupResult {
  status: number;
  body: BotOrderLookupBody;
}

/** Lo que se lee de `orders`: lo justo para la respuesta y para comparar el celular. */
interface LookupOrderRow {
  id: string;
  name: string | null;
  platform: string | null;
  created_at: string | null;
  total_amount: number | string | null;
  currency: string | null;
  financial_status: string | null;
  payment_gateway: string | null;
  total_refunded: number | string | null;
  cancelled_at: string | null;
  customer_phone: string | null;
  shipping_mode: string | null;
  line_items: unknown;
  raw: unknown;
}
const ORDER_COLUMNS =
  "id,name,platform,created_at,total_amount,currency,financial_status,payment_gateway,total_refunded,cancelled_at,customer_phone,shipping_mode,line_items,raw";

/** Lo que se lee de `order_master`: el estado, la dirección vigente y lo cobrado. */
interface LookupMasterRow {
  general_status: string | null;
  macro_stage: string | null;
  macro_substage: string | null;
  district: string | null;
  address: string | null;
  payment_state: string | null;
}
const MASTER_COLUMNS = "general_status,macro_stage,macro_substage,district,address,payment_state";

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function textOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  return t || null;
}

/** Las líneas del pedido, sin precios, y sin las que no tienen unidades. PURA. */
export function botLookupItems(lineItems: unknown): BotOrderLookupOrder["items"] {
  if (!Array.isArray(lineItems)) return [];
  const out: BotOrderLookupOrder["items"] = [];
  for (const li of lineItems) {
    if (!isPlainObject(li)) continue;
    const quantity = numOrNull(li.quantity);
    const title = textOrNull(li.title);
    if (!title || quantity == null || quantity <= 0) continue;
    out.push({ title, variant: textOrNull(li.variant_title), quantity });
  }
  return out;
}

/**
 * La respuesta, de la fila del pedido y la del Master (si ya está). La
 * dirección y el distrito, los VIGENTES: los de la fila del Master (con la
 * corrección del equipo si la hubo, 0051) y, sin ella, los del pedido. PURA.
 */
export function botLookupOrder(order: LookupOrderRow, master: LookupMasterRow | null): BotOrderLookupOrder {
  const ship = shopifyShippingAddress(order.raw);
  const stage = textOrNull(master?.macro_stage);
  const substage = textOrNull(master?.macro_substage);
  return {
    name: order.name ?? "",
    platform: order.platform === "woocommerce" ? "woocommerce" : "shopify",
    created_at: order.created_at ?? null,
    total: numOrNull(order.total_amount),
    currency: order.currency ?? null,
    payment: botLookupPayment({
      financialStatus: order.financial_status,
      paymentGateway: order.payment_gateway,
      totalRefunded: numOrNull(order.total_refunded),
      paymentState: master?.payment_state ?? null,
    }),
    cancelled: order.cancelled_at != null || master?.general_status === "anulado",
    delivery: {
      mode: DELIVERY_MODE[order.shipping_mode ?? ""] ?? null,
      district: textOrNull(master?.district) ?? textOrNull(ship?.city),
      address1: textOrNull(master?.address) ?? textOrNull(ship?.address1),
    },
    items: botLookupItems(order.line_items),
    master:
      stage && substage
        ? { stage, stage_label: macroStageLabel(stage), substage, substage_label: macroSubstageLabel(substage) }
        : null,
  };
}

// ---------------------------------------------------------------------------
// La llamada
// ---------------------------------------------------------------------------

export interface BotOrderLookupDeps {
  admin: SupabaseClient;
  /** El registro de UNA línea por llamada. */
  log?: (line: string, level: "info" | "warn" | "error") => void;
  /** La hora (los milisegundos del registro). */
  now?: () => number;
  /** Tope de cada paso de la base (`BOT_ORDER_DB_TIMEOUT_MS`). */
  dbTimeoutMs?: number;
}

export interface BotOrderLookupRequest {
  storeId: string;
  authorization: string | null;
  /** El cuerpo ya leído (pruebas). Si no, `readBody`. */
  rawBody?: string;
  /** Lee el cuerpo con tope, DESPUÉS del secreto: null si pasa de `maxBytes`. */
  readBody?: (maxBytes: number) => Promise<string | null>;
  /** `Content-Length`, si vino: de más, 413 antes de leer nada. */
  contentLength?: string | null;
}

function lookupFail(code: BotOrderLookupCode, message: string, extra: Partial<BotOrderLookupFailureBody> = {}): BotOrderLookupResult {
  const retryable = BOT_ORDER_LOOKUP_RETRYABLE.has(code);
  return {
    status: BOT_ORDER_LOOKUP_HTTP[code],
    body: {
      ok: false,
      code,
      message,
      retryable,
      ...(retryable ? { retry_after_seconds: BOT_ORDER_LOOKUP_RETRY_AFTER_S } : {}),
      ...extra,
    },
  };
}

const defaultLog = (line: string, level: "info" | "warn" | "error") => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
};

/**
 * Una consulta del bot, de punta a punta. Nunca lanza: devuelve el código HTTP y
 * el cuerpo. En este orden:
 *   0. el tamaño declarado: de más, 413 sin leer nada ni consultar la base;
 *   1. el secreto (`authenticateBotCall`, la misma puerta que al crear): 401
 *      sin detalles. Recién entonces se lee el cuerpo, con tope;
 *   2. el cuerpo, estricto (`parseBotOrderLookupBody`): 400 con cada problema;
 *   3. el pedido por número Y celular a la vez (`orders`, hasta 5, el más
 *      reciente primero), y el celular otra vez comparado en memoria
 *      (`sameLookupPhone`): ninguno, 404 `not_found`;
 *   4. su fila del Master (`order_master` por `order_id`). Si no está, no
 *      contesta o falla, la respuesta sale igual con `master: null` y la
 *      dirección del pedido: lo que importa (el número, el total, los
 *      productos) es del pedido.
 */
export async function handleBotOrderLookup(req: BotOrderLookupRequest, deps: BotOrderLookupDeps): Promise<BotOrderLookupResult> {
  const { admin } = deps;
  const now = deps.now ?? Date.now;
  const started = now();
  const dbMs = deps.dbTimeoutMs ?? BOT_ORDER_DB_TIMEOUT_MS;
  const step = <T,>(label: string, work: PromiseLike<T>) => withTimeout(work, dbMs, label);
  const log = deps.log ?? defaultLog;
  const storeId = String(req.storeId ?? "");
  const line: Record<string, unknown> = { store: storeId };

  const finish = (result: BotOrderLookupResult, extra: Record<string, unknown> = {}): BotOrderLookupResult => {
    const entry = {
      ...line,
      outcome: result.body.ok ? "ok" : result.body.code,
      status: result.status,
      ms: Math.max(0, now() - started),
      ...extra,
    };
    // `not_found` es un resultado esperado (el pedido aún no llegó, o no es de
    // ese celular): info, no warn.
    const level = result.status >= 500 ? "error" : result.status >= 400 && result.status !== 404 ? "warn" : "info";
    log(`[bot-orders-lookup] ${JSON.stringify(entry)}`, level);
    return result;
  };

  try {
    // 0) El tamaño declarado: de más, sin leer nada (ni la base).
    const declared = req.contentLength == null || req.contentLength === "" ? NaN : Number(req.contentLength);
    if (Number.isFinite(declared) && declared > BOT_ORDER_LOOKUP_MAX_BODY_BYTES) {
      return finish(lookupFail("body_too_large", `El cuerpo pasa de ${BOT_ORDER_LOOKUP_MAX_BODY_BYTES} bytes.`));
    }

    // 1) El secreto: la misma puerta que al crear.
    const auth = await authenticateBotCall({ admin, storeId, authorization: req.authorization, step });
    if (!auth.ok) {
      return finish(lookupFail(auth.code, auth.code === "migration_missing" ? BOT_ORDER_LOOKUP_MIGRATION_MISSING : auth.message));
    }

    // 2) El cuerpo: recién ahora se lee, con tope.
    const rawBody = req.rawBody ?? (req.readBody ? await req.readBody(BOT_ORDER_LOOKUP_MAX_BODY_BYTES) : "");
    if (rawBody == null || Buffer.byteLength(rawBody, "utf8") > BOT_ORDER_LOOKUP_MAX_BODY_BYTES) {
      return finish(lookupFail("body_too_large", `El cuerpo pasa de ${BOT_ORDER_LOOKUP_MAX_BODY_BYTES} bytes.`));
    }
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return finish(lookupFail("invalid_body", "El cuerpo no es JSON."));
    }
    const parsed = parseBotOrderLookupBody(raw);
    if (!parsed.ok) {
      return finish(lookupFail("invalid_body", "La consulta tiene datos que faltan o no sirven.", { errors: parsed.errors }));
    }
    const { orderName, phone } = parsed.input;
    line.order = orderName;

    // 3) El pedido: por su número Y el celular de la conversación, en la misma
    // consulta. Nunca se lee uno de otro celular.
    const found = await step(
      "order",
      admin
        .from("orders")
        .select(ORDER_COLUMNS)
        .eq("store_id", storeId)
        .in("customer_phone", lookupPhoneVariants(phone))
        .eq("name", orderName)
        .order("created_at", { ascending: false })
        .limit(5),
    );
    if (found.error) {
      return finish(lookupFail("store_unavailable", "No se pudo leer el pedido. Consulta una vez más en unos segundos."), {
        error: scrubForLog(found.error.message ?? "error", 200),
      });
    }
    const rows = ((found.data ?? []) as unknown as LookupOrderRow[])
      // Otra vez en memoria: lo que sale de aquí tiene que ser de ese celular.
      .filter((r) => r && r.name === orderName && sameLookupPhone(r.customer_phone, phone))
      .sort((a, b) => (Date.parse(b.created_at ?? "") || 0) - (Date.parse(a.created_at ?? "") || 0));
    const order = rows[0];
    if (!order) return finish(lookupFail("not_found", BOT_ORDER_LOOKUP_NOT_FOUND_MESSAGE));

    // 4) Su fila del Master: el estado, la dirección vigente y lo cobrado. Si
    // falta o falla, se contesta con lo del pedido.
    let master: LookupMasterRow | null = null;
    try {
      const m = await step(
        "master",
        admin.from("order_master").select(MASTER_COLUMNS).eq("store_id", storeId).eq("order_id", order.id).maybeSingle(),
      );
      if (m.error) line.master = "error";
      else master = (m.data as LookupMasterRow | null) ?? null;
      if (!m.error && !master) line.master = "missing";
    } catch (e) {
      line.master = e instanceof StepTimeout ? "timeout" : "error";
    }

    const body: BotOrderLookupSuccessBody = { ok: true, order: botLookupOrder(order, master) };
    return finish({ status: 200, body }, { platform: body.order.platform });
  } catch (e) {
    const error = scrubForLog(e instanceof Error ? e.message : "error", 200);
    if (e instanceof StepTimeout) {
      return finish(lookupFail("store_unavailable", "La base de Kapta no contestó a tiempo. Consulta una vez más en unos segundos."), { error });
    }
    return finish(lookupFail("internal_error", "Error interno de Kapta. Consulta una vez más en unos segundos."), { error });
  }
}
