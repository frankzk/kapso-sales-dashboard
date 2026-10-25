// Los pedidos del bot de Kapso, creados por Kapta en WooCommerce (MOM §38.13,
// plan D5 del owner, 23-10-2026).
//
// Hasta el cierre de Shopify el bot crea sus pedidos directamente en Shopify.
// Desde el corte, en una tienda con `stores.platform = 'woocommerce'`, le pide
// el pedido a Kapta (`POST /api/internal/orders/<storeId>`), y Kapta lo crea con
// el MISMO núcleo que «Generar pedido» (§38.12): `buildWooSaleOrder` y
// `createWooSaleOrder` (pending → comparación con lo pactado → processing, o
// borrado si no cuadra). Un solo camino, con las mismas marcas que la entrada
// reconoce: `kapta_channel = kapso` y `kapso_conversation_id` (§38.5), y
// después los mismos pasos que la entrada da a un pedido del bot
// (`applyWooOrderEffects`: rollups, lead ganado, fila del Master).
//
// Consultar un pedido que YA existe, sin crear nada (la página de gracias de la
// web, 24-10-2026): `POST /api/internal/orders/<storeId>/lookup`, en
// lib/bot-order-lookup.ts, con la misma puerta (`authenticateBotCall`) y el
// mismo tope de la base (`withTimeout`, `BOT_ORDER_DB_TIMEOUT_MS`).
//
// EL ORDEN DE UNA LLAMADA (`handleBotOrder`):
//   0. el tamaño declarado (`Content-Length`): de más, 413 sin leer nada;
//   1. el secreto: `Authorization: Bearer <secreto>`, comparado en tiempo
//      constante con el sha256 guardado de la tienda (`bot_order_secrets`,
//      0277). Sin él, 401 sin detalles. Recién entonces se lee el cuerpo, con
//      tope (`BOT_ORDER_MAX_BODY_BYTES`);
//   2. el cuerpo, validado estricto (`parseBotOrderBody`): 400 con cada
//      problema. Antes que la plataforma, para que el equipo de Kapso pueda
//      probar su acción contra una tienda todavía en Shopify: un 409
//      `wrong_platform` quiere decir «el cuerpo está bien»;
//   3. la tienda: activa y en WooCommerce (`loadStoreOrderPlatform`). Si no,
//      409 y NINGUNA llamada a WooCommerce ni a Shopify: el bot deriva a una
//      asesora. Este endpoint nunca crea un pedido en Shopify;
//   4. el candado (`bot_order_requests`, unique (store_id, request_id)): la
//      primera llamada inserta su fila y recién entonces crea; otra con el
//      mismo id choca con la fila y no llama a WooCommerce (ver
//      `claimBotOrder`);
//   5. el pedido en WooCommerce, con el reloj de la llamada
//      (`BOT_ORDER_SALE_DEADLINE_MS`); apenas existe, su id queda en el candado
//      (`woo_order_id`), y apenas está vivo, el candado se cierra con él
//      (`done`) ANTES de la fila local (`mapWooOrder` + `insertOrderIfAbsent`):
//      lo que importa para no crear otro es el candado, no la fila;
//   6. después de responder: los pasos de la entrada, el carrito del lead si
//      el bot lo cerró, el aviso en el lead si quedó un pedido a medias, y el
//      último uso en Ajustes.
//
// TODO TIENE TOPE. Cada lectura y escritura de la base espera como mucho
// `BOT_ORDER_DB_TIMEOUT_MS`, y la venta termina a los
// `BOT_ORDER_SALE_DEADLINE_MS` de empezada la llamada: la respuesta sale antes
// de los 60 s de la función, y un candado vivo nunca llega a su plazo.
//
// SIN DATOS DE LA CLIENTA EN LOS REGISTROS. Cada llamada deja UNA línea
// `[bot-orders]` con la tienda, el comienzo del sha256 del request_id, el
// resultado, el código HTTP, los milisegundos y el id de WooCommerce: nunca el
// teléfono, el nombre ni la dirección.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyWooOrderEffects } from "@/lib/ingest";
import { insertOrderIfAbsent } from "@/lib/order-sale";
import { debeGuardarTelefono } from "@/lib/lead-sin-numero";
import { normalizePhone, peruMobileProblem } from "@/lib/phone";
import { priceMismatchRejection, resolveOrderDiscount, type OrderDiscountInput } from "@/lib/shopify";
import { TAGS } from "@/lib/types";
import { mapWooOrder, toWooPeruState, type WooClientOpts, type WooOrder } from "@/lib/woocommerce";
import {
  WOO_BOT_SALE_CHANNEL,
  WOO_SALE_BUDGET_MS,
  WOO_SALE_LOOKBACK_MS,
  buildWooSaleOrder,
  createWooSaleOrder,
  wooCleanupText,
  wooLineRejection,
  wooSaleClient,
  wooSaleLinesProblem,
  loadStoreOrderPlatform,
  type WooApiCreds,
  type WooSaleErrorCleanup,
  type WooSaleOutcome,
  type WooSaleTimeouts,
} from "@/lib/woocommerce-orders";
import type { OrderRow } from "@/lib/types";

// ---------------------------------------------------------------------------
// Constantes del contrato (docs/kapso-pedidos-kapta.md)
// ---------------------------------------------------------------------------

/** La ruta, sin la tienda. */
export const BOT_ORDERS_PATH = "/api/internal/orders";

/** La dirección que se pega en la acción de Kapso. */
export function botOrdersEndpointUrl(appUrl: string, storeId: string): string {
  return `${appUrl.replace(/\/+$/, "")}${BOT_ORDERS_PATH}/${storeId}`;
}

/**
 * El canal del pedido: `kapso` (etiquetas `kapso` y `whatsapp`, «Chatbot
 * WhatsApp» y «Bot de Kapso», §38.5 y §17.3), también cuando el bot cierra un
 * carrito (`cart_draft_gid`).
 */
export const BOT_ORDER_CHANNEL = WOO_BOT_SALE_CHANNEL;

/**
 * Prefijo del `kapta_request_id` en WooCommerce. El id del bot va con él, así
 * nunca se confunde con el id de un formulario de «Generar pedido».
 */
export const BOT_ORDER_REQUEST_PREFIX = "kapso-";

/**
 * Las filas de `bot_order_requests` que NO son del bot: el candado de
 * «Generar pedido» en WooCommerce (lib/woo-sale-guard.ts, MOM §38.12) usa la
 * misma tabla con la llave `form-<id del formulario>`. El tope por minuto del
 * bot no las cuenta.
 */
export const WOO_FORM_GUARD_PREFIX = "form-";

/**
 * Cuánto vale un candado que no terminó. Más que la función entera
 * (`maxDuration` 60 s; la venta termina a los `BOT_ORDER_SALE_DEADLINE_MS`): un
 * candado vivo nunca se retoma. Y deja que un POST sin respuesta termine en
 * WordPress antes de que otro intento lo busque (`postUnanswered`).
 */
export const BOT_ORDER_CLAIM_TTL_MS = 120_000;

/** Cuánto esperar antes de reintentar con el mismo request_id (lo que se sugiere al bot). */
export const BOT_ORDER_RETRY_AFTER_S = 10;
/**
 * `duplicate_in_progress`: lo que le falta al candado, entre estos dos. Corto
 * aunque falte más: la llamada que lo tiene suele terminar en segundos.
 */
export const BOT_ORDER_RETRY_AFTER_MIN_S = 5;
export const BOT_ORDER_RETRY_AFTER_MAX_S = 15;
/**
 * Cuánto sigue reintentando el bot con el mismo request_id antes de derivar
 * (el contrato). Más que el plazo del candado con margen: en ese tiempo la
 * respuesta siempre pasa a ser otra cosa que `duplicate_in_progress`.
 */
export const BOT_ORDER_RETRY_WINDOW_S = 180;

/** Tope de cada lectura o escritura de la base en una llamada. */
export const BOT_ORDER_DB_TIMEOUT_MS = 5_000;
/**
 * La venta en WooCommerce termina a lo más a estos ms de empezada la llamada
 * (lo que tardó la base antes se le descuenta; nunca más que
 * `WOO_SALE_BUDGET_MS`). Después quedan cerrar el candado y la fila local, con
 * su tope cada uno: todo antes de los 60 s de la función.
 */
