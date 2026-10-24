// WooCommerce (MOM §38, 23-10-2026): el cliente de su API REST v3, la firma de
// sus webhooks y el mapeador de un pedido de WooCommerce a la MISMA fila de
// `orders` que hoy sale de Shopify (`OrderRow`, lib/types.ts).
//
// POR QUÉ. Shopify cierra Kenku Perú y Aurela el 28-10-2026 y las dos pasan a
// WooCommerce. Todo Kapta —Master, guías, cobros, liquidaciones, Leads— lee la
// fila de `orders`, no a Shopify. Si un pedido de WooCommerce llega con la misma
// forma (los mismos campos, las mismas etiquetas, el mismo `raw` con forma de
// Shopify REST), el resto del sistema no se entera del cambio. Por eso este
// módulo no inventa campos nuevos: traduce.
//
// LO QUE FIJA (y está en el MOM §38):
//   · id:      `shopify_order_id = "wc-<clave del sitio>-<id>"` (`wc-kp-1532`).
//              La clave va porque los dos WordPress numeran desde 1 y hay
//              consultas que buscan por id sin filtrar por tienda.
//   · nombre:  `"#" + number` (el número del plugin de numeración, `KP200001`).
//   · fechas:  las `*_gmt` de WooCommerce, que llegan sin zona, más «Z».
//   · cobro:   contraentrega (`cod`) es SIEMPRE `pending`: WooCommerce llena
//              `date_paid` en cuanto el pedido pasa a «processing», así que
//              `date_paid` nunca cuenta como pagado.
//   · anulado: `cancelled` (y `trash`) → `voided` y `cancelled_at`.
//   · fuera:   `pending`, `failed`, `checkout-draft` (y los borradores internos
//              `draft`/`auto-draft`) no son pedidos: no entran a `orders`.
//   · plataforma: `platform = "woocommerce"`. Lo que dependa de la plataforma
//              se decide con esa columna, nunca por la forma del id:
//              `extractNumericId("wc-kp-1532")` devuelve "1532".
//
// SIN SECRETOS EN LOS MENSAJES. Ningún error de este módulo lleva la Consumer
// key, el Consumer secret ni la URL de la petición (en el modo por query string
// la URL lleva las dos).

import { Buffer } from "node:buffer";
import { DEPARTAMENTO_POR_ISO } from "@/lib/pin-corroborado";
import { normalizePhone } from "@/lib/phone";
import { CHECKOUT_GATEWAYS, type PaymentGateway } from "@/lib/payment-gateway";
import {
  deriveOrderFlags,
  noteAttributesToMap,
  parseDiscountCodes,
  parseTags,
  resolvePeruProvinceCode,
  verifyShopifyHmac,
} from "@/lib/shopify";
import { NOTE_ATTR, TAGS, type OrderLineItem, type OrderPlatform, type OrderRow } from "@/lib/types";

// ---------------------------------------------------------------------------
// La forma de un pedido de WooCommerce REST v3 (y del cuerpo de sus webhooks
// `order.*`, que es el mismo recurso). Todo opcional: el mapeador no confía en
// que venga completo.
// ---------------------------------------------------------------------------

export interface WooMeta {
  id?: number;
  key: string;
  value: unknown;
  display_key?: string;
  display_value?: unknown;
}