export const BOT_ORDER_SALE_DEADLINE_MS = 42_000;

/**
 * Un candado que no terminó y no sabe qué pedido creó (`woo_order_id` vacío)
 * no se retoma pasada esta edad: la búsqueda del intento anterior mira 2 horas
 * (`WOO_SALE_LOOKBACK_MS`), y con media hora de margen por relojes, un pedido
 * de ese intento podría no verse y se crearía otro. Se contesta `expired`.
 */
export const BOT_ORDER_RETAKE_MAX_AGE_MS = WOO_SALE_LOOKBACK_MS - 30 * 60_000;

/**
 * Otro request_id con EXACTAMENTE lo mismo (la misma huella: conversación,
 * celular, dirección, productos, precios, nota) dentro de esta ventana es el
 * mismo pedido pedido dos veces (una herramienta llamada dos veces, un paso
 * que se volvió a correr): se devuelve el primero, no se crea otro.
 */
export const BOT_ORDER_SAME_BODY_WINDOW_MS = 10 * 60_000;

/**
 * Pedidos nuevos por tienda y minuto, como mucho. Hoy son ~31 por DÍA: el tope
 * solo frena un bot en bucle que manda ids nuevos (cada uno sería un pedido).
 */
export const BOT_ORDER_RATE_PER_MINUTE = 20;

/** El cuerpo, como mucho. */
export const BOT_ORDER_MAX_BODY_BYTES = 16_384;
/** Productos por pedido, como mucho. */
export const BOT_ORDER_MAX_ITEMS = 20;
/** Unidades por línea, como mucho. */
export const BOT_ORDER_MAX_QUANTITY = 99;

/** Las etiquetas que el bot puede mandar en `tags` (las de hoy en Shopify, `TAGS`). */
export const BOT_ORDER_TAGS: readonly string[] = Object.freeze([TAGS.promo, TAGS.stockPorValidar]);

/**
 * `shipping_mode`: como lo dice el bot (`check-coverage` contesta
 * `contraentrega` o `agencia`) → como lo guarda Kapta (`cod`, `agency`).
 */
export const BOT_ORDER_SHIPPING_MODES: Readonly<Record<string, "cod" | "agency">> = Object.freeze({
  cod: "cod",
  contraentrega: "cod",
  agency: "agency",
  agencia: "agency",
});

/** El prefijo de los secretos que genera Ajustes. */
export const BOT_SECRET_PREFIX = "kbot_";

/** Los códigos que el bot lee. Estables: cambiar uno rompe el workflow de Kapso. */
export const BOT_ORDER_CODES = [
  "unauthorized",
  "body_too_large",
  "invalid_body",
  "agency_needs_advisor",
  "wrong_platform",
  "store_inactive",
  "rate_limited",
  "duplicate_in_progress",
  "conflict",
  "expired",
  "sku_not_found",
  "price_mismatch",
  "order_mismatch",
  "woocommerce_unavailable",
  "store_unavailable",
  "migration_missing",
  "internal_error",
] as const;
export type BotOrderCode = (typeof BOT_ORDER_CODES)[number];

/** El código HTTP de cada uno. */
export const BOT_ORDER_HTTP: Readonly<Record<BotOrderCode, number>> = Object.freeze({
  unauthorized: 401,
  body_too_large: 413,
  invalid_body: 400,
  agency_needs_advisor: 422,
  wrong_platform: 409,
  store_inactive: 409,
  rate_limited: 429,
  duplicate_in_progress: 409,
  conflict: 409,
  expired: 409,
  sku_not_found: 422,
  price_mismatch: 422,
  order_mismatch: 422,
  woocommerce_unavailable: 503,
  store_unavailable: 503,
  migration_missing: 503,
  internal_error: 500,
});

/** ¿Reintentar con el MISMO request_id puede salir bien? (Nunca crea un segundo pedido.) */
export const BOT_ORDER_RETRYABLE: ReadonlySet<BotOrderCode> = new Set<BotOrderCode>([
  "rate_limited",
  "duplicate_in_progress",
  "woocommerce_unavailable",
  "store_unavailable",
  "internal_error",
]);

// ---------------------------------------------------------------------------
// El secreto
// ---------------------------------------------------------------------------

/** sha256 hexadecimal: lo único que se guarda del secreto (`bot_order_secrets.secret_hash`). */
export function hashBotSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Un secreto nuevo: `kbot_` + 32 bytes al azar en base64url (sin nada que una cabecera transforme). */
export function generateBotSecret(): string {
  return `${BOT_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** El token de `Authorization: Bearer <token>`, o null. */
export function bearerToken(header: string | null | undefined): string | null {
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m ? m[1]! : null;
}

/**
 * ¿El secreto que llegó es el de la tienda? Se compara el sha256 de lo que
 * llegó con el guardado, en tiempo constante (`timingSafeEqual` sobre los 32
 * bytes de cada uno): ni la longitud ni el contenido del secreto cambian
 * cuánto tarda.
 */
export function botSecretMatches(provided: string | null | undefined, storedHash: string | null | undefined): boolean {
  if (!provided || !storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** «No existe» de Postgres (42P01) y de PostgREST (PGRST205). */
const MISSING_CODES: ReadonlySet<string> = new Set(["42P01", "PGRST205"]);
const BOT_ORDER_OBJECTS = /\b(?:bot_order_secrets|bot_order_requests)\b/;

/** ¿Falta aplicar la 0277? Otra tabla que falta es una base rota, no esto. */
export function isBotOrdersMigrationMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  if (typeof e.code !== "string" || !MISSING_CODES.has(e.code)) return false;
  return [e.message, e.details, e.hint].some((t) => typeof t === "string" && BOT_ORDER_OBJECTS.test(t));
}

export const BOT_ORDERS_MIGRATION_MISSING =
  "Falta aplicar la migración 0277 (pedidos del bot) en la base: no se creó nada.";

// ---------------------------------------------------------------------------
// El cuerpo
// ---------------------------------------------------------------------------

/**
 * Lee un cuerpo con tope: el texto, o null si pasa de `maxBytes` (se corta la
 * lectura ahí, sin juntar el resto en memoria).
 */
export async function readBodyCapped(body: ReadableStream<Uint8Array> | null | undefined, maxBytes: number): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Los campos que acepta el cuerpo. Cualquier otro es un error (un typo no se ignora). */
export const BOT_ORDER_FIELDS = [
  "request_id",
  "conversation_id",
  "phone",
  "customer_name",
  "address1",
  "reference",
  "district",
  "department",
  "items",
  "discount",
  "shipping_mode",
  "tags",
  "note",
  "cart_draft_gid",
] as const;
const ITEM_FIELDS = ["sku", "quantity", "unit_price", "name"] as const;
const DISCOUNT_FIELDS = ["kind", "value"] as const;

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9:/._-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lo pedido, validado y normalizado. */
export interface BotOrderInput {
  requestId: string;
  conversationId: string;
  /** Normalizado (`normalizePhone`): dígitos con el 51. */
  phone: string;
  customerName: string;
  address1: string;
  reference: string | null;
  district: string;
  /** Como lo mandó el bot («Lima», «Arequipa»…). */
  department: string;
  /** El código de WooCommerce (`toWooPeruState`: «Lima» → LMA). */
  state: string;
  items: { sku: string; name: string | null; quantity: number; unitPrice: number }[];
  discount: OrderDiscountInput | null;
  /** Contraentrega (`cod`, sin decir) o agencia (`agency`). */
  shippingMode: "cod" | "agency";
  /** De `BOT_ORDER_TAGS`, sin repetir y en ese orden. */
  tags: string[];
  note: string | null;
  cartDraftGid: string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(obj).filter((k) => !allowed.includes(k));
}

/** Un texto: null si falta o va vacío; `false` si no es texto o pasa del largo. */
function textField(v: unknown, max: number): string | null | false {
  if (v == null) return null;
  if (typeof v !== "string") return false;
  const t = v.trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.length > max ? false : t;
}

/** ¿Un número con a lo más dos decimales? */
function hasCents(n: number): boolean {
  return Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
}

/**
 * Valida el cuerpo, estricto: los nombres en inglés (`BOT_ORDER_FIELDS`), los
 * tipos exactos (un número no se acepta como texto ni al revés) y ningún campo
 * desconocido. Cada problema con su mensaje en castellano. PURA.
 */
export function parseBotOrderBody(raw: unknown): { ok: true; input: BotOrderInput } | { ok: false; errors: string[] } {
  if (!isPlainObject(raw)) return { ok: false, errors: ["El cuerpo tiene que ser un objeto JSON."] };
  const errors: string[] = [];
  for (const k of unknownKeys(raw, BOT_ORDER_FIELDS)) errors.push(`${k}: campo desconocido.`);

  const requestId = typeof raw.request_id === "string" ? raw.request_id.trim() : "";
  if (!REQUEST_ID_RE.test(requestId)) {
    errors.push("request_id: obligatorio; un uuid, o de 8 a 64 letras, dígitos, «-» o «_». El mismo en cada reintento del mismo pedido.");
  }
  const conversationId = typeof raw.conversation_id === "string" ? raw.conversation_id.trim() : "";
  if (!SAFE_ID_RE.test(conversationId)) {
    errors.push("conversation_id: obligatorio; el id de la conversación de Kapso (hasta 128 caracteres, sin espacios).");
  }

  let phone = "";
  if (typeof raw.phone !== "string" || !raw.phone.trim()) {
    errors.push("phone: obligatorio; el celular peruano de la clienta (9 dígitos, empieza por 9; con o sin 51).");
  } else {
    const problem = peruMobileProblem(raw.phone);
    if (problem) errors.push(`phone: ${problem}`);
    else phone = normalizePhone(raw.phone) ?? "";
  }

  const customerName = textField(raw.customer_name, 120);
  if (!customerName) errors.push("customer_name: obligatorio; el nombre de la clienta, hasta 120 caracteres.");
  const address1 = textField(raw.address1, 200);
  if (!address1) errors.push("address1: obligatorio; la dirección (calle y número), hasta 200 caracteres.");
  const reference = textField(raw.reference, 200);
  if (reference === false) errors.push("reference: texto de hasta 200 caracteres.");
  const district = textField(raw.district, 100);
  if (!district) errors.push("district: obligatorio; el distrito, hasta 100 caracteres.");
  const department = textField(raw.department, 60);
  const state = department ? toWooPeruState(department) : null;
  if (!department || !state) {
    errors.push("department: obligatorio; un departamento del Perú como lo dice el bot («Lima», «Callao», «Arequipa»…).");
  }
  const note = textField(raw.note, 500);
  if (note === false) errors.push("note: texto de hasta 500 caracteres.");
  const cartDraftGid = textField(raw.cart_draft_gid, 128);
  if (cartDraftGid === false || (cartDraftGid && !SAFE_ID_RE.test(cartDraftGid))) {
    errors.push("cart_draft_gid: el id del carrito que cierra el bot (hasta 128 caracteres, sin espacios), o nada.");
  }

  let shippingMode: "cod" | "agency" = "cod";
  if (raw.shipping_mode != null) {
    const mode = typeof raw.shipping_mode === "string" ? BOT_ORDER_SHIPPING_MODES[raw.shipping_mode.trim().toLowerCase()] : undefined;
    if (!mode) errors.push("shipping_mode: «contraentrega» (o «cod») o «agencia» (o «agency»), o nada (contraentrega).");
    else shippingMode = mode;
  }

  const tags: string[] = [];
  if (raw.tags != null) {
    if (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== "string" || !BOT_ORDER_TAGS.includes(t.trim().toLowerCase()))) {
      errors.push(`tags: una lista con ${BOT_ORDER_TAGS.map((t) => `«${t}»`).join(" y/o ")}, o nada.`);
    } else {
      for (const t of BOT_ORDER_TAGS) if (raw.tags.some((x) => String(x).trim().toLowerCase() === t)) tags.push(t);
    }
  }

  const items: BotOrderInput["items"] = [];
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > BOT_ORDER_MAX_ITEMS) {
    errors.push(`items: obligatorio; de 1 a ${BOT_ORDER_MAX_ITEMS} productos.`);
  } else {
    raw.items.forEach((it, i) => {
      const at = `items[${i}]`;
      if (!isPlainObject(it)) {
        errors.push(`${at}: tiene que ser un objeto {sku, quantity, unit_price}.`);
        return;
      }
      for (const k of unknownKeys(it, ITEM_FIELDS)) errors.push(`${at}.${k}: campo desconocido.`);
      const sku = textField(it.sku, 64);
      if (!sku) errors.push(`${at}.sku: obligatorio; el SKU del producto o de la variación, hasta 64 caracteres.`);
      const name = textField(it.name, 200);
      if (name === false) errors.push(`${at}.name: texto de hasta 200 caracteres.`);
      const q = it.quantity;
      if (typeof q !== "number" || !Number.isInteger(q) || q < 1 || q > BOT_ORDER_MAX_QUANTITY) {
        errors.push(`${at}.quantity: un entero de 1 a ${BOT_ORDER_MAX_QUANTITY}.`);
      }
      const p = it.unit_price;
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 100_000 || !hasCents(p)) {
        errors.push(`${at}.unit_price: obligatorio; el precio unitario pactado, un número de 0 o más con hasta 2 decimales (0 es un regalo).`);
      }
      if (sku && name !== false && typeof q === "number" && typeof p === "number") {
        items.push({ sku, name: name || null, quantity: q, unitPrice: Math.round(p * 100) / 100 });
      }
    });
  }

  let discount: OrderDiscountInput | null = null;
  if (raw.discount != null) {
    const d = raw.discount;
    if (
      !isPlainObject(d) ||
      unknownKeys(d, DISCOUNT_FIELDS).length > 0 ||
      (d.kind !== "fixed" && d.kind !== "percent") ||
      typeof d.value !== "number" ||
      !Number.isFinite(d.value) ||
      d.value <= 0 ||
      !hasCents(d.value) ||
      (d.kind === "percent" && d.value > 100)
    ) {
      errors.push("discount: {kind: «fixed» (soles) o «percent», value: un número mayor que 0 (un porcentaje, hasta 100)}, o nada.");
    } else {
      discount = { kind: d.kind, value: d.value };
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      requestId,
      conversationId,
      phone,
      customerName: customerName as string,
      address1: address1 as string,
      reference: reference || null,
      district: district as string,
      department: department as string,
      state: state as string,
      items,
      discount,
      shippingMode,
      tags,
      note: note || null,
      cartDraftGid: cartDraftGid || null,
    },
  };
}

/**
 * La huella de lo pedido (`bot_order_requests.body_hash`): el sha256 de lo
 * validado y normalizado, sin el request_id (que es la llave) ni los nombres
 * de los productos (no viajan a WooCommerce: el producto es el SKU). El mismo
 * pedido escrito con otros espacios u otro orden de campos da la misma huella;
 * otra cantidad, otro precio, otra dirección, otra nota, otro modo de entrega
 * u otras etiquetas, otra. PURA.
 */
export function botOrderBodyHash(input: BotOrderInput): string {
  const canonical = {
    conversation_id: input.conversationId,
    phone: input.phone,
    customer_name: input.customerName,
    address1: input.address1,
    reference: input.reference,
    district: input.district,
    state: input.state,
    items: input.items.map((it) => [it.sku, it.quantity, Math.round(it.unitPrice * 100)]),
    discount: input.discount ? [input.discount.kind, Math.round(input.discount.value * 100)] : null,
    shipping_mode: input.shippingMode,
    tags: input.tags,
    note: input.note,
    cart_draft_gid: input.cartDraftGid,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** El comienzo del sha256 del request_id: lo que va al registro (nunca el id entero). */
export function requestIdLogKey(requestId: string | null): string | null {
  return requestId ? createHash("sha256").update(requestId).digest("hex").slice(0, 12) : null;
}

/**
 * Cuánto esperar ante `duplicate_in_progress`: lo que le falta al candado,
 * entre `BOT_ORDER_RETRY_AFTER_MIN_S` y `BOT_ORDER_RETRY_AFTER_MAX_S`. PURA.
 */
export function botOrderRetryAfter(claimedAtMs: number, nowMs: number): number {
  const left = Number.isFinite(claimedAtMs) ? Math.ceil((claimedAtMs + BOT_ORDER_CLAIM_TTL_MS - nowMs) / 1000) : BOT_ORDER_RETRY_AFTER_MAX_S;
  return Math.min(BOT_ORDER_RETRY_AFTER_MAX_S, Math.max(BOT_ORDER_RETRY_AFTER_MIN_S, left));
}

// ---------------------------------------------------------------------------
// La llamada
// ---------------------------------------------------------------------------

export interface BotOrderSuccessBody {
  ok: true;
  order: { name: string; id: string; total: number | null; currency: string | null };
  /** Ese pedido ya estaba creado (el mismo request_id, o el mismo pedido pedido dos veces): no se creó otro. */
  replay?: true;
}
export interface BotOrderFailureBody {
  ok: false;
  code: BotOrderCode;
  message: string;
  /** Reintentar con el MISMO request_id puede salir bien (nunca crea un segundo pedido). */
  retryable: boolean;
  retry_after_seconds?: number;
  /** Solo `invalid_body`: cada problema. */
  errors?: string[];
  /** Solo `conflict`: el pedido que ya creó ese request_id, si lo hay. */
  order?: { name: string; id: string | null };
  /**
   * Un pedido de este intento quedó en WooCommerce sin confirmar (no se pudo
   * borrar o anular, o quedó a medias): su número. Va en el motivo del
   * handoff, para que la asesora lo revise antes de generar otro.
   */
  order_left_open?: string;
}
export type BotOrderBody = BotOrderSuccessBody | BotOrderFailureBody;
export interface BotOrderResult {
  status: number;
  body: BotOrderBody;
}

export interface BotOrderDeps {
  admin: SupabaseClient;
  /** Lo que corre después de responder (`after` de Next). Sin él, se espera aquí. */
  defer?: (work: () => Promise<void>) => void;
  /** El registro de UNA línea por llamada. */
  log?: (line: string, level: "info" | "warn" | "error") => void;
  /** La hora (candados, tope por minuto, ventana del intento anterior). */
  now?: () => number;
  /** El reloj de la llamada y de la venta (`BOT_ORDER_SALE_DEADLINE_MS`, `WOO_SALE_BUDGET_MS`). */
  clock?: () => number;
  /** Tope de cada paso de la base (`BOT_ORDER_DB_TIMEOUT_MS`). */
  dbTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  wooTimeouts?: Partial<WooSaleTimeouts>;
}

export interface BotOrderRequest {
  storeId: string;
  authorization: string | null;
  /** El cuerpo ya leído (pruebas). Si no, `readBody`. */
  rawBody?: string;
  /** Lee el cuerpo con tope, DESPUÉS del secreto: null si pasa de `maxBytes`. */
  readBody?: (maxBytes: number) => Promise<string | null>;
  /** `Content-Length`, si vino: de más, 413 antes de leer nada. */
  contentLength?: string | null;
}

interface GuardRow {
  id: string;
  status: "processing" | "done" | "failed";
  body_hash: string;
  claim_token: string;
  claimed_at: string;
  created_at: string | null;
  attempts: number;
  woo_order_id: number | string | null;
  order_id: string | null;
  order_name: string | null;
  order_total: number | string | null;
  currency: string | null;
}

const GUARD_COLUMNS =
  "id,status,body_hash,claim_token,claimed_at,created_at,attempts,woo_order_id,order_id,order_name,order_total,currency";

interface Claim {
  id: string;
  token: string;
  attempts: number;
  /** El pedido de WooCommerce que ya creó un intento anterior de este id. */
  wooOrderId: number | null;
}

class MigrationMissing extends Error {}
/**
 * Un paso de la base que no contestó a tiempo (`BOT_ORDER_DB_TIMEOUT_MS`).
 * Exportado para la consulta del bot (lib/bot-order-lookup.ts), que usa el
 * mismo tope.
 */
export class StepTimeout extends Error {}

/** Espera `work` como mucho `ms`; si no, lanza `StepTimeout`. Lo que siga corriendo se deja (lecturas, o escrituras idempotentes). */
export function withTimeout<T>(work: PromiseLike<T>, ms: number, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(work),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StepTimeout(`${step}: sin respuesta en ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Lo que dice el secreto de una llamada del bot (`authenticateBotCall`). */
export type BotAuthOutcome =
  | { ok: true }
  | { ok: false; code: "unauthorized" | "migration_missing" | "store_unavailable"; message: string };

/**
 * El secreto de una llamada del bot, el MISMO para sus dos endpoints: crear
 * (`handleBotOrder`) y consultar un pedido que ya existe
 * (`handleBotOrderLookup`, lib/bot-order-lookup.ts, 25-10-2026). Una sola
 * puerta: lo que se arregle aquí vale para los dos.
 *   · la tienda tiene que ser un uuid y venir `Authorization: Bearer <token>`;
 *   · el sha256 de lo que llegó se compara en tiempo constante con el guardado
 *     (`botSecretMatches`). Sin secreto, con otro o con una tienda que no
 *     existe: `unauthorized`, «No autorizado.», sin decir cuál;
 *   · sin la 0277, `migration_missing`; otra falla de lectura,
 *     `store_unavailable`.
 * Un paso que no contesta a tiempo lanza `StepTimeout` (lo decide quien llama).
 */
export async function authenticateBotCall(args: {
  admin: SupabaseClient;
  storeId: string;
  authorization: string | null | undefined;
  step: <T>(label: string, work: PromiseLike<T>) => Promise<T>;
}): Promise<BotAuthOutcome> {
  const { admin, storeId, step } = args;
  const denied: BotAuthOutcome = { ok: false, code: "unauthorized", message: "No autorizado." };
  if (!UUID_RE.test(storeId)) return denied;
  const token = bearerToken(args.authorization);
  if (!token) return denied;
  const secret = await step(
    "secret",
    admin.from("bot_order_secrets").select("secret_hash").eq("store_id", storeId).maybeSingle(),
  );
  if (secret.error) {
    if (isBotOrdersMigrationMissing(secret.error)) return { ok: false, code: "migration_missing", message: BOT_ORDERS_MIGRATION_MISSING };
    return { ok: false, code: "store_unavailable", message: "No se pudo leer la tienda. Reintenta en unos segundos." };
  }
  const storedHash = (secret.data as { secret_hash?: string } | null)?.secret_hash ?? null;
  return botSecretMatches(token, storedHash) ? { ok: true } : denied;
}

/**
 * Las cabeceras de una respuesta del bot, para las dos rutas: sin caché,
 * `WWW-Authenticate` en un 401 y `Retry-After` cuando el cuerpo dice cuánto
 * esperar.
 */
export function botResponseHeaders(status: number, body: { ok: boolean; retry_after_seconds?: number }): Record<string, string> {
  return {
    "cache-control": "no-store",
    ...(status === 401 ? { "www-authenticate": 'Bearer realm="kapta"' } : {}),
    ...(!body.ok && body.retry_after_seconds ? { "retry-after": String(body.retry_after_seconds) } : {}),
  };
}

function fail(code: BotOrderCode, message: string, extra: Partial<BotOrderFailureBody> = {}): BotOrderResult {
  const retryable = BOT_ORDER_RETRYABLE.has(code);
  return {
    status: BOT_ORDER_HTTP[code],
    body: {
      ok: false,
      code,
      message,
      retryable,
      ...(retryable ? { retry_after_seconds: BOT_ORDER_RETRY_AFTER_S } : {}),
      ...extra,
    },
  };
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function wooIdOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  return n != null && Number.isInteger(n) && n > 0 ? n : null;
}

/** Un celular peruano suelto en un texto (con o sin 51), para taparlo. */
const PE_MOBILE_IN_TEXT = /(?<!\d)(?:\+?51)?9\d{8}(?!\d)/g;

/**
 * Un texto para el registro o para Ajustes: sin un celular que una base o una
 * API haya metido en su mensaje. Los SKU (hasta un EAN de 13 dígitos) quedan.
 */
export function scrubForLog(text: string, max: number): string {
  return text.replace(PE_MOBILE_IN_TEXT, "…").slice(0, max);
}

function logError(e: unknown): string {
  return scrubForLog(e instanceof Error ? e.message : "error", 200);
}

const defaultLog = (line: string, level: "info" | "warn" | "error") => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
};