export interface WooAddress {
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  address_1?: string | null;
  address_2?: string | null;
  city?: string | null;
  state?: string | null;
  postcode?: string | null;
  country?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface WooLineItem {
  id?: number;
  name?: string | null;
  parent_name?: string | null;
  product_id?: number | null;
  variation_id?: number | null;
  quantity?: number | null;
  subtotal?: string | null;
  subtotal_tax?: string | null;
  total?: string | null;
  total_tax?: string | null;
  sku?: string | null;
  price?: number | string | null;
  meta_data?: WooMeta[] | null;
}

export interface WooShippingLine {
  id?: number;
  method_title?: string | null;
  method_id?: string | null;
  total?: string | null;
  total_tax?: string | null;
}

export interface WooFeeLine {
  id?: number;
  name?: string | null;
  total?: string | null;
  total_tax?: string | null;
}

export interface WooCouponLine {
  id?: number;
  code?: string | null;
  discount?: string | null;
  discount_tax?: string | null;
}

/** Un reembolso como lo lista el pedido: `total` llega en negativo («-12.00»). */
export interface WooRefund {
  id?: number;
  reason?: string | null;
  total?: string | null;
  total_tax?: string | null;
}

export interface WooOrder {
  id: number;
  parent_id?: number | null;
  number?: string | null;
  order_key?: string | null;
  created_via?: string | null;
  version?: string | null;
  status?: string | null;
  currency?: string | null;
  date_created?: string | null;
  date_created_gmt?: string | null;
  date_modified?: string | null;
  date_modified_gmt?: string | null;
  date_paid_gmt?: string | null;
  date_completed_gmt?: string | null;
  discount_total?: string | null;
  discount_tax?: string | null;
  shipping_total?: string | null;
  shipping_tax?: string | null;
  cart_tax?: string | null;
  total?: string | null;
  total_tax?: string | null;
  prices_include_tax?: boolean | null;
  customer_id?: number | null;
  customer_note?: string | null;
  billing?: WooAddress | null;
  shipping?: WooAddress | null;
  payment_method?: string | null;
  payment_method_title?: string | null;
  transaction_id?: string | null;
  meta_data?: WooMeta[] | null;
  line_items?: WooLineItem[] | null;
  shipping_lines?: WooShippingLine[] | null;
  fee_lines?: WooFeeLine[] | null;
  coupon_lines?: WooCouponLine[] | null;
  refunds?: WooRefund[] | null;
}

/** Lo que el mapeador necesita de la tienda de Kapta. */
export interface WooStoreRef {
  /** `stores.id`. */
  id: string;
  /** `stores.woo_site_key` ('kp', 'aur'). */
  woo_site_key: string;
}

export const WOO_PLATFORM: OrderPlatform = "woocommerce";

// ---------------------------------------------------------------------------
// Identidad del pedido
// ---------------------------------------------------------------------------

/** La misma regla que `stores_woo_site_key_check` (0274). */
export const WOO_SITE_KEY_RE = /^[a-z][a-z0-9]{1,11}$/;

export function isValidWooSiteKey(key: unknown): key is string {
  return typeof key === "string" && WOO_SITE_KEY_RE.test(key);
}

/**
 * El id con el que un pedido de WooCommerce se guarda en
 * `orders.shopify_order_id`: `wc-<clave>-<id>`. Lanza si la clave o el id no
 * tienen forma: un id mal formado se guardaría para siempre.
 */
export function wooOrderId(siteKey: string, wooId: number | string): string {
  if (!isValidWooSiteKey(siteKey)) {
    throw new Error("woo_site_key inválida: minúsculas y dígitos, de 2 a 12, empezando por letra.");
  }
  const id = String(wooId ?? "").trim();
  if (!/^[1-9]\d*$/.test(id)) throw new Error("El pedido de WooCommerce no trae un id válido.");
  return `wc-${siteKey}-${id}`;
}

/**
 * Lo contrario de `wooOrderId`, o null si el valor no es un id de WooCommerce.
 * Vive en lib/order-admin-url.ts, sin imports de Node, porque el enlace al
 * pedido se arma también en el navegador (MOM §38.12).
 */
export { parseWooOrderId } from "@/lib/order-admin-url";

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

/**
 * Lo que NO es un pedido y no entra a `orders` (ni al Master): el pago que no
 * llegó a hacerse, el que falló, el carrito del checkout por bloques y los
 * borradores internos del admin.
 */
export const WOO_SKIPPED_STATUSES: readonly string[] = ["pending", "failed", "checkout-draft", "draft", "auto-draft"];

/** Anulado en WooCommerce: `cancelled`, o en la papelera (`trash`). */
export const WOO_CANCELLED_STATUSES: readonly string[] = ["cancelled", "trash"];

function statusOf(order: Pick<WooOrder, "status"> | null | undefined): string {
  return String(order?.status ?? "")
    .trim()
    .toLowerCase()
    .replace(/^wc-/, "");
}

/** ¿Este pedido de WooCommerce va a `orders`? */
export function isWooOrderIngestible(order: Pick<WooOrder, "status"> | null | undefined): boolean {
  const status = statusOf(order);
  return Boolean(status) && !WOO_SKIPPED_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Ayudantes puros
// ---------------------------------------------------------------------------

function text(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function money(n: number): string {
  return round2(n).toFixed(2);
}

/**
 * Una fecha `*_gmt` de WooCommerce («2026-10-23T14:05:09», sin zona) como ISO en
 * UTC: se le agrega «Z». Si ya trae zona, se deja. Vacía o rara → null.
 */
export function wooGmt(value: unknown): string | null {
  const s = text(value);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) return `${s}Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) return s;
  return null;
}

const TRUTHY = new Set(["true", "1", "yes", "si", "sí", "y"]);

/**
 * Claves de `meta_data` de Kapta y de Kapso (`kapta_*`, `kapso_*`, `kapso`), en
 * minúsculas y sin el «_» si lo traen: WooCommerce oculta en el admin los meta
 * que empiezan por «_», pero la API los devuelve igual.
 */
function kaptaMetaKey(key: string): string | null {
  const bare = key.trim().toLowerCase().replace(/^_/, "");
  if (bare.startsWith("kapta_") || bare.startsWith("kapso_") || bare === "kapso") return bare;
  return null;
}

/** Valor de un meta como texto: lo que Shopify guarda en un atributo de nota. */
function metaText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value).slice(0, 2000);
  } catch {
    return "";
  }
}

const ORDER_ATTRIBUTION_UTM_PREFIX = "_wc_order_attribution_utm_";

/**
 * `meta_data` del pedido → `note_attributes` con la forma de Shopify REST
 * (`{name, value}`), que es lo que leen `deriveOrderFlags`, `orders.utm_meta`
 * (0156) y `shopifyDepartamentoElegido`:
 *   · los meta visibles (sin «_»), tal cual: entre ellos las claves de
 *     `NOTE_ATTR` (`shipping_mode`, `stock_por_validar`…);
 *   · los de Kapta y Kapso (`kapta_*`, `kapso_*`, `kapso`), en minúsculas y sin
 *     el «_» si lo traen;
 *   · la atribución de WooCommerce (`_wc_order_attribution_utm_source`…) como
 *     `utm_source`…, si no hay ya un `utm_*` con ese nombre;
 *   · los demás meta ocultos (de plugins) quedan fuera: siguen en `raw.woo`.
 */
export function wooNoteAttributes(meta: readonly WooMeta[] | null | undefined): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const utm: { name: string; value: string }[] = [];
  if (!Array.isArray(meta)) return out;
  for (const m of meta) {
    if (!m || typeof m.key !== "string" || !m.key.trim()) continue;
    const key = m.key.trim();
    const lower = key.toLowerCase();
    if (lower.startsWith(ORDER_ATTRIBUTION_UTM_PREFIX)) {
      const name = `utm_${lower.slice(ORDER_ATTRIBUTION_UTM_PREFIX.length)}`;
      const value = metaText(m.value);
      if (value) utm.push({ name, value });
      continue;
    }
    const kapta = kaptaMetaKey(key);
    if (kapta) {
      out.push({ name: kapta, value: metaText(m.value) });
      continue;
    }
    if (key.startsWith("_")) continue;
    out.push({ name: key, value: metaText(m.value) });
  }
  const have = new Set(out.map((a) => a.name.toLowerCase()));
  for (const a of utm) {
    if (!have.has(a.name)) {
      out.push(a);
      have.add(a.name);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Etiquetas: las mismas palabras que hoy pone Shopify
// ---------------------------------------------------------------------------

/**
 * `kapta_channel` → las etiquetas que hoy lleva un pedido de ese canal en
 * Shopify. Así `salesChannel` (lib/sales-channel.ts), `order_sales_channel`
 * (0264), `canal_de_cierre` (0259), `recompute_daily_rollups` y `hasKapsoTag`
 * no cambian una línea. Se aceptan el nombre del canal y la etiqueta de hoy.
 * Un valor que no está aquí no pone ninguna etiqueta («Sin marca»): no se
 * adivina.
 */
export const WOO_CHANNEL_TAGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  asesora: ["venta_manual"],
  venta_manual: ["venta_manual"],
  chatbot: [TAGS.kapso, TAGS.whatsapp],
  kapso: [TAGS.kapso, TAGS.whatsapp],
  // El bot de WhatsApp de Aurela crea sus pedidos directo en WooCommerce con
  // `whatsapp_bot` (decisión del owner, 24-10-2026): es el mismo canal.
  whatsapp_bot: [TAGS.kapso, TAGS.whatsapp],
  bot_carritos: ["BOT", "CARRITO RECUPERADO"],
  catalogo: ["catalogo-wsp"],
  "catalogo-wsp": ["catalogo-wsp"],
  web_carrito: ["easysell-abandoned-checkout"],
  web_formulario: ["easysell_cod_form"],
});

/** Las claves de `meta_data` que arman las etiquetas. */
export const WOO_META = {
  channel: "kapta_channel",
  tags: "kapta_tags",
  kapso: "kapso",
  conversationId: NOTE_ATTR.conversationId,
  leadId: "kapta_lead_id",
  /**
   * El intento de «Generar pedido» que creó el pedido (MOM §38.12). Con él un
   * reintento encuentra el pedido del intento anterior en vez de crear otro
   * (lib/woocommerce-orders.ts).
   */
  requestId: "kapta_request_id",
  /**
   * La huella de lo que pidió ese intento (productos, precios, dirección, nota
   * y lead; `wooSaleFingerprint`). Un reintento solo retoma o adopta el pedido
   * del intento anterior si el formulario sigue diciendo lo mismo (MOM §38.12).
   */
  requestHash: "kapta_request_hash",
} as const;

function parseTagList(value: string): string[] {
  const s = value.trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return parseTags(arr.filter((t) => typeof t === "string"));
    } catch {
      /* no era JSON: se lee como lista separada por comas */
    }
  }
  return parseTags(s);
}

/**
 * Las etiquetas del pedido, desde sus atributos (los meta ya pasados por
 * `wooNoteAttributes` y `noteAttributesToMap`):
 *   1. `kapta_tags` (JSON o separadas por comas), tal cual: así el bot puede
 *      mandar `promo-whatsapp`, `stock-por-validar`, `contraentrega`…;
 *   2. las de `kapta_channel` (`WOO_CHANNEL_TAGS`);
 *   3. `kapso` si el meta `kapso` es verdadero o el pedido trae
 *      `kapso_conversation_id`: es la marca que gana el lead y cuenta en los
 *      rollups del bot.
 * Sin repetir (sin importar mayúsculas), en ese orden.
 */
export function wooTags(attrs: Record<string, string>): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    const k = t.trim().toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    tags.push(t.trim());
  };
  for (const t of parseTagList(attrs[WOO_META.tags] ?? "")) add(t);
  const channel = (attrs[WOO_META.channel] ?? "").trim().toLowerCase();
  for (const t of WOO_CHANNEL_TAGS[channel] ?? []) add(t);
  if (TRUTHY.has((attrs[WOO_META.kapso] ?? "").trim().toLowerCase()) || (attrs[WOO_META.conversationId] ?? "").trim()) {
    add(TAGS.kapso);
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Cobro
// ---------------------------------------------------------------------------

const CHECKOUT_TITLES = new Set(CHECKOUT_GATEWAYS.map((n) => n.trim().toLowerCase()));

/**
 * Por dónde entró el dinero (lib/payment-gateway.ts), con la misma regla:
 *   · `cod` (contraentrega de WooCommerce) → `cod`;
 *   · una pasarela cuyo título es uno de `CHECKOUT_GATEWAYS` → `checkout`. La
 *     de Flow para WooCommerce entra cuando la operación confirme su nombre
 *     exacto y se agregue ahí (MOM §38);
 *   · cualquier otra (transferencia `bacs`, Yape, una nueva) → null: no se sabe
 *     y sigue el conducto regular de las constancias. No se adivina.
 */
export function wooPaymentGateway(order: Pick<WooOrder, "payment_method" | "payment_method_title">): PaymentGateway | null {
  const method = (order.payment_method ?? "").trim().toLowerCase();
  if (method === "cod") return "cod";
  const title = (order.payment_method_title ?? "").trim().toLowerCase();
  if (title && CHECKOUT_TITLES.has(title)) return "checkout";
  return null;
}

/**
 * Las pasarelas (`payment_method`) en las que «processing» o «completed» quiere
 * decir que el dinero ya entró (MOM §38.4):
 *   · `bacs` (transferencia bancaria directa): WooCommerce la deja «on-hold»
 *     y solo pasa a «processing» cuando alguien confirma a mano que llegó, como
 *     el «manual» de Shopify. La operación puede sacarla de aquí.
 * La pasarela de Flow entra por su TÍTULO confirmado en `CHECKOUT_GATEWAYS`
 * (`wooPaymentGateway` → `checkout`), no por su slug, que nadie confirmó.
 * Cualquier otra —vacía (el «Añadir pedido» de wp-admin con «N/D»), un plugin de
 * contraentrega con su propio slug, una nueva— NO es pagado: en wp-admin
 * «processing» quiere decir «en preparación», no «cobrado».
 */
export const WOO_PREPAID_METHODS: readonly string[] = ["bacs"];

/**
 * `financial_status` con el vocabulario de Shopify:
 *   · `cancelled`/`trash` → `voided`;
 *   · `refunded` → `refunded`;
 *   · contraentrega → `pending` en cualquier otro estado: el dinero lo cobra el
 *     courier, y `date_paid` (que WooCommerce llena al pasar a «processing») no
 *     dice nada;
 *   · una pasarela de prepago confirmada (`WOO_PREPAID_METHODS`, o el título de
 *     Flow en `CHECKOUT_GATEWAYS`) en `processing` o `completed` → `paid`, o
 *     `partially_refunded` si ya tiene un reembolso;
 *   · cualquier otra pasarela, también vacía o desconocida, → `pending`: sigue
 *     el camino seguro de la confirmación y las constancias (lo mismo que
 *     `wooPaymentGateway` hace con la pasarela);
 *   · lo demás (`on-hold`, estados de plugins) → `pending`.
 */
export function wooFinancialStatus(
  order: Pick<WooOrder, "status" | "payment_method" | "payment_method_title">,
  totalRefunded: number,
): string {
  const status = statusOf(order);
  if (WOO_CANCELLED_STATUSES.includes(status)) return "voided";
  if (status === "refunded") return "refunded";
  const method = (order.payment_method ?? "").trim().toLowerCase();
  if (method === "cod") return "pending";
  const prepaid = WOO_PREPAID_METHODS.includes(method) || wooPaymentGateway(order) === "checkout";
  if (prepaid && (status === "processing" || status === "completed")) {
    return totalRefunded > 0 ? "partially_refunded" : "paid";
  }
  return "pending";
}

/** Suma de los reembolsos (`refunds[].total` llega en negativo). */
export function sumWooRefunds(refunds: readonly WooRefund[] | null | undefined): number {
  if (!Array.isArray(refunds)) return 0;
  let total = 0;
  for (const r of refunds) total += Math.abs(num(r?.total) ?? 0);
  return round2(total);
}

// ---------------------------------------------------------------------------
// Departamento: los códigos de WooCommerce para Perú
// ---------------------------------------------------------------------------

/**
 * WooCommerce tiene DOS Limas (i18n/states.php): `LMA` es la Municipalidad
 * Metropolitana de Lima y `LIM` el resto del departamento (Huaral, Cañete,
 * Barranca…). Shopify las manda como «Lima (provincia)» y «Lima (departamento)»,
 * y es esa diferencia la que separa «Lima» de «Provincia» en la operación
 * (`limaRegionKind`, lib/order-coverage.ts). `resolvePeruProvinceCode` no conoce
 * `LIM`, así que la traducción es explícita, en las dos direcciones.
 * Los demás códigos coinciden con el ISO 3166-2:PE (`ARE` = PE-ARE).
 */
export const WOO_PE_STATE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(Object.entries(DEPARTAMENTO_POR_ISO).map(([iso, name]) => [iso.slice(3), name])),
  LMA: "Lima (provincia)",
  LIM: "Lima (departamento)",
  CAL: "Callao",
});

/** El departamento como lo manda Shopify en `shipping_address.province`, o null. */
export function wooPeruStateName(state: unknown): string | null {
  const code = (text(state) ?? "").toUpperCase().replace(/^PE-/, "");
  return WOO_PE_STATE_NAMES[code] ?? null;
}

/**
 * Lo contrario, para crear un pedido en WooCommerce desde Kapta: un
 * departamento escrito como lo guarda Kapta («Lima (departamento)», «Arequipa»,
 * «PE-PUN») → el código de WooCommerce (`LIM`, `ARE`, `PUN`). «Lima» a secas es
 * `LMA`, como hoy en Shopify. Null si no se reconoce.
 */
export function toWooPeruState(province: string | null | undefined): string | null {
  const raw = text(province);
  if (!raw) return null;
  const upper = raw.toUpperCase().replace(/^PE-/, "");
  if (upper === "LIM") return "LIM";
  const lower = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (lower.includes("lima") && (lower.includes("departamento") || lower.includes("dpto") || lower.includes("region"))) {
    return "LIM";
  }
  return resolvePeruProvinceCode(raw);
}

// ---------------------------------------------------------------------------
// Dirección con la forma de Shopify REST
// ---------------------------------------------------------------------------

function hasAddress(a: WooAddress | null | undefined): a is WooAddress {
  return Boolean(a && (text(a.address_1) || text(a.city) || text(a.state)));
}

function fullName(a: WooAddress | null | undefined): string | null {
  return text([text(a?.first_name), text(a?.last_name)].filter(Boolean).join(" "));
}

/**
 * Una dirección de WooCommerce → `shipping_address` de Shopify REST, que es lo
 * que leen `shopifyShippingAddress` (14 lugares), `swayp_auto_snapshot` y la
 * cobertura. `province` es el nombre del departamento como lo manda Shopify
 * (`wooPeruStateName`); si el estado no es un código conocido, va tal cual.
 * WooCommerce no geocodifica: sin latitud ni longitud.
 */
function shopifyShapedAddress(a: WooAddress, fallbackPhone: string | null) {
  const state = text(a.state);
  const country = (text(a.country) ?? "").toUpperCase();
  const isPeru = !country || country === "PE";
  const province = (isPeru ? wooPeruStateName(state) : null) ?? state;
  return {
    first_name: text(a.first_name),
    last_name: text(a.last_name),
    name: fullName(a),
    company: text(a.company),
    address1: text(a.address_1),
    address2: text(a.address_2),
    city: text(a.city),
    province,
    province_code: state ? state.toUpperCase() : null,
    country: isPeru ? "Peru" : country || null,
    country_code: country || (isPeru ? "PE" : null),
    zip: text(a.postcode),
    phone: text(a.phone) ?? fallbackPhone,
    latitude: null,
    longitude: null,
  };
}

// ---------------------------------------------------------------------------
// El mapeador
// ---------------------------------------------------------------------------

export interface MapWooOrderOptions {
  /**
   * `orders.cancelled_at` que ya tiene la fila, si existe. Un pedido anulado
   * conserva la fecha en que Kapta lo vio anulado por primera vez: WooCommerce
   * no guarda cuándo se anuló y `date_modified_gmt` se mueve con cada cambio.
   */
  previousCancelledAt?: string | null;
}

function variantTitle(li: WooLineItem): string | null {
  if (!(num(li.variation_id) ?? 0)) return null;
  const parts: string[] = [];
  for (const m of li.meta_data ?? []) {
    if (!m || typeof m.key !== "string" || m.key.startsWith("_")) continue;
    const v = text(metaText(m.display_value ?? m.value));
    if (v) parts.push(v);
  }
  return parts.length ? parts.join(" / ") : null;
}

function mapLineItem(li: WooLineItem, pricesIncludeTax: boolean): OrderLineItem {
  const quantity = Number(num(li.quantity) ?? 0);
  const base = num(li.subtotal);
  const subtotal = base == null ? null : base + (pricesIncludeTax ? (num(li.subtotal_tax) ?? 0) : 0);
  const productId = num(li.product_id) ?? 0;
  const variationId = num(li.variation_id) ?? 0;
  return {
    // Shopify guarda el título del producto y la variante aparte; WooCommerce
    // pone las opciones en el `name` de una variación («Zapatilla - 38, Negro»)
    // y el título del producto en `parent_name`.
    title: text(li.parent_name) ?? text(li.name) ?? "",
    variant_title: variantTitle(li),
    quantity,
    sku: text(li.sku),
    product_id: productId > 0 ? String(productId) : null,
    variant_id: variationId > 0 ? String(variationId) : null,
    // El precio unitario ANTES de descuentos, como `originalUnitPrice` de Shopify.
    // Sin subtotal no hay precio (null), que no es lo mismo que un regalo a S/ 0.
    price: quantity > 0 && subtotal != null ? round2(subtotal / quantity) : null,
  };
}

/**
 * Un pedido de WooCommerce (REST v3 o cuerpo de webhook `order.*`) → la fila de
 * `orders`, igual que `mapRestOrder`/`mapGraphqlOrder` para Shopify.
 *
 * Devuelve null si el pedido no va a `orders` (`WOO_SKIPPED_STATUSES`). Lanza si
 * la tienda no tiene `woo_site_key` válida o el pedido no trae id: son errores
 * de configuración, no de un pedido.
 */
export function mapWooOrder(order: WooOrder, store: WooStoreRef, opts: MapWooOrderOptions = {}): OrderRow | null {
  const shopifyOrderId = wooOrderId(store.woo_site_key, order?.id);
  if (!isWooOrderIngestible(order)) return null;

  const status = statusOf(order);
  const pricesIncludeTax = order.prices_include_tax === true;
  const currency = text(order.currency);

  // Atributos y etiquetas.
  const shippingSource = hasAddress(order.shipping) ? order.shipping : hasAddress(order.billing) ? order.billing : null;
  const noteAttributes = wooNoteAttributes(order.meta_data);
  const state = text(shippingSource?.state);
  const country = (text(shippingSource?.country) ?? "PE").toUpperCase();
  if (
    state &&
    country === "PE" &&
    wooPeruStateName(state) &&
    !noteAttributes.some((a) => /^provincia/i.test(a.name))
  ) {
    // El departamento elegido de una lista cerrada, como el «Provincia:» del
    // formulario COD de hoy (`shopifyDepartamentoElegido`).
    noteAttributes.push({ name: "Provincia:", value: `PE-${state.toUpperCase().replace(/^PE-/, "")}` });
  }
  const attrs = noteAttributesToMap(noteAttributes);
  const tags = wooTags(attrs);
  const flags = deriveOrderFlags(tags, attrs);

  // Dinero.
  const totalRefunded = sumWooRefunds(order.refunds);
  const lineItems = (order.line_items ?? []).filter(Boolean).map((li) => mapLineItem(li, pricesIncludeTax));
  const subtotal = (order.line_items ?? []).reduce(
    (sum, li) => sum + (num(li?.subtotal) ?? 0) + (pricesIncludeTax ? (num(li?.subtotal_tax) ?? 0) : 0),
    0,
  );
  // Un cargo negativo (`fee_lines`) es un descuento puesto a mano.
  const negativeFees = (order.fee_lines ?? []).reduce((sum, f) => {
    const t = (num(f?.total) ?? 0) + (pricesIncludeTax ? (num(f?.total_tax) ?? 0) : 0);
    return t < 0 ? sum + Math.abs(t) : sum;
  }, 0);
  const discounts =
    (num(order.discount_total) ?? 0) + (pricesIncludeTax ? (num(order.discount_tax) ?? 0) : 0) + negativeFees;
  const shipping = (num(order.shipping_total) ?? 0) + (pricesIncludeTax ? (num(order.shipping_tax) ?? 0) : 0);
  const total = num(order.total);

  // Teléfono: el de facturación y, si falta, el de envío.
  const phoneText = text(order.billing?.phone) ?? text(order.shipping?.phone);
  const createdAt = wooGmt(order.date_created_gmt);
  const updatedAt = wooGmt(order.date_modified_gmt) ?? createdAt;

  const cancelled = WOO_CANCELLED_STATUSES.includes(status);
  const cancelledAt = cancelled ? (text(opts.previousCancelledAt) ?? updatedAt ?? createdAt) : null;

  const gatewayName = text(order.payment_method_title) ?? text(order.payment_method);
  const email = text(order.billing?.email);
  const orderNumber = text(order.number)?.replace(/^#/, "") || String(order.id);

  const raw = {
    source: WOO_PLATFORM,
    // La copia con la forma de Shopify REST, para los lectores de `raw` de hoy.
    note: text(order.customer_note),
    note_attributes: noteAttributes,
    shipping_address: shippingSource ? shopifyShapedAddress(shippingSource, phoneText) : null,
    billing_address: hasAddress(order.billing) ? shopifyShapedAddress(order.billing, phoneText) : null,
    contact_email: email,
    customer: {
      email,
      first_name: text(order.billing?.first_name),
      last_name: text(order.billing?.last_name),
      phone: phoneText,
    },
    payment_gateway_names: gatewayName ? [gatewayName] : [],
    subtotal_price: money(subtotal),
    total_discounts: money(discounts),
    total_shipping_price_set: {
      shop_money: { amount: money(shipping), currency_code: currency },
      presentment_money: { amount: money(shipping), currency_code: currency },
    },
    total_price: total != null ? money(total) : null,
    // El pedido de WooCommerce entero, tal cual llegó.
    woo: order,
  };

  return {
    store_id: store.id,
    shopify_order_id: shopifyOrderId,
    name: `#${orderNumber}`,
    created_at: createdAt,
    // La fecha del pedido, no la del pago: `date_paid` no significa cobrado.
    processed_at: createdAt,
    updated_at: updatedAt,
    total_amount: total,
    currency,
    financial_status: wooFinancialStatus(order, totalRefunded),
    payment_gateway: wooPaymentGateway(order),
    cancelled_at: cancelledAt,
    cancel_reason: null,
    total_refunded: totalRefunded,
    customer_phone: normalizePhone(phoneText),
    tags,
    discount_codes: parseDiscountCodes((order.coupon_lines ?? []).map((c) => c?.code)),
    ...flags,
    line_items: lineItems,
    raw,
    platform: WOO_PLATFORM,
  };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * La firma de un webhook de WooCommerce (`X-WC-Webhook-Signature`): HMAC-SHA256
 * del cuerpo crudo con el secreto del webhook, en base64. Es el mismo algoritmo
 * que Shopify, así que es `verifyShopifyHmac`, comparación en tiempo constante
 * incluida. El cuerpo tiene que ser el CRUDO (antes de `JSON.parse`).
 *
 * WooCommerce pasa el secreto por `wp_specialchars_decode` antes de firmar: un
 * secreto generado por Kapta tiene que ser hexadecimal o base64url (sin `&`,
 * `<`, `>` ni comillas) para que firme igual en los dos lados.
 */
export function verifyWooSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  return verifyShopifyHmac(rawBody, signatureHeader, secret);
}

/**
 * El «ping» con que WooCommerce prueba la dirección al crear un webhook: un POST
 * `webhook_id=<n>` en formulario, SIN firma. Si no recibe un 200, no activa el
 * webhook. Devuelve el id del webhook si el cuerpo es ese ping, o null.
 */
export function parseWooWebhookPing(rawBody: string | Buffer | null | undefined): number | null {
  if (rawBody == null) return null;
  const body = (typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")).trim();
  const m = body.match(/^webhook_id=(\d{1,12})$/);
  return m ? Number(m[1]) : null;
}

/** Cabeceras de un webhook de WooCommerce (en minúsculas, como las da `Headers`). */
export const WOO_WEBHOOK_HEADERS = {
  signature: "x-wc-webhook-signature",
  topic: "x-wc-webhook-topic",
  resource: "x-wc-webhook-resource",
  event: "x-wc-webhook-event",
  source: "x-wc-webhook-source",
  webhookId: "x-wc-webhook-id",
  /** NO sirve para detectar duplicados: es `wp_hash(id . segundo)` y se repite. */
  deliveryId: "x-wc-webhook-delivery-id",
} as const;

/** Los temas de pedido que Kapta registra. */
export const WOO_ORDER_TOPICS = ["order.created", "order.updated", "order.deleted", "order.restored"] as const;

// ---------------------------------------------------------------------------
// Cliente REST
// ---------------------------------------------------------------------------

export const WOO_API_PREFIX = "/wp-json/wc/v3";
/** Tiempo límite de cada llamada. El sync corre con 300 s para todas las tiendas. */
export const WOO_TIMEOUT_MS = 15_000;
/** El máximo que admite WooCommerce por página. */
export const WOO_MAX_PER_PAGE = 100;
/** Tope de páginas de `wooPaginate` por llamada, para no quedarse sin tiempo. */
export const WOO_DEFAULT_MAX_PAGES = 20;

/**
 * Cómo se autentica cada llamada:
 *   · `basic` (por defecto): cabecera `Authorization: Basic` con la Consumer key
 *     y el Consumer secret. WooCommerce solo la acepta por HTTPS.
 *   · `query`: `consumer_key` y `consumer_secret` en la query string. Es el
 *     respaldo para hostings o WAF que BORRAN la cabecera Authorization (se
 *     nota porque WooCommerce responde 401 `woocommerce_rest_cannot_view` con
 *     claves buenas). Solo por HTTPS, y la URL nunca se registra: lleva los dos.
 */
export type WooAuthMode = "basic" | "query";

export interface WooClientOpts {
  /** `stores.woo_site_url`. */
  siteUrl: string;
  /** Descifradas, solo en el servidor. */
  consumerKey: string;
  consumerSecret: string;
  auth?: WooAuthMode;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type WooErrorKind =
  | "config"
  | "red"
  | "tiempo"
  | "redireccion"
  | "credenciales"
  | "permisos"
  | "no_encontrado"
  | "limite"
  | "servidor"
  | "rechazo"
  | "respuesta_invalida";

/** Un fallo al hablar con WooCommerce, con un mensaje que se puede mostrar y guardar (`woo_last_error`). */
export class WooError extends Error {
  readonly kind: WooErrorKind;
  readonly status: number | null;
  /** El `code` de WooCommerce (`woocommerce_rest_shop_order_invalid_id`…), si lo hubo. */
  readonly code: string | null;
  constructor(kind: WooErrorKind, message: string, status: number | null = null, code: string | null = null) {
    super(message);
    this.name = "WooError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

const PRIVATE_HOST_RE =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home|.*\.corp|metadata\.google\.internal)$/i;

/**
 * La dirección del sitio, limpia: `https://host[/ruta]` sin barra final, o null
 * si no vale. Solo https (WooCommerce no acepta Basic auth sin TLS y las claves
 * viajarían en claro), sin usuario ni contraseña, sin query ni fragmento, sin
 * puerto que no sea el 443, y nunca una IP ni un nombre interno: Kapta no es un
 * proxy hacia la red privada de nadie.
 */
export function normalizeWooSiteUrl(input: unknown): string | null {
  const raw = text(input);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.port && url.port !== "443") return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || PRIVATE_HOST_RE.test(host)) return null;
  // IPv4, IPv6 (entre corchetes) o un número suelto: no.
  if (/^\d+(\.\d+){0,3}$/.test(host) || host.startsWith("[") || host.includes(":")) return null;
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")) return null;
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/wp-json(\/|$)/i.test(path)) return null;
  return `https://${host}${path}`;
}

/** Quita de un texto cualquier aparición de los secretos. Defensa extra. */
function redact(value: string, secrets: Array<string | null | undefined>): string {
  let out = value;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[oculto]");
  return out;
}

function plainMessage(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** Clasifica una respuesta que no es 2xx. Pura y exportada para probarla. */
export function wooErrorFromResponse(
  status: number,
  body: { code?: unknown; message?: unknown } | null,
  auth: WooAuthMode = "basic",
): WooError {
  const code = typeof body?.code === "string" ? body.code.trim() : null;
  const said = plainMessage(body?.message);
  const detail = said ? ` WooCommerce dice: «${said}».` : "";
  // La clave existe pero no tiene el permiso del método: una de «Lectura»
  // contra un POST/PUT/DELETE, o una de «Escritura» contra un GET
  // (WC_REST_Authentication::check_permissions). No es la clave mal copiada.
  const sinPermiso = status === 401 && code === "woocommerce_rest_authentication_error" ? /\b(read|write) permissions?\b/i.exec(said) : null;
  if (sinPermiso) {
    const falta = sinPermiso[1]!.toLowerCase() === "write" ? "de solo lectura" : "de solo escritura";
    return new WooError(
      "permisos",
      `La clave de la API de WooCommerce es ${falta} (HTTP 401).${detail} Crea una con permisos de «Lectura/Escritura» en WooCommerce → Ajustes → Avanzado → API REST y guárdala en Ajustes → WooCommerce.`,
      status,
      code,
    );
  }
  if (status === 401 && code === "woocommerce_rest_authentication_error") {
    return new WooError(
      "credenciales",
      `WooCommerce rechazó la Consumer key o el Consumer secret (HTTP 401).${detail} Revísalas en WooCommerce → Ajustes → Avanzado → API REST.`,
      status,
      code,
    );
  }
  if (status === 401 || status === 403) {
    const hint =
      auth === "basic" && status === 401 && code?.startsWith("woocommerce_rest_cannot_")
        ? " Si la clave es de lectura/escritura, el hosting puede estar borrando la cabecera Authorization: prueba la autenticación por query string."
        : " Revisa que la clave sea de lectura/escritura y de un usuario «shop manager».";
    return new WooError("permisos", `WooCommerce no dio permiso (HTTP ${status}).${detail}${hint}`, status, code);
  }
  if (status === 404) {
    const message =
      code === "rest_no_route"
        ? "Esa dirección no tiene la API de WooCommerce (wp-json/wc/v3): revisa la dirección del sitio y que los enlaces permanentes no sean «simples»."
        : `WooCommerce no encontró lo pedido (HTTP 404).${detail}`;
    return new WooError("no_encontrado", message, status, code);
  }
  if (status === 429) {
    return new WooError("limite", "WooCommerce pidió esperar (HTTP 429): demasiadas llamadas seguidas.", status, code);
  }
  if (status >= 500) {
    return new WooError("servidor", `WooCommerce falló (HTTP ${status}). Intenta de nuevo en unos minutos.`, status, code);
  }
  return new WooError("rechazo", `WooCommerce rechazó la llamada (HTTP ${status}).${detail}`, status, code);
}

export interface WooRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Ruta dentro de la API, con «/» delante: `/orders`, `/orders/1532`. */
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
}

export interface WooResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

/**
 * Una llamada a la API REST v3. Nunca sigue redirecciones (reenviarían las
 * claves a otra dirección), corta a los `timeoutMs` y, si falla, lanza un
 * `WooError` cuyo mensaje no lleva secretos ni la URL.
 */
export async function wooRequest<T = unknown>(opts: WooClientOpts, req: WooRequest): Promise<WooResponse<T>> {
  const site = normalizeWooSiteUrl(opts.siteUrl);
  if (!site) throw new WooError("config", "La dirección del sitio WooCommerce no es válida (tiene que ser https://…).");
  const consumerKey = (opts.consumerKey ?? "").trim();
  const consumerSecret = (opts.consumerSecret ?? "").trim();
  if (!consumerKey || !consumerSecret) throw new WooError("config", "Faltan la Consumer key o el Consumer secret.");
  if (!req.path.startsWith("/") || req.path.includes("..") || /[?#]/.test(req.path)) {
    throw new WooError("config", "Ruta de la API de WooCommerce inválida.");
  }
  const auth: WooAuthMode = opts.auth ?? "basic";
  const timeoutMs = opts.timeoutMs ?? WOO_TIMEOUT_MS;

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v == null) continue;
    params.set(k, String(v));
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (auth === "query") {
    params.set("consumer_key", consumerKey);
    params.set("consumer_secret", consumerSecret);
  } else {
    headers.Authorization = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`, "utf8").toString("base64")}`;
  }
  const method = req.method ?? "GET";
  let payload: string | undefined;
  if (req.body !== undefined && method !== "GET") {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(req.body);
  }
  const qs = params.toString();
  const url = `${site}${WOO_API_PREFIX}${req.path}${qs ? `?${qs}` : ""}`;

  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method,
      headers,
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new WooError("tiempo", `WooCommerce no respondió a tiempo (${Math.round(timeoutMs / 1000)} s).`);
    }
    throw new WooError("red", "No se pudo conectar con WooCommerce.");
  }

  const secrets = [consumerKey, consumerSecret];
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    const st = res.status >= 300 ? `HTTP ${res.status}` : "HTTP 3xx";
    throw new WooError(
      "redireccion",
      `WooCommerce respondió con una redirección (${st}). Usa la dirección final del sitio, con https y sin redirecciones.`,
      res.status || null,
    );
  }

  let rawText = "";
  try {
    rawText = await res.text();
  } catch {
    rawText = "";
  }
  let json: unknown = null;
  let parsed = false;
  if (rawText) {
    try {
      json = JSON.parse(rawText);
      parsed = true;
    } catch {
      parsed = false;
    }
  }

  if (!res.ok) {
    const body = parsed && json && typeof json === "object" ? (json as { code?: unknown; message?: unknown }) : null;
    const err = wooErrorFromResponse(res.status, body, auth);
    throw new WooError(err.kind, redact(err.message, secrets), err.status, err.code);
  }
  if (!parsed) {
    throw new WooError(
      "respuesta_invalida",
      `WooCommerce respondió algo que no es JSON (HTTP ${res.status}). Revisa que la dirección sea la del sitio y que un plugin de caché o seguridad no esté respondiendo por la API.`,
      res.status,
    );
  }
  return { data: json as T, status: res.status, headers: res.headers };
}