/**
 * Qué quedó en WooCommerce sin confirmar después de una venta que no salió:
 * el número del pedido y qué le pasó, o null si no quedó nada (se borró, se
 * anuló, o nunca se creó). PURA.
 */
export function botOrderLeftOpen(
  outcome: WooSaleOutcome,
): { label: string; state: "cancel_failed" | "delete_failed" | "kept_pending" | "unknown" | "conflict" } | null {
  if (outcome.kind === "created" || outcome.kind === "adopted") return null;
  if (outcome.kind === "conflict") return { label: outcome.orderLabel ?? `#${outcome.order.id}`, state: "conflict" };
  const cleanup: WooSaleErrorCleanup | null = outcome.cleanup;
  if (cleanup === "cancel_failed" || cleanup === "delete_failed" || cleanup === "kept_pending" || cleanup === "unknown") {
    return { label: outcome.orderLabel ?? "un pedido", state: cleanup };
  }
  return null;
}

/** La constancia en el lead de un pedido que quedó a medias: qué revisar antes de generar otro. PURA. */
export function botOrderLeftOpenNote(left: NonNullable<ReturnType<typeof botOrderLeftOpen>>, code: string): string {
  const p = `el pedido ${left.label}`;
  const head = "⚠️ Pedido del bot de Kapso NO confirmado";
  switch (left.state) {
    case "cancel_failed":
      return `${head} (${code}): ${p} quedó VIVO en WooCommerce con otros datos que los pactados y no se pudo anular. Anúlalo en WooCommerce antes de generar otro pedido.`;
    case "delete_failed":
      return `${head} (${code}): ${p} quedó «Pendiente de pago» en WooCommerce y no se pudo borrar. Bórralo en WooCommerce (Kapta no lo toma mientras siga pendiente).`;
    case "conflict":
      return `${head} (${code}): ese pedido ya existía VIVO en WooCommerce (${left.label}) con otros datos. Revísalo en WooCommerce antes de generar otro pedido.`;
    default:
      return `${head} (${code}): ${p} quedó a medias en WooCommerce. Si el bot no le confirmó el pedido a la clienta, revísalo en WooCommerce antes de generar otro: si está «Procesando», ya es su pedido.`;
  }
}

/**
 * Una llamada del bot, de punta a punta (ver la cabecera). Nunca lanza:
 * devuelve el código HTTP y el cuerpo. Lo que sigue a la respuesta (los pasos
 * de la entrada, el carrito, el aviso de un pedido a medias, el último uso) va
 * por `deps.defer`.
 */
export async function handleBotOrder(req: BotOrderRequest, deps: BotOrderDeps): Promise<BotOrderResult> {
  const { admin } = deps;
  const now = deps.now ?? Date.now;
  const clock = deps.clock ?? Date.now;
  const started = now();
  const startedClock = clock();
  const dbMs = deps.dbTimeoutMs ?? BOT_ORDER_DB_TIMEOUT_MS;
  const step = <T,>(label: string, work: PromiseLike<T>) => withTimeout(work, dbMs, label);
  const log = deps.log ?? defaultLog;
  const defer = deps.defer ?? ((work) => void work());
  const storeId = String(req.storeId ?? "");
  const line: Record<string, unknown> = { store: storeId, req: null as string | null };
  const events: string[] = [];
  let authenticated = false;
  /** El candado que tiene esta llamada. */
  let claim: Claim | null = null;

  const deferSafe = (label: string, work: () => Promise<void>) =>
    defer(async () => {
      try {
        await work();
      } catch (e) {
        log(`[bot-orders] ${JSON.stringify({ store: storeId, req: line.req, step: label, error: logError(e) })}`, "error");
      }
    });

  const finish = (result: BotOrderResult, extra: Record<string, unknown> = {}): BotOrderResult => {
    const outcome = result.body.ok ? "ok" : result.body.code;
    const entry = {
      ...line,
      outcome,
      status: result.status,
      ms: Math.max(0, now() - started),
      ...(result.body.ok && result.body.replay ? { replay: true } : {}),
      ...(!result.body.ok && result.body.order_left_open ? { left_open: true } : {}),
      ...(claim ? { attempt: claim.attempts } : {}),
      ...(events.length ? { events } : {}),
      ...extra,
    };
    log(`[bot-orders] ${JSON.stringify(entry)}`, result.status >= 500 ? "error" : result.status >= 400 ? "warn" : "info");
    if (authenticated) {
      // El último uso, para Ajustes. Sin datos de la clienta: el código y el
      // mensaje (productos, SKU, número de pedido), nunca teléfono ni dirección.
      const at = new Date(now()).toISOString();
      const patch: Record<string, unknown> = { last_used_at: at, last_outcome: outcome };
      if (!result.body.ok) {
        patch.last_error = scrubForLog(`${result.body.code}: ${result.body.message}`, 300);
        patch.last_error_at = at;
      }
      deferSafe("last_used", async () => {
        await admin.from("bot_order_secrets").update(patch).eq("store_id", storeId);
      });
    }
    return result;
  };

  try {
    // 0) El tamaño declarado: de más, sin leer nada (ni la base).
    const declared = req.contentLength == null || req.contentLength === "" ? NaN : Number(req.contentLength);
    if (Number.isFinite(declared) && declared > BOT_ORDER_MAX_BODY_BYTES) {
      return finish(fail("body_too_large", `El cuerpo pasa de ${BOT_ORDER_MAX_BODY_BYTES} bytes.`));
    }

    // 1) El secreto (`authenticateBotCall`: la misma puerta que la consulta).
    const auth = await authenticateBotCall({ admin, storeId, authorization: req.authorization, step });
    if (!auth.ok) return finish(fail(auth.code, auth.message));
    authenticated = true;

    // 2) El cuerpo: recién ahora se lee, con tope.
    const rawBody = req.rawBody ?? (req.readBody ? await req.readBody(BOT_ORDER_MAX_BODY_BYTES) : "");
    if (rawBody == null || Buffer.byteLength(rawBody, "utf8") > BOT_ORDER_MAX_BODY_BYTES) {
      return finish(fail("body_too_large", `El cuerpo pasa de ${BOT_ORDER_MAX_BODY_BYTES} bytes.`));
    }
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return finish(fail("invalid_body", "El cuerpo no es JSON."));
    }
    const parsed = parseBotOrderBody(raw);
    if (!parsed.ok) {
      return finish(fail("invalid_body", "El pedido tiene datos que faltan o no sirven.", { errors: parsed.errors }));
    }
    const input = parsed.input;
    line.req = requestIdLogKey(input.requestId);
    // Agencia: el bot no la crea (owner, 23-10-2026). El adelanto no se
    // registra desde el bot; la asesora genera el pedido con el adelanto.
    // Antes de la tienda y del candado: no se toca nada.
    if (input.shippingMode === "agency") {
      return finish(
        fail(
          "agency_needs_advisor",
          "El bot no crea pedidos para recoger en agencia: deriva la conversación a una asesora, que lo genera con el adelanto.",
        ),
      );
    }

    // 3) La tienda: activa y en WooCommerce. Nunca Shopify desde aquí.
    const plataforma = await step("store", loadStoreOrderPlatform(admin, storeId));
    if (!plataforma.ok) return finish(fail("store_unavailable", plataforma.error));
    if (plataforma.platform !== "woocommerce") {
      return finish(
        fail(
          "wrong_platform",
          "Esta tienda todavía crea sus pedidos en Shopify: Kapta no crea pedidos del bot aquí. Deriva la conversación a una asesora (o usa la acción de Shopify del bot mientras Shopify siga abierto).",
        ),
      );
    }
    const woo = plataforma.creds;
    if (woo.status !== "active") {
      return finish(fail("store_inactive", "La tienda no está activa en Kapta: no se crean pedidos. Deriva la conversación a una asesora."));
    }

    // Los montos, con las reglas de «Generar pedido»: contraentrega, el total
    // tiene que ser mayor que 0 (un pedido solo de regalos no se cobra).
    const lines = input.items.map((it) => ({
      title: it.name ?? it.sku,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      sku: it.sku,
      variantId: null,
    }));
    const lineProblem = wooSaleLinesProblem(lines);
    if (lineProblem) return finish(fail("invalid_body", lineProblem));
    const subtotal = Math.round(lines.reduce((s, li) => s + li.unitPrice * li.quantity, 0) * 100) / 100;
    if (subtotal <= 0) return finish(fail("invalid_body", "El monto del pedido tiene que ser mayor que 0: un pedido solo de regalos no se crea."));
    const { total: amount, discountAmount } = resolveOrderDiscount(subtotal, input.discount);
    if (amount <= 0) return finish(fail("invalid_body", "El total del pedido no puede ser 0: revisa el descuento."));

    // 4) El candado.
    const bodyHash = botOrderBodyHash(input);
    const claimed = await claimBotOrder({ admin, storeId, requestId: input.requestId, bodyHash, now, step, line });
    if (claimed.kind === "result") return finish(claimed.result);
    const myClaim = claimed.claim;
    claim = myClaim;

    // 5) El pedido, con lo que le queda al reloj de la llamada.
    const requestIdWoo = `${BOT_ORDER_REQUEST_PREFIX}${input.requestId}`;
    const { body, expected } = buildWooSaleOrder({
      leadId: null,
      conversationId: input.conversationId,
      requestId: requestIdWoo,
      channel: BOT_ORDER_CHANNEL,
      shippingMode: input.shippingMode,
      tags: input.tags,
      lines,
      discountAmount,
      address: {
        name: input.customerName,
        phone: input.phone,
        address1: input.address1,
        address2: input.reference,
        city: input.district,
        province: input.department,
      },
      note: input.note,
    });
    const client: WooClientOpts = wooSaleClient(woo, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
    const budgetMs = Math.max(0, Math.min(WOO_SALE_BUDGET_MS, startedClock + BOT_ORDER_SALE_DEADLINE_MS - clock()));
    const outcome = await createWooSaleOrder({
      client,
      body,
      expected,
      requestId: requestIdWoo,
      knownOrderId: myClaim.wooOrderId,
      now,
      clock,
      budgetMs,
      timeouts: deps.wooTimeouts,
      log: (event, data) => {
        events.push(event);
        if (data.wooId != null && line.woo == null) line.woo = data.wooId;
      },
      // Apenas existe, el pedido queda anotado en el candado: un reintento lo
      // lee por su id a cualquier edad, sin depender de la búsqueda de 2 horas.
      onCreated: async (wooId) => {
        if (line.woo == null) line.woo = wooId;
        const { error } = await step(
          "woo_id",
          admin.from("bot_order_requests").update({ woo_order_id: wooId }).eq("id", myClaim.id).eq("claim_token", myClaim.token),
        );
        if (error) events.push("guard.woo_id_failed");
      },
    });

    if (outcome.kind === "created" || outcome.kind === "adopted") {
      // `adopted`: un intento anterior de este mismo request_id ya lo había
      // creado (la función se cortó antes de cerrar el candado). El registro lo
      // dice (`woo.sale.adopted`); para el bot es su pedido.
      return finish(await registerBotOrder({ admin, storeId, woo, input, order: outcome.order, claim: myClaim, now, step, deferSafe, line }));
    }

    if (outcome.kind === "error" && outcome.postUnanswered) {
      // El POST salió y no se sabe si WordPress lo está guardando todavía: el
      // candado NO se suelta; se vuelve a armar desde ahora, así nadie lo retoma
      // antes de `BOT_ORDER_CLAIM_TTL_MS`, y para entonces el pedido, si se
      // creó, aparece en la búsqueda y se retoma en vez de crear otro.
      await step(
        "rearm",
        admin
          .from("bot_order_requests")
          .update({ claimed_at: new Date(now()).toISOString(), error_code: "woocommerce_unavailable" })
          .eq("id", myClaim.id)
          .eq("claim_token", myClaim.token),
      ).catch(() => {
        line.guard = "rearm_failed";
      });
      return finish(
        fail(
          "woocommerce_unavailable",
          `${outcome.message} WooCommerce pudo haberlo creado igual: reintenta con el MISMO request_id (nunca uno nuevo). Mientras Kapta espera a que WooCommerce termine contesta duplicate_in_progress; después lo busca y no crea otro.`,
          { retry_after_seconds: BOT_ORDER_RETRY_AFTER_MAX_S },
        ),
      );
    }

    const currency = "PEN";
    let result: BotOrderResult;
    if (outcome.kind === "price") {
      const rechazo = priceMismatchRejection({
        desajustes: outcome.desajustes,
        currency,
        draftName: outcome.orderLabel,
        tienda: "WooCommerce",
        limpieza: wooCleanupText(outcome.cleanup, outcome.orderLabel),
      });
      result = fail("price_mismatch", rechazo.error);
    } else if (outcome.kind === "lines") {
      const rechazo = wooLineRejection({ problemas: outcome.problemas, orderLabel: outcome.orderLabel, cleanup: outcome.cleanup });
      const sku = outcome.problemas.some((p) => p.motivo === "no_existe" || p.motivo === "otro_producto" || p.motivo === "variable");
      result = fail(sku ? "sku_not_found" : "order_mismatch", rechazo.error);
    } else if (outcome.kind === "conflict") {
      line.woo = outcome.order.id;
      result = fail(
        "conflict",
        `Este request_id ya creó ${outcome.orderLabel ? `el pedido ${outcome.orderLabel}` : "un pedido"} en WooCommerce, y está vivo, pero con otros datos que los de ahora. Kapta no lo registra como este pedido ni crea otro: revísalo con una asesora.`,
        outcome.orderLabel ? { order: { name: outcome.orderLabel, id: null } } : {},
      );
    } else {
      result = fail("woocommerce_unavailable", `${outcome.message}${botCleanupText(outcome.cleanup, outcome.orderLabel)}`);
    }

    // Un pedido que quedó en WooCommerce sin confirmar: su número va en la
    // respuesta (para el motivo del handoff) y una constancia en el lead, que
    // es donde la asesora generaría otro.
    const left = botOrderLeftOpen(outcome);
    if (left && !result.body.ok) {
      result.body.order_left_open = left.label;
      const code = result.body.code;
      deferSafe("left_open", () => noteLeftOpenOnLead(admin, storeId, input, botOrderLeftOpenNote(left, code)));
    }
    await releaseClaim(admin, myClaim, result, now, step).catch(() => {
      line.guard = "release_failed";
    });
    return finish(result);
  } catch (e) {
    if (e instanceof MigrationMissing) {
      if (claim) await releaseClaim(admin, claim, fail("migration_missing", BOT_ORDERS_MIGRATION_MISSING), now, step).catch(() => {});
      return finish(fail("migration_missing", BOT_ORDERS_MIGRATION_MISSING));
    }
    if (e instanceof StepTimeout && !claim) {
      return finish(
        fail("store_unavailable", "La base de Kapta no contestó a tiempo. Reintenta con el mismo request_id: no se crea un segundo pedido."),
        { error: logError(e) },
      );
    }
    const result = fail("internal_error", "Error interno de Kapta. Reintenta con el mismo request_id: no se crea un segundo pedido.");
    if (claim) await releaseClaim(admin, claim, result, now, step).catch(() => {});
    return finish(result, { error: logError(e) });
  }
}