export interface WooPage<T> {
  items: T[];
  page: number;
  /** `X-WP-Total`; null si el sitio no lo manda. */
  total: number | null;
  /** `X-WP-TotalPages`; null si el sitio no lo manda. */
  totalPages: number | null;
}

function headerInt(headers: Headers, name: string): number | null {
  const v = headers.get(name);
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Una página de una colección (`GET`), con los totales de las cabeceras. */
export async function wooGetPage<T>(
  opts: WooClientOpts,
  path: string,
  query: WooRequest["query"] = {},
): Promise<WooPage<T>> {
  const page = Math.max(1, Math.floor(Number(query?.page ?? 1)) || 1);
  const { data, headers } = await wooRequest<unknown>(opts, { path, query: { ...query, page } });
  if (!Array.isArray(data)) {
    throw new WooError("respuesta_invalida", "WooCommerce no devolvió una lista donde se esperaba una.");
  }
  return {
    items: data as T[],
    page,
    total: headerInt(headers, "x-wp-total"),
    totalPages: headerInt(headers, "x-wp-totalpages"),
  };
}

/**
 * Recorre las páginas de una colección, de la `page` pedida en adelante, hasta
 * la última (`X-WP-TotalPages`), una página vacía o `maxPages`. Si para por el
 * tope, la última página entregada dice en qué `page` quedó: quien llama decide
 * si sigue en la próxima pasada.
 */
export async function* wooPaginate<T>(
  opts: WooClientOpts,
  path: string,
  query: WooRequest["query"] = {},
  { maxPages = WOO_DEFAULT_MAX_PAGES }: { maxPages?: number } = {},
): AsyncGenerator<WooPage<T>> {
  let page = Math.max(1, Math.floor(Number(query?.page ?? 1)) || 1);
  for (let n = 0; n < maxPages; n++) {
    const result = await wooGetPage<T>(opts, path, { ...query, page });
    yield result;
    if (!result.items.length) return;
    if (result.totalPages != null && page >= result.totalPages) return;
    page++;
  }
}

/**
 * La fecha para `modified_after`/`after` con `dates_are_gmt=true`: ISO en UTC
 * sin zona ni milisegundos («2026-10-23T05:00:00»), que es como WooCommerce
 * compara contra `date_modified_gmt`. Null si no es una fecha.
 */
export function toWooGmtParam(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19);
}