/**
 * Lo que se dice de un pedido que quedó a medias, para el bot: «pendiente» o
 * «no se sabe» se resuelven reintentando con el mismo request_id (nunca crea
 * otro); lo demás, como en «Generar pedido».
 */
function botCleanupText(cleanup: WooSaleErrorCleanup | null, orderLabel: string | null): string {
  if (!cleanup) return " Reintenta con el mismo request_id: no se crea un segundo pedido.";
  if (cleanup === "kept_pending" || cleanup === "unknown") {
    return ` ${orderLabel ? `El pedido ${orderLabel}` : "El pedido"} quedó a medias: reintenta con el mismo request_id en unos segundos; Kapta lo retoma y no crea otro.`;
  }
  return ` ${wooCleanupText(cleanup, orderLabel)}`;
}

type Step = <T>(label: string, work: PromiseLike<T>) => Promise<T>;

/**
 * Toma el candado de (tienda, request_id), o dice por qué no:
 *   · hay fila con otra huella: `conflict`, sin llamar a WooCommerce;
 *   · `done`: el mismo pedido de vuelta (`replay`);
 *   · `processing` dentro de su plazo: `duplicate_in_progress`, con lo que le
 *     falta al candado (`botOrderRetryAfter`);
 *   · `failed`, o `processing` vencido: se retoma, solo si el token sigue siendo
 *     el que se leyó (de dos que lo intentan, uno gana); salvo si no sabe qué
 *     pedido creó y tiene más de `BOT_ORDER_RETAKE_MAX_AGE_MS`: `expired`;
 *   · no hay fila: otro request_id con la misma huella en los últimos
 *     `BOT_ORDER_SAME_BODY_WINDOW_MS` es el mismo pedido (su pedido, o
 *     `duplicate_in_progress`); si no, el tope por minuto y se inserta
 *     (`processing`, con un token nuevo). Si otra llamada la insertó en el
 *     mismo instante (23505), se lee la suya.
 * Cada paso de la base con su tope.
 */
async function claimBotOrder(args: {
  admin: SupabaseClient;
  storeId: string;
  requestId: string;
  bodyHash: string;
  now: () => number;
  step: Step;
  line: Record<string, unknown>;
}): Promise<{ kind: "claim"; claim: Claim } | { kind: "result"; result: BotOrderResult }> {
  const { admin, storeId, requestId, bodyHash, now, step, line } = args;
  const dbError = (error: { message?: string; code?: string }): never => {
    if (isBotOrdersMigrationMissing(error)) throw new MigrationMissing();
    throw new Error(`bot_order_requests: ${error.message ?? "error"}`);
  };

  const read = async (): Promise<GuardRow | null> => {
    const { data, error } = await step(
      "guard_read",
      admin.from("bot_order_requests").select(GUARD_COLUMNS).eq("store_id", storeId).eq("request_id", requestId).maybeSingle(),
    );
    if (error) dbError(error);
    return (data as GuardRow | null) ?? null;
  };

  const replayOf = (row: GuardRow): BotOrderResult => ({
    status: 200,
    body: {
      ok: true as const,
      order: { name: row.order_name!, id: row.order_id!, total: numOrNull(row.order_total), currency: row.currency },
      replay: true as const,
    },
  });

  const decide = async (row: GuardRow): Promise<{ kind: "claim"; claim: Claim } | { kind: "result"; result: BotOrderResult }> => {
    if (row.body_hash !== bodyHash) {
      return {
        kind: "result",
        result: fail(
          "conflict",
          `Este request_id ya se usó con otros datos${row.order_name ? ` y creó el pedido ${row.order_name}` : ""}. No se creó otro pedido: un pedido distinto lleva otro request_id.`,
          row.order_name ? { order: { name: row.order_name, id: row.order_id } } : {},
        ),
      };
    }
    if (row.status === "done" && row.order_id && row.order_name) return { kind: "result", result: replayOf(row) };
    const claimedAt = Date.parse(row.claimed_at);
    if (row.status === "processing" && Number.isFinite(claimedAt) && now() - claimedAt < BOT_ORDER_CLAIM_TTL_MS) {
      return {
        kind: "result",
        result: fail(
          "duplicate_in_progress",
          "Ya hay una llamada creando este pedido (mismo request_id). Espera y reintenta con el mismo request_id: no se crea otro.",
          { retry_after_seconds: botOrderRetryAfter(claimedAt, now()) },
        ),
      };
    }
    const wooOrderId = wooIdOrNull(row.woo_order_id);
    const createdAt = Date.parse(row.created_at ?? row.claimed_at);
    if (wooOrderId == null && Number.isFinite(createdAt) && now() - createdAt > BOT_ORDER_RETAKE_MAX_AGE_MS) {
      // Un intento viejo que no terminó y no sabe qué pedido creó: la búsqueda
      // de 2 horas ya no lo vería. No se arriesga un segundo pedido.
      return {
        kind: "result",
        result: fail(
          "expired",
          `Este request_id empezó hace más de ${Math.round(BOT_ORDER_RETAKE_MAX_AGE_MS / 60_000)} minutos y no terminó: Kapta ya no puede asegurar que no exista un pedido suyo en WooCommerce, así que no crea otro. Deriva a una asesora con el request_id para que revise WooCommerce antes de generar.`,
        ),
      };
    }
    // `failed`, o un `processing` vencido: se retoma con el token que se leyó.
    const token = randomUUID();
    const attempts = (row.attempts ?? 1) + 1;
    const { data, error } = await step(
      "guard_retake",
      admin
        .from("bot_order_requests")
        .update({
          status: "processing",
          claim_token: token,
          claimed_at: new Date(now()).toISOString(),
          attempts,
          error_code: null,
          finished_at: null,
        })
        .eq("id", row.id)
        .eq("claim_token", row.claim_token)
        .select("id"),
    );
    if (error) dbError(error);
    if (!Array.isArray(data) || data.length !== 1) {
      return {
        kind: "result",
        result: fail(
          "duplicate_in_progress",
          "Otra llamada retomó este pedido (mismo request_id). Espera y reintenta con el mismo request_id: no se crea otro.",
          { retry_after_seconds: BOT_ORDER_RETRY_AFTER_MAX_S },
        ),
      };
    }
    return { kind: "claim", claim: { id: row.id, token, attempts, wooOrderId } };
  };

  const existing = await read();
  if (existing) return decide(existing);

  // El mismo pedido pedido otra vez con otro request_id (la herramienta del
  // bot llamada dos veces): se devuelve el primero.
  const since = (ms: number) => new Date(now() - ms).toISOString();
  const twin = await step(
    "guard_twin",
    admin
      .from("bot_order_requests")
      .select(GUARD_COLUMNS)
      .eq("store_id", storeId)
      .eq("body_hash", bodyHash)
      .in("status", ["processing", "done"])
      .gte("created_at", since(BOT_ORDER_SAME_BODY_WINDOW_MS))
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
  if (twin.error) dbError(twin.error);
  const t = (twin.data as GuardRow | null) ?? null;
  if (t) {
    line.twin = true;
    if (t.status === "done" && t.order_id && t.order_name) return { kind: "result", result: replayOf(t) };
    const claimedAt = Date.parse(t.claimed_at);
    if (Number.isFinite(claimedAt) && now() - claimedAt < BOT_ORDER_CLAIM_TTL_MS) {
      return {
        kind: "result",
        result: fail(
          "duplicate_in_progress",
          "Otra llamada con exactamente el mismo pedido (otro request_id) lo está creando. Espera y reintenta con este mismo request_id: recibirás ese pedido.",
          { retry_after_seconds: botOrderRetryAfter(claimedAt, now()) },
        ),
      };
    }
    return {
      kind: "result",
      result: fail(
        "conflict",
        "Otra llamada con exactamente el mismo pedido (otro request_id) quedó a medias hace unos minutos: puede existir ya ese pedido. No se crea otro: deriva a una asesora.",
      ),
    };
  }

  // El tope por minuto: solo antes de una fila NUEVA (un reintento no cuenta),
  // y solo las del bot (las de «Generar pedido» van con `form-`).
  const recent = await step(
    "guard_rate",
    admin
      .from("bot_order_requests")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .not("request_id", "like", `${WOO_FORM_GUARD_PREFIX}%`)
      .gte("created_at", since(60_000)),
  );
  if (recent.error && isBotOrdersMigrationMissing(recent.error)) throw new MigrationMissing();
  if (!recent.error && (recent.count ?? 0) >= BOT_ORDER_RATE_PER_MINUTE) {
    return {
      kind: "result",
      result: fail(
        "rate_limited",
        `Más de ${BOT_ORDER_RATE_PER_MINUTE} pedidos nuevos del bot en un minuto en esta tienda: se frenó. Reintenta con el mismo request_id en unos segundos.`,
      ),
    };
  }

  const id = randomUUID();
  const token = randomUUID();
  const at = new Date(now()).toISOString();
  const ins = await step(
    "guard_insert",
    admin.from("bot_order_requests").insert({
      id,
      store_id: storeId,
      request_id: requestId,
      body_hash: bodyHash,
      status: "processing",
      claim_token: token,
      claimed_at: at,
      attempts: 1,
      created_at: at,
    }),
  );
  if (ins.error) {
    if (isBotOrdersMigrationMissing(ins.error)) throw new MigrationMissing();
    if ((ins.error as { code?: string }).code === "23505") {
      // Otra llamada con el mismo id llegó primero: su fila manda.
      const theirs = await read();
      if (theirs) return decide(theirs);
    }
    dbError(ins.error);
  }
  return { kind: "claim", claim: { id, token, attempts: 1, wooOrderId: null } };
}

/** Cierra el candado de un pedido que no se creó: `failed`, con su código. Solo quien lo tiene. */
async function releaseClaim(
  admin: SupabaseClient,
  claim: { id: string; token: string },
  result: BotOrderResult,
  now: () => number,
  step: Step,
): Promise<void> {
  const code = result.body.ok ? null : result.body.code;
  await step(
    "guard_release",
    admin
      .from("bot_order_requests")
      .update({ status: "failed", error_code: code, finished_at: new Date(now()).toISOString() })
      .eq("id", claim.id)
      .eq("claim_token", claim.token),
  );
}

/**
 * El pedido ya está vivo en WooCommerce. PRIMERO el candado cerrado con el
 * pedido (`done`: un reintento recibe este mismo pedido, aunque lo que sigue
 * se corte); después la fila local que escribiría la entrada (`mapWooOrder` +
 * `insertOrderIfAbsent`, sin pisar la del webhook si llegó antes) y, después
 * de responder, los pasos de la entrada para un pedido del bot. Sin
 * `order_sales`: no hay asesora que lo haya vendido.
 */
async function registerBotOrder(args: {
  admin: SupabaseClient;
  storeId: string;
  woo: WooApiCreds;
  input: BotOrderInput;
  order: WooOrder;
  claim: Claim;
  now: () => number;
  step: Step;
  deferSafe: (label: string, work: () => Promise<void>) => void;
  line: Record<string, unknown>;
}): Promise<BotOrderResult> {
  const { admin, storeId, woo, input, order, claim, now, step, deferSafe, line } = args;
  line.woo = order.id;
  let row: OrderRow | null = null;
  try {
    row = mapWooOrder(order, { id: storeId, woo_site_key: woo.siteKey });
  } catch {
    row = null;
  }
  const number = String(order.number ?? "").trim().replace(/^#/, "") || String(order.id);
  const name = row?.name ?? `#${number}`;
  const id = row?.shopify_order_id ?? `wc-${woo.siteKey}-${order.id}`;
  const total = row?.total_amount ?? numOrNull(order.total);
  const currency = row?.currency ?? (typeof order.currency === "string" ? order.currency : null);

  // 1) El candado, con el pedido. Si no se pudo cerrar, un reintento lo retoma
  // pasado su plazo y `createWooSaleOrder` lee este mismo pedido por su id
  // (`woo_order_id`) y lo adopta.
  try {
    const { error } = await step(
      "guard_done",
      admin
        .from("bot_order_requests")
        .update({
          status: "done",
          woo_order_id: wooIdOrNull(order.id),
          order_id: id,
          order_name: name,
          order_total: total,
          currency,
          error_code: null,
          finished_at: new Date(now()).toISOString(),
        })
        .eq("id", claim.id)
        .eq("claim_token", claim.token),
    );
    if (error) line.guard = "finalize_failed";
  } catch {
    line.guard = "finalize_timeout";
  }

  // 2) La fila local. Si falla o no contesta, el pedido existe igual en
  // WooCommerce (el webhook y la pasada lo traen): la clienta tiene su pedido y
  // el bot lo confirma.
  let localOk = false;
  if (row) {
    try {
      const { id: internalId, error } = await step("local_insert", insertOrderIfAbsent(admin, { ...row }));
      localOk = Boolean(internalId) && !error;
      if (!localOk) line.local = "insert_failed";
    } catch {
      line.local = "insert_timeout";
    }
  }

  if (row && localOk) {
    const orderRow = row;
    deferSafe("post_steps", async () => {
      // El lead de la conversación sin celular (escribe con nombre de usuario de
      // WhatsApp): se le rellena el del pedido, con la regla de «Generar
      // pedido» (solo el hueco, nunca pisar). Así el lead ganado es ese y no
      // uno nuevo con el mismo teléfono.
      await fillConversationLeadPhone(admin, storeId, input.conversationId, orderRow.customer_phone ?? null);
      // Los pasos de la entrada para un pedido del bot: rollups del día, lead
      // ganado por teléfono y fila del Master.
      await applyWooOrderEffects(admin, storeId, woo.timezone, orderRow);
    });
  }
  // El bot cerró un carrito: el lead deja de verse «Carrito abandonado» y la
  // secuencia no le escribe más, como en «Generar pedido». Solo el lead de esta
  // clienta (su celular o su conversación): un gid equivocado no cierra el
  // carrito de otra. La copia del borrador no se toca: refleja lo que dice Shopify.
  if (input.cartDraftGid) {
    const gid = input.cartDraftGid;
    deferSafe("cart", async () => {
      const closed = await closeCartOfCustomer(admin, storeId, gid, input);
      if (!closed) {
        throw new Error("cart_draft_gid sin un lead de esta clienta: no se cerró ningún carrito");
      }
    });
  }

  return { status: 200, body: { ok: true, order: { name, id, total, currency } } };
}

/** Cierra el carrito `gid` solo en los leads de esta clienta (su celular o su conversación). Cuántos cerró. */
async function closeCartOfCustomer(admin: SupabaseClient, storeId: string, gid: string, input: BotOrderInput): Promise<number> {
  const { data } = await admin
    .from("leads")
    .select("id, phone, kapso_conversation_id")
    .eq("store_id", storeId)
    .eq("draft_order_gid", gid)
    .limit(20);
  const leads = (data as { id: string; phone: string | null; kapso_conversation_id: string | null }[] | null) ?? [];
  const mine = leads
    .filter((l) => (l.phone != null && normalizePhone(l.phone) === input.phone) || l.kapso_conversation_id === input.conversationId)
    .map((l) => l.id);
  if (!mine.length) return 0;
  await admin.from("leads").update({ draft_order_status: "completed" }).in("id", mine);
  return mine.length;
}

/**
 * La constancia de un pedido que quedó a medias, en el lead de esta clienta
 * (su conversación; si no, su celular) y el lead a «Atender ahora» sin tocar su
 * estado. Es donde la asesora generaría otro pedido. Sin un único lead, no se
 * adivina: queda el registro y `last_error` en Ajustes.
 */
async function noteLeftOpenOnLead(admin: SupabaseClient, storeId: string, input: BotOrderInput, note: string): Promise<void> {
  let leadId: string | null = null;
  for (const [col, val] of [
    ["kapso_conversation_id", input.conversationId],
    ["phone", input.phone],
  ] as const) {
    const { data } = await admin.from("leads").select("id").eq("store_id", storeId).eq(col, val).limit(2);
    const rows = (data as { id: string }[] | null) ?? [];
    if (rows.length === 1) {
      leadId = rows[0]!.id;
      break;
    }
    if (rows.length > 1) break;
  }
  if (!leadId) throw new Error("pedido a medias sin un lead de esta clienta: queda solo en el registro");
  await admin.from("lead_calls").insert({ lead_id: leadId, store_id: storeId, vendedora: null, kind: "system", note });
  await admin.from("leads").update({ needs_attention: true }).eq("id", leadId);
}

/** Rellena el celular del lead de la conversación si no tenía (`debeGuardarTelefono`). Un choque con otro lead no se insiste. */
async function fillConversationLeadPhone(
  admin: SupabaseClient,
  storeId: string,
  conversationId: string,
  phone: string | null,
): Promise<void> {
  if (!phone) return;
  const { data } = await admin
    .from("leads")
    .select("id, phone")
    .eq("store_id", storeId)
    .eq("kapso_conversation_id", conversationId)
    .limit(2);
  const leads = (data as { id: string; phone: string | null }[] | null) ?? [];
  // Uno solo: con dos leads en la misma conversación no se adivina cuál.
  if (leads.length !== 1 || !debeGuardarTelefono(leads[0]!.phone, phone)) return;
  await admin.from("leads").update({ phone }).eq("id", leads[0]!.id).is("phone", null);
}