/**
 * Una página de pedidos modificados después de `modifiedAfter` (la red de
 * seguridad de los webhooks): `status=any`, del más viejo al más nuevo por
 * modificación, con fechas en GMT. `status=any` no incluye la papelera.
 */
export async function fetchWooOrdersPage(
  opts: WooClientOpts,
  input: { modifiedAfter?: string | Date | null; page?: number; perPage?: number },
): Promise<WooPage<WooOrder>> {
  const perPage = Math.min(WOO_MAX_PER_PAGE, Math.max(1, Math.floor(input.perPage ?? WOO_MAX_PER_PAGE)));
  return wooGetPage<WooOrder>(opts, "/orders", {
    status: "any",
    orderby: "modified",
    order: "asc",
    dates_are_gmt: true,
    modified_after: toWooGmtParam(input.modifiedAfter ?? null),
    per_page: perPage,
    page: input.page ?? 1,
  });
}

/**
 * Una nota de pedido (REST v3, `GET /orders/<id>/notes`). WooCommerce escribe
 * una en cada cambio de estado («Estado del pedido cambiado de Procesando a
 * Cancelado.»): `author` es el nombre visible del usuario de WordPress que lo
 * hizo, o `system`/`WooCommerce` si lo hizo WooCommerce solo (un pedido sin pagar
 * que venció, un plugin). `added_by_user` no lo devuelven todas las versiones.
 */
export interface WooOrderNote {
  id?: number;
  author?: string;
  date_created?: string;
  date_created_gmt?: string;
  note?: string;
  customer_note?: boolean;
  added_by_user?: boolean;
}

/**
 * Tiempo límite de la lectura de notas (quién anuló, MOM §38.3). Corto: es un
 * dato de la Actividad, nunca frena ni tumba la entrada del pedido.
 */
export const WOO_NOTES_TIMEOUT_MS = 4_000;

/** Las notas internas de un pedido (sin las de la clienta), con el tiempo límite corto. */
export async function fetchWooOrderNotes(opts: WooClientOpts, wooId: number | string): Promise<WooOrderNote[]> {
  const id = String(wooId ?? "").trim();
  if (!/^[1-9]\d*$/.test(id)) throw new WooError("config", "Id de pedido de WooCommerce inválido.");
  const timeoutMs = Math.min(opts.timeoutMs ?? WOO_NOTES_TIMEOUT_MS, WOO_NOTES_TIMEOUT_MS);
  const { data } = await wooRequest<unknown>({ ...opts, timeoutMs }, { path: `/orders/${id}/notes`, query: { type: "internal" } });
  if (!Array.isArray(data)) {
    throw new WooError("respuesta_invalida", "WooCommerce no devolvió una lista de notas.");
  }
  return data.filter((n): n is WooOrderNote => Boolean(n) && typeof n === "object" && !Array.isArray(n));
}

/** Un pedido por su id de WooCommerce (no el `wc-…` de Kapta: usar `parseWooOrderId`). */
export async function fetchWooOrder(opts: WooClientOpts, wooId: number | string): Promise<WooOrder> {
  const id = String(wooId ?? "").trim();
  if (!/^[1-9]\d*$/.test(id)) throw new WooError("config", "Id de pedido de WooCommerce inválido.");
  const { data } = await wooRequest<WooOrder>(opts, { path: `/orders/${id}` });
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new WooError("respuesta_invalida", "WooCommerce no devolvió un pedido.");
  }
  return data;
}
