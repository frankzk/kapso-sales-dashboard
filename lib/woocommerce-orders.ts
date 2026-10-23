// Crear pedidos y buscar productos en WooCommerce desde Kapta (MOM §38.12,
// 23-10-2026): «Generar pedido» (y «Venta telefónica», que abre el mismo
// formulario) y los buscadores de productos, cuando la tienda crea sus pedidos
// nuevos en WooCommerce (`stores.platform = 'woocommerce'`, §38.1).
//
// Solo servidor: lee y descifra las claves de la tienda (lib/woocommerce-intake)
// y habla con su API REST. Nada de aquí viaja al navegador.
//
// LAS MISMAS GARANTÍAS QUE SHOPIFY. En Shopify la venta es un borrador que se
// completa recién cuando el precio guardado es el pactado (`priceMismatches`,
// lib/shopify.ts). WooCommerce no tiene borradores en su API, así que el
// borrador es un pedido `pending`, que Kapta no toma como pedido (§38.3):
//   1. se crea `pending`, contraentrega, con las líneas POR SKU y el precio
//      fijado en cada una (`subtotal` y `total`);
//   2. se compara lo que WooCommerce guardó (producto, precio de cada línea,
//      envío, total) con lo que pidió la asesora;
//   3. si no cuadra, se borra (`DELETE …?force=true`; o se anula, si un plugin
//      ya lo dejó vivo) y la venta se rechaza con el mismo texto que en
//      Shopify; si cuadra, pasa a `processing`, y desde ahí es un pedido vivo
//      que entra al Master.
// Un pedido a medio hacer nunca entra al Master: el webhook y la pasada saltan
// los `pending`. Y nunca se borra un pedido sin haberlo visto `pending`: si no
// se sabe cómo quedó, se deja y el reintento lo resuelve.
//
// UN REINTENTO NO CREA OTRO PEDIDO. Cada intento del formulario lleva su id
// (`kapta_request_id`) y la huella de lo que pidió (`kapta_request_hash`),
// metadatos del pedido. Antes de crear se buscan los pedidos de las últimas 2
// horas con ese id: si hay uno y el formulario sigue diciendo lo mismo, se usa
// ese (vivo) o se retoma (`pending`); si el formulario cambió, uno vivo NO se
// registra con lo de ahora (se avisa) y uno `pending` se borra antes de crear
// el nuevo. Ver `createWooSaleOrder`.
//
// SIN SECRETOS NI DATOS DE LA CLIENTA EN LOS REGISTROS. Lo que se registra
// lleva el id de WooCommerce y el resultado, nunca el teléfono, la dirección
// ni las claves.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  WOO_CANCELLED_STATUSES,
  WOO_META,
  WooError,
  fetchWooOrder,
  isWooOrderIngestible,
  toWooGmtParam,
  toWooPeruState,
  wooRequest,
  type WooClientOpts,
  type WooOrder,
} from "@/lib/woocommerce";
import {
  hasWooApiCredentials,
  loadWooStoreCreds,
  withWooAuthFallback,
  type WooStoreCreds,
} from "@/lib/woocommerce-intake";
import { isWooMigrationMissing } from "@/lib/woocommerce-settings";
import type { CatalogVariant, PriceMismatch, ProductSearchResult, ProductVariantResult } from "@/lib/shopify";

// ---------------------------------------------------------------------------
// La plataforma de la tienda (`stores.platform`, §38.1)
// ---------------------------------------------------------------------------

/** Las claves de WooCommerce de una tienda, completas y descifradas. Solo servidor. */
export type WooApiCreds = WooStoreCreds & {
  siteUrl: string;
  siteKey: string;
  consumerKey: string;
  consumerSecret: string;
};

export type StoreOrderPlatform =
  | { ok: true; platform: "shopify" }
  | { ok: true; platform: "woocommerce"; creds: WooApiCreds }
  | { ok: false; error: string };

/**
 * Dónde crea Kapta los pedidos nuevos de la tienda. Lee `stores.platform` y, si
 * es `woocommerce`, las claves (descifradas aquí, nunca hacia el navegador).
 *
 *   · `shopify` (todas las tiendas hasta que el owner cambie una): el camino de
 *     Shopify de siempre, sin ninguna llamada a WooCommerce. También sin la
 *     0274 (la columna no existe): toda tienda era de Shopify.
 *   · `woocommerce` con las claves completas: WooCommerce.
 *   · `woocommerce` sin poder descifrar las claves, o la tienda no se pudo
 *     leer: error. Nunca se cae a Shopify en silencio: después del cierre, un
 *     pedido mandado a Shopify es una venta perdida.
 */
export async function loadStoreOrderPlatform(admin: SupabaseClient, storeId: string): Promise<StoreOrderPlatform> {
  const { creds, error } = await loadWooStoreCreds(admin, storeId);
  if (error) {
    if (isWooMigrationMissing({ message: error })) return { ok: true, platform: "shopify" };
    return { ok: false, error: "No se pudo leer la tienda. Intenta de nuevo en unos segundos." };
  }
  if (!creds) return { ok: false, error: "No se encontró la tienda." };
  if (creds.platform !== "woocommerce") return { ok: true, platform: "shopify" };
  if (!hasWooApiCredentials(creds)) {
    return {
      ok: false,
      error:
        "La tienda crea sus pedidos en WooCommerce, pero sus claves de la API no se pueden usar. Revísalas en Ajustes → WooCommerce.",
    };
  }
  return { ok: true, platform: "woocommerce", creds };
}

// ---------------------------------------------------------------------------
// Productos: la identidad de una variante de WooCommerce en el formulario
// ---------------------------------------------------------------------------

/**
 * Prefijo de los ids de producto y de variante que devuelve el buscador de
 * WooCommerce (`woo:1532`). El formulario solo los usa como llave y como marca
 * de «producto del catálogo»; el pedido se crea por SKU. Con el prefijo, un id
 * de WooCommerce nunca se confunde con uno de Shopify (un `gid://shopify/…` o
 * un número suelto) ni viaja a Shopify (`generateOrder` lo rechaza).
 */
export const WOO_VARIANT_REF_PREFIX = "woo:";

/** `woo:<id>`: el id de la variación, o el del producto si es simple. */
export function wooVariantRef(id: number | string): string {
  return `${WOO_VARIANT_REF_PREFIX}${String(id).trim()}`;
}

/** El id de WooCommerce de un `woo:<id>`, o null si no es uno. */
export function parseWooVariantRef(value: unknown): number | null {
  if (typeof value !== "string" || !value.startsWith(WOO_VARIANT_REF_PREFIX)) return null;
  const id = value.slice(WOO_VARIANT_REF_PREFIX.length);
  return /^[1-9]\d{0,18}$/.test(id) ? Number(id) : null;
}

export function isWooVariantRef(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(WOO_VARIANT_REF_PREFIX);
}

// ---------------------------------------------------------------------------
// El pedido que se manda
// ---------------------------------------------------------------------------

/** `payment_method` de la contraentrega de WooCommerce (la única que crea Kapta). */
export const WOO_COD_METHOD = "cod";
/**
 * `payment_method_title`: el título por defecto de la pasarela contraentrega de
 * WooCommerce («Cash on delivery», `WC_Gateway_COD`). La API no lo pone sola al
 * mandar `payment_method`. Kapta lee `payment_method`, nunca este texto (§38.4).
 */
export const WOO_COD_TITLE = "Cash on delivery";
/**
 * `created_via`. OJO: el esquema de la API REST lo declara de solo lectura y
 * WooCommerce guarda `rest-api`. Se manda igual por si una versión lo acepta,
 * pero Kapta no depende de él: lo que marca el pedido es `kapta_channel`.
 */
export const WOO_KAPTA_CREATED_VIA = "kapta";
/**
 * El canal de la venta de una asesora (§38.5): `venta_manual`, la misma
 * etiqueta que lleva hoy el pedido de «Generar pedido» en Shopify.
 */
export const WOO_SALE_CHANNEL = "venta_manual";
/**
 * El canal de la venta que cierra el carrito abierto del lead («Carrito
 * recuperado»): `web_carrito`, «Web · carrito completado». En Shopify el
 * borrador reusado conservaba las etiquetas de EasySell y caía en ese canal;
 * el owner pidió lo mismo en WooCommerce (23-10-2026). La venta de la asesora
 * queda en `order_sales` igual.
 */
export const WOO_CART_SALE_CHANNEL = "web_carrito";
/**
 * El envío: Kapta no cobra envío en «Generar pedido» (el total es productos
 * menos descuento, como en Shopify). Va como método de envío a S/ 0, nunca
 * como cargo (`fee_lines`), que es lo que pide el brief a la tienda.
 */
export const WOO_FREE_SHIPPING = { method_id: "free_shipping", method_title: "Envío gratis" } as const;

/** Una línea del formulario, como llega a `generateOrder`. */
export interface WooSaleLine {
  title: string;
  quantity: number;
  /** Precio unitario pactado, ya redondeado a céntimos. Null: el de catálogo. */
  unitPrice: number | null;
  sku: string | null;
  /** `woo:<id>` si viene del buscador de WooCommerce; otra cosa si no. */
  variantId: string | null;
}

/**
 * ¿Hay líneas que WooCommerce no puede crear, o que crearía sin que Kapta
 * pueda comprobar su precio? Se frenan aquí, antes de llamar a WooCommerce.
 * Devuelve el mensaje para la asesora, o null.
 *
 *   · Sin SKU. Toda línea va por SKU: la API rechaza una sin SKU ni producto,
 *     y una con SKU desconocido la crea SIN producto
 *     (WC_REST_Orders_V2_Controller::prepare_line_items). Un ítem manual, una
 *     línea traída de Shopify sin SKU, o una variación de WooCommerce sin SKU
 *     propio (por el SKU que muestra, el del padre, se crearía el producto con
 *     variaciones), cada una con su mensaje.
 *   · Sin precio. Un producto de WooCommerce puede no tener precio (Shopify
 *     siempre lo tiene): el formulario lo muestra a 0.00, pero sin `subtotal`
 *     ni `total` WooCommerce cobraría el de su catálogo y Kapta no tendría con
 *     qué compararlo. Un regalo es un precio de 0, no la falta de precio.
 *   · Precio negativo: WooCommerce lo aceptaría sin decir nada.
 */
export function wooSaleLinesProblem(lines: readonly WooSaleLine[]): string | null {
  const manual: string[] = [];
  const shopify: string[] = [];
  const sinSkuPropio: string[] = [];
  const sinPrecio: string[] = [];
  const negativo: string[] = [];
  for (const li of lines) {
    const title = `«${(li.title ?? "").trim() || "Ítem manual"}»`;
    if (!(li.sku ?? "").trim()) {
      const ref = li.variantId ?? "";
      if (ref.startsWith("gid://shopify/")) shopify.push(title);
      else if (isWooVariantRef(ref)) sinSkuPropio.push(title);
      else manual.push(title);
      continue;
    }
    if (li.unitPrice == null) sinPrecio.push(title);
    else if (!Number.isFinite(li.unitPrice) || li.unitPrice < 0) negativo.push(title);
  }
  const parts: string[] = [];
  if (manual.length) {
    parts.push(
      `${manual.join(", ")} ${manual.length === 1 ? "es un ítem manual" : "son ítems manuales"}: WooCommerce no crea productos sin SKU.`,
    );
  }
  if (shopify.length) {
    parts.push(`${shopify.join(", ")} ${shopify.length === 1 ? "viene" : "vienen"} del catálogo de Shopify sin SKU.`);
  }
  if (manual.length || shopify.length) parts.push("Quítalos y agrégalos desde «Producto del catálogo».");
  if (sinSkuPropio.length) {
    const una = sinSkuPropio.length === 1;
    parts.push(
      `${sinSkuPropio.join(", ")} no ${una ? "tiene" : "tienen"} SKU propio en WooCommerce: ${una ? "es una variación que muestra" : "son variaciones que muestran"} el SKU del producto, y por ese SKU se crearía el producto con variaciones. Pide al administrador que le ponga su SKU (el mismo que en Shopify).`,
    );
  }
  if (sinPrecio.length) {
    const una = sinPrecio.length === 1;
    parts.push(
      `${sinPrecio.join(", ")} no ${una ? "tiene" : "tienen"} precio: sin uno fijado, WooCommerce cobraría el de su catálogo sin que Kapta lo compruebe. Pide al administrador que le ponga precio en WooCommerce.`,
    );
  }
  if (negativo.length) {
    parts.push(`${negativo.join(", ")} ${negativo.length === 1 ? "tiene" : "tienen"} un precio negativo o no válido.`);
  }
  return parts.length ? `Pedido NO generado: ${parts.join(" ")}` : null;
}

function cents(n: number): number {
  return Math.round((n + Number.EPSILON) * 100);
}

function moneyText(c: number): string {
  return (c / 100).toFixed(2);
}

/**
 * El precio de cada línea en céntimos: `subtotal` (precio pactado × cantidad) y
 * `total` (con su parte del descuento del pedido). El descuento de la asesora
 * es UNO para todo el pedido (`resolveOrderDiscount`); WooCommerce no tiene
 * descuento de pedido sin cupón, así que se reparte entre las líneas con
 * precio, en proporción a su subtotal y al céntimo (método del mayor resto):
 * la suma de los `total` es exactamente el total pactado. Un regalo (S/ 0) no
 * lleva descuento. Una línea sin precio queda en null y sin descuento; la
 * venta no llega con ella (`wooSaleLinesProblem` la frena y
 * `createWooSaleOrder` no la manda).
 */
export function wooLineCents(
  lines: readonly Pick<WooSaleLine, "unitPrice" | "quantity">[],
  discountAmount: number,
): { subtotal: number | null; total: number | null }[] {
  const subs = lines.map((li) => (li.unitPrice == null ? null : cents(li.unitPrice) * Math.max(1, Math.floor(li.quantity))));
  const base = subs.reduce<number>((s, c) => s + (c ?? 0), 0);
  const discount = Math.min(base, Math.max(0, cents(discountAmount || 0)));
  const shares = subs.map(() => 0);
  if (discount > 0 && base > 0) {
    const exact = subs.map((c) => ((c ?? 0) * discount) / base);
    let given = 0;
    exact.forEach((x, i) => {
      shares[i] = Math.floor(x);
      given += shares[i]!;
    });
    // El resto (menos de un céntimo por línea) va de a un céntimo a las de
    // mayor parte decimal. Nunca pasa del subtotal de la línea: el descuento
    // es menor que la suma (el total es > 0), y el tope de vueltas es la red.
    const order = exact
      .map((x, i) => ({ i, frac: x - Math.floor(x) }))
      .filter(({ i }) => (subs[i] ?? 0) > 0)
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; given < discount && k < order.length * 2; k++) {
      const { i } = order[k % order.length]!;
      if (shares[i]! < (subs[i] ?? 0)) {
        shares[i] = shares[i]! + 1;
        given += 1;
      }
    }
  }
  return subs.map((c, i) => (c == null ? { subtotal: null, total: null } : { subtotal: c, total: c - shares[i]! }));
}

/** Lo que la asesora pidió, para compararlo con lo que guarda WooCommerce. */
export interface WooSaleExpectation {
  lines: {
    title: string;
    sku: string;
    /** El id de WooCommerce del buscador (`woo:<id>`), si lo hay. */
    wooId: number | null;
    quantity: number;
    unitPrice: number | null;
    subtotal: number | null;
    total: number | null;
  }[];
  shipping: number;
  /** El total del pedido; null si alguna línea va sin precio. */
  total: number | null;
  /** El lead de la venta (`kapta_lead_id`). */
  leadId: string;
  /**
   * La huella de lo pedido (`kapta_request_hash`, `wooSaleFingerprint`): con
   * ella un reintento sabe si el pedido de un intento anterior se hizo con lo
   * que dice el formulario ahora.
   */
  fingerprint: string;
}

export interface WooSaleInput {
  leadId: string;
  requestId: string;
  /**
   * `web_carrito` si la venta cierra el carrito abierto del lead; si no (o sin
   * decir), `venta_manual`.
   */
  channel?: typeof WOO_SALE_CHANNEL | typeof WOO_CART_SALE_CHANNEL;
  lines: readonly WooSaleLine[];
  /** El descuento del pedido ya resuelto (`resolveOrderDiscount`), en soles. */
  discountAmount: number;
  address: {
    name: string | null;
    /** Ya normalizado (`normalizePhone`): dígitos con el 51. */
    phone: string | null;
    address1: string;
    /** La referencia. */
    address2: string | null;
    /** El distrito. */
    city: string;
    /** El departamento como lo escribe el formulario («Lima», «Callao»…). */
    province: string | null;
  };
  note: string | null;
}

/**
 * La huella de un pedido: el sha256 de todo lo que se manda (productos,
 * cantidades, precios fijados, envío, facturación y envío, nota) más el lead,
 * sin los metadatos. PURA y determinista: el mismo formulario da la misma
 * huella en cada reintento; cualquier cambio (una unidad más, otro descuento,
 * otra dirección u otra nota) da otra.
 */
export function wooSaleFingerprint(body: Record<string, unknown>, leadId: string): string {
  const { meta_data: _meta, ...rest } = body;
  return createHash("sha256").update(JSON.stringify({ lead: leadId, ...rest })).digest("hex");
}

function splitName(name: string | null): { first: string; last: string } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

/**
 * El cuerpo de `POST /wp-json/wc/v3/orders` y lo que se espera de vuelta. PURA.
 *
 * Facturación y envío van completos e IGUALES (el brief: la de envío es una
 * copia de la de facturación o va vacía): nombre y apellido, el celular en
 * `phone` (E.164), la calle, la referencia en `address_2`, el distrito en
 * `city`, el departamento con el código de WooCommerce (`toWooPeruState`:
 * «Lima» → LMA, «Lima (departamento)» → LIM, «Callao» → CAL; uno que no se
 * reconoce va tal cual, como en Shopify) y `PE`. La API rechaza null en esos
 * campos: lo que falta va vacío.
 */
export function buildWooSaleOrder(input: WooSaleInput): { body: Record<string, unknown>; expected: WooSaleExpectation } {
  const priced = wooLineCents(input.lines, input.discountAmount);
  const lineItems = input.lines.map((li, i) => {
    const item: Record<string, unknown> = {
      sku: (li.sku ?? "").trim(),
      quantity: Math.max(1, Math.floor(li.quantity)),
    };
    const p = priced[i]!;
    // `unitPrice === 0` es un regalo REAL: se compara contra null, no contra falsy.
    if (p.subtotal != null && p.total != null) {
      item.subtotal = moneyText(p.subtotal);
      item.total = moneyText(p.total);
    }
    return item;
  });

  const { first, last } = splitName(input.address.name);
  const province = (input.address.province ?? "").trim();
  const state = province ? (toWooPeruState(province) ?? province) : "";
  const phone = input.address.phone ? `+${input.address.phone.replace(/\D+/g, "")}` : "";
  const address = {
    first_name: first,
    last_name: last,
    address_1: input.address.address1,
    address_2: input.address.address2 ?? "",
    city: input.address.city,
    state,
    country: "PE",
    phone,
  };

  const body: Record<string, unknown> = {
    status: "pending",
    set_paid: false,
    created_via: WOO_KAPTA_CREATED_VIA,
    payment_method: WOO_COD_METHOD,
    payment_method_title: WOO_COD_TITLE,
    billing: { ...address },
    shipping: { ...address },
    line_items: lineItems,
    shipping_lines: [{ ...WOO_FREE_SHIPPING, total: "0.00" }],
  };
  const note = (input.note ?? "").trim();
  if (note) body.customer_note = note;
  const fingerprint = wooSaleFingerprint(body, input.leadId);
  body.meta_data = [
    { key: WOO_META.channel, value: input.channel ?? WOO_SALE_CHANNEL },
    { key: WOO_META.leadId, value: input.leadId },
    { key: WOO_META.requestId, value: input.requestId },
    { key: WOO_META.requestHash, value: fingerprint },
  ];

  const allPriced = priced.every((p) => p.total != null);
  const expected: WooSaleExpectation = {
    lines: input.lines.map((li, i) => ({
      title: (li.title ?? "").trim() || (li.sku ?? ""),
      sku: (li.sku ?? "").trim(),
      wooId: parseWooVariantRef(li.variantId),
      quantity: Math.max(1, Math.floor(li.quantity)),
      unitPrice: li.unitPrice,
      subtotal: priced[i]!.subtotal == null ? null : priced[i]!.subtotal! / 100,
      total: priced[i]!.total == null ? null : priced[i]!.total! / 100,
    })),
    shipping: 0,
    total: allPriced ? priced.reduce((s, p) => s + (p.total ?? 0), 0) / 100 : null,
    leadId: input.leadId,
    fingerprint,
  };
  return { body, expected };
}

// ---------------------------------------------------------------------------
// La comparación: lo que guardó WooCommerce contra lo pedido
// ---------------------------------------------------------------------------

/** Una línea que WooCommerce no guardó como se pidió: otro producto, ninguno, o otra cantidad. */
export interface WooLineProblem {
  title: string;
  sku: string;
  motivo: "no_existe" | "otro_producto" | "variable" | "sin_linea" | "cantidad";
  /** Solo `cantidad`: las unidades pedidas y las que guardó WooCommerce. */
  pedido?: number;
  guardado?: number;
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}

/** Céntimo de tolerancia, como `priceMismatches`: WooCommerce devuelve cadenas. */
const DIFF = 0.005;

/**
 * Lo pedido contra lo que WooCommerce guardó. PURA. Se emparejan las líneas
 * por POSICIÓN, que es como WooCommerce las devuelve (por id de línea, en el
 * orden en que se crearon), igual que `priceMismatches` en Shopify.
 *
 *   · `lineas`: la línea no quedó con un producto (SKU que no existe), quedó
 *     con otro que el elegido en el buscador (un SKU repetido, o el de un
 *     producto variable sin SKU propio en la variación), o, sin elección del
 *     buscador (un carrito, un producto de Shopify), quedó con un producto con
 *     variaciones y sin variación (`variableIds`: los productos de esas líneas
 *     que WooCommerce dice que son variables, `wooLinesToVerify`), o quedó con
 *     otra cantidad.
 *   · `desajustes` (con la forma de `PriceMismatch`): el precio unitario
 *     (`subtotal` ÷ cantidad), el total de la línea con su descuento, el envío
 *     (S/ 0), cargos e impuestos (ninguno) y el total del pedido.
 */
export function wooSaleMismatches(
  expected: WooSaleExpectation,
  order: Pick<WooOrder, "line_items" | "shipping_total" | "fee_lines" | "total" | "total_tax">,
  variableIds: ReadonlySet<number> = new Set(),
): { lineas: WooLineProblem[]; desajustes: PriceMismatch[] } {
  const lineas: WooLineProblem[] = [];
  const desajustes: PriceMismatch[] = [];
  const got = Array.isArray(order.line_items) ? order.line_items : [];
  expected.lines.forEach((exp, i) => {
    const li = got[i];
    if (!li) {
      lineas.push({ title: exp.title, sku: exp.sku, motivo: "sin_linea" });
      return;
    }
    const productId = num(li.product_id) ?? 0;
    const variationId = num(li.variation_id) ?? 0;
    if (productId <= 0) {
      lineas.push({ title: exp.title, sku: exp.sku, motivo: "no_existe" });
      return;
    }
    const resolved = variationId > 0 ? variationId : productId;
    const sku = String(li.sku ?? "").trim().toLowerCase();
    if ((exp.wooId != null && resolved !== exp.wooId) || sku !== exp.sku.toLowerCase()) {
      lineas.push({ title: exp.title, sku: exp.sku, motivo: "otro_producto" });
      return;
    }
    if (exp.wooId == null && variationId <= 0 && variableIds.has(productId)) {
      lineas.push({ title: exp.title, sku: exp.sku, motivo: "variable" });
      return;
    }
    const qty = num(li.quantity) ?? 0;
    if (qty !== exp.quantity) {
      lineas.push({ title: exp.title, sku: exp.sku, motivo: "cantidad", pedido: exp.quantity, guardado: qty });
      return;
    }
    const subtotal = num(li.subtotal);
    if (exp.subtotal != null && exp.unitPrice != null) {
      if (subtotal == null || Math.abs(subtotal - exp.subtotal) > DIFF) {
        desajustes.push({ title: exp.title, pedido: exp.unitPrice, aplicado: subtotal == null || !qty ? null : subtotal / qty });
        return;
      }
    }
    const total = num(li.total);
    if (exp.total != null && (total == null || Math.abs(total - exp.total) > DIFF)) {
      desajustes.push({ title: `${exp.title} (con descuento)`, pedido: exp.total, aplicado: total });
    }
  });
  if (got.length > expected.lines.length) {
    for (const li of got.slice(expected.lines.length)) {
      desajustes.push({ title: String(li?.name ?? "Línea de más"), pedido: 0, aplicado: num(li?.total) });
    }
  }

  const shipping = num(order.shipping_total) ?? 0;
  if (Math.abs(shipping - expected.shipping) > DIFF) {
    desajustes.push({ title: "Envío", pedido: expected.shipping, aplicado: shipping });
  }
  for (const fee of order.fee_lines ?? []) {
    const t = num(fee?.total) ?? 0;
    if (Math.abs(t) > DIFF) desajustes.push({ title: String(fee?.name ?? "").trim() || "Cargo", pedido: 0, aplicado: t });
  }
  const tax = num(order.total_tax) ?? 0;
  if (Math.abs(tax) > DIFF) desajustes.push({ title: "Impuestos", pedido: 0, aplicado: tax });
  // El total solo si nada de lo anterior lo explica: es la red de lo que no se
  // previó (un plugin que suma algo al guardar).
  if (!lineas.length && !desajustes.length && expected.total != null) {
    const total = num(order.total);
    if (total == null || Math.abs(total - expected.total) > DIFF) {
      desajustes.push({ title: "Total del pedido", pedido: expected.total, aplicado: total });
    }
  }
  return { lineas, desajustes };
}

/**
 * Los productos que hay que mirar antes de dar por buena una línea: los de las
 * líneas que llegaron SIN la elección del buscador (`wooId` null: un carrito
 * de Shopify, un producto elegido antes del cambio de plataforma) y quedaron
 * sin variación. Si ese producto es variable, el SKU era el del padre y la
 * línea no es la talla o el color que se vendió. PURA.
 */
export function wooLinesToVerify(
  expected: Pick<WooSaleExpectation, "lines">,
  order: Pick<WooOrder, "line_items">,
): number[] {
  const got = Array.isArray(order.line_items) ? order.line_items : [];
  const ids = new Set<number>();
  expected.lines.forEach((exp, i) => {
    const li = got[i];
    if (!li || exp.wooId != null) return;
    const productId = num(li.product_id) ?? 0;
    if (productId > 0 && (num(li.variation_id) ?? 0) <= 0) ids.add(productId);
  });
  return [...ids];
}

/**
 * Qué se hizo con el pedido cuya venta se rechazó: si seguía `pending` se
 * borra (`deleted`, o `delete_failed`); si un plugin ya lo había dejado vivo
 * (stock descontado, quizá ya en el Master), se anula (`cancelled`, que
 * devuelve el stock, o `cancel_failed`).
 */
export type WooSaleCleanup = "deleted" | "delete_failed" | "cancelled" | "cancel_failed";

/**
 * Lo que queda dicho en un error (además de `WooSaleCleanup`):
 *   · `kept_pending`: el pedido sigue `pending` y se deja así: el reintento
 *     desde el mismo formulario lo retoma (no crea otro);
 *   · `unknown`: no se pudo ver cómo quedó; no se tocó, y el reintento desde el
 *     mismo formulario lo resuelve.
 */
export type WooSaleErrorCleanup = WooSaleCleanup | "kept_pending" | "unknown";

/** Qué pasó con el pedido, en una frase para la asesora y para el lead. PURA. */
export function wooCleanupText(cleanup: WooSaleErrorCleanup, orderLabel: string | null): string {
  const pedido = orderLabel ? `el pedido ${orderLabel}` : "el pedido";
  const Pedido = orderLabel ? `El pedido ${orderLabel}` : "El pedido";
  switch (cleanup) {
    case "deleted":
      return `${Pedido} (pendiente de pago) se eliminó.`;
    case "delete_failed":
      return `No se pudo eliminar ${pedido} (pendiente de pago): bórralo en WooCommerce. Kapta no lo toma mientras siga pendiente.`;
    case "cancelled":
      return `${Pedido} ya figuraba como vivo en WooCommerce (lo movió un plugin) y se anuló.`;
    case "cancel_failed":
      return `${Pedido} ya figuraba como vivo en WooCommerce (lo movió un plugin) y no se pudo anular: anúlalo en WooCommerce.`;
    case "kept_pending":
      return `${Pedido} quedó «Pendiente de pago», que Kapta no toma. No cierres este formulario: vuelve a pulsar «Generar pedido» y Kapta retoma ese mismo pedido, no crea otro.`;
    case "unknown":
      return `No se pudo ver cómo quedó ${pedido}. No cierres este formulario: vuelve a pulsar «Generar pedido» en unos segundos; Kapta lo busca por este intento y no crea otro.`;
  }
}

function unidades(n: number | undefined): string {
  return `${n ?? 0} ${n === 1 ? "unidad" : "unidades"}`;
}

/** Una línea con problema, en palabras. */
function lineProblemText(p: WooLineProblem): string {
  const what = `«${p.title}» (SKU ${p.sku})`;
  if (p.motivo === "otro_producto") return `${what}: ese SKU es de otro producto en WooCommerce`;
  if (p.motivo === "variable") return `${what}: ese SKU es el del producto con variaciones, no el de una variación`;
  if (p.motivo === "sin_linea") return `${what}: WooCommerce no guardó la línea`;
  if (p.motivo === "cantidad") return `${what}: WooCommerce guardó ${unidades(p.guardado)} en vez de ${unidades(p.pedido)}`;
  return `${what}: no existe en WooCommerce`;
}

/**
 * El rechazo de una venta cuyas líneas WooCommerce no resolvió al producto
 * pedido. PURA. Como `priceMismatchRejection`: el error para la asesora y la
 * nota para el historial del lead, con el producto, el SKU y qué pasó con el
 * pedido (`wooCleanupText`).
 */
export function wooLineRejection(input: {
  problemas: readonly WooLineProblem[];
  orderLabel: string | null;
  cleanup: WooSaleCleanup;
}): { error: string; note: string } {
  const detalle = input.problemas.map(lineProblemText).join("; ");
  const limpieza = wooCleanupText(input.cleanup, input.orderLabel);
  const causa = input.problemas.some((p) => p.motivo === "cantidad")
    ? `WooCommerce no guardó lo pedido: ${detalle}.`
    : `WooCommerce no encontró el producto pedido: ${detalle}.`;
  return {
    error:
      `Pedido NO generado: ${causa} ${limpieza} Vuelve a elegir el producto desde el catálogo; ` +
      `si se repite, avisa al administrador: el SKU tiene que ser el mismo que en Shopify.`,
    note: `⛔ Venta NO generada · ${causa} ${limpieza}`,
  };
}

/**
 * Un reintento encontró VIVO el pedido de un intento anterior de este mismo
 * formulario, pero el formulario ya no dice lo mismo (otra cantidad, otro
 * producto, otro descuento, otra dirección u otra nota), o WooCommerce guarda
 * otros precios que los pactados. Ese pedido no se registra como la venta de
 * ahora, ni se borra: es un pedido real. PURA: el error y la nota del lead.
 */
export function wooConflictRejection(input: {
  orderLabel: string | null;
  lineas: readonly WooLineProblem[];
  desajustes: readonly PriceMismatch[];
  currency: string;
}): { error: string; note: string } {
  const money = (n: number | null) => (n == null ? "sin precio" : `${input.currency} ${n.toFixed(2)}`);
  const diferencias = [
    ...input.lineas.map((p) =>
      p.motivo === "cantidad"
        ? `«${p.title}» (ahora ${unidades(p.pedido)}, en WooCommerce ${unidades(p.guardado)})`
        : lineProblemText(p),
    ),
    ...input.desajustes.map((d) => `«${d.title}» (ahora ${money(d.pedido)}, en WooCommerce ${money(d.aplicado)})`),
  ];
  const detalle = diferencias.length
    ? `: ${diferencias.join("; ")}`
    : " (la dirección, la nota, el descuento o los productos)";
  const pedido = input.orderLabel ? `el pedido ${input.orderLabel}` : "un pedido";
  const causa = `Este formulario ya creó ${pedido} en WooCommerce, y está vivo, pero con otros datos que los de ahora${detalle}.`;
  return {
    error:
      `Pedido NO registrado: ${causa} Kapta no lo registra como esta venta ni crea otro. ` +
      `Si ese pedido es el correcto, deja el formulario como estaba y vuelve a pulsar «Generar pedido». ` +
      `Si no, anúlalo en WooCommerce y vuelve a pulsar «Generar pedido»: se crea uno nuevo con lo de ahora.`,
    note: `⛔ Venta NO registrada · ${causa}`,
  };
}

// ---------------------------------------------------------------------------
// La creación: lookup → POST pending → comparación → PUT processing
// ---------------------------------------------------------------------------

/**
 * Tope de cada llamada. Ninguna espera más que esto, y ninguna pasa del reloj
 * de toda la venta (`WOO_SALE_BUDGET_MS`).
 */
export const WOO_SALE_TIMEOUTS = {
  /** Buscar el intento anterior, y leer el pedido que se encontró. */
  lookup: 6_000,
  /** El POST: lo más pesado que hace WooCommerce (numeración, stock, ganchos). */
  create: 15_000,
  /** ¿Es variable el producto de una línea que llegó sin la elección del buscador? */
  verify: 5_000,
  /** El PUT a `processing`. */
  update: 10_000,
  /** Releer, borrar o anular un pedido que no se va a usar. */
  cleanup: 5_000,
} as const;
export type WooSaleTimeouts = { [K in keyof typeof WOO_SALE_TIMEOUTS]: number };

/**
 * El reloj de toda la venta. La acción nunca deja a la asesora en
 * «Generando…»: con todas las llamadas al límite (buscar, leer y borrar un
 * intento anterior, crear, comprobar, pasar a `processing`, releer y borrar)
 * se pasaría de los 50 s, así que cada llamada espera como mucho lo que le
 * queda a este reloj, y lo que no alcanza se deja para el reintento (que lo
 * resuelve sin crear otro pedido). La página de Leads da 300 s a la función
 * (`maxDuration`, app/dashboard/leads/page.tsx): sobra margen.
 */
export const WOO_SALE_BUDGET_MS = 45_000;
/** Menos que esto no alcanza para una llamada: se da por agotado el reloj. */
const WOO_SALE_MIN_CALL_MS = 1_000;

/**
 * Hasta dónde se busca el intento anterior (por fecha de creación). Kenku crea
 * unos 10 pedidos por hora: 2 horas caben en una página de 100.
 */
export const WOO_SALE_LOOKBACK_MS = 2 * 60 * 60_000;

/** El id del intento: el que manda el formulario, o null si no tiene forma. */
export function normalizeWooRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : null;
}

function metaValue(order: Pick<WooOrder, "meta_data">, key: string): string | null {
  for (const m of order.meta_data ?? []) {
    if (!m || typeof m.key !== "string") continue;
    if (m.key.trim().toLowerCase().replace(/^_/, "") === key) {
      return m.value == null ? null : String(m.value);
    }
  }
  return null;
}

function statusOf(order: Pick<WooOrder, "status"> | null | undefined): string {
  return String(order?.status ?? "")
    .trim()
    .toLowerCase()
    .replace(/^wc-/, "");
}

/** ¿Anulado o reembolsado? Un intento anterior así no se toca: se crea otro. */
function isClosedWooOrder(order: Pick<WooOrder, "status"> | null | undefined): boolean {
  const status = statusOf(order);
  return WOO_CANCELLED_STATUSES.includes(status) || status === "refunded";
}

/** ¿Es un pedido vivo (entra al Master y no está anulado)? */
export function isLiveWooOrder(order: Pick<WooOrder, "status"> | null | undefined): boolean {
  return isWooOrderIngestible(order) && !isClosedWooOrder(order);
}

/**
 * El pedido de un intento anterior con el mismo `kapta_request_id`, o null.
 *
 * La API de WooCommerce no filtra por metadatos, así que se piden los pedidos
 * CREADOS en las últimas 2 horas (`after`, en GMT), los más nuevos primero, con
 * solo `id`, `status`, `number` y `meta_data` (`_fields`), y se busca aquí.
 * `status=any` incluye `pending` y los estados de plugins; no la papelera.
 */
export async function findWooOrderByRequestId(
  opts: WooClientOpts,
  requestId: string,
  now: number = Date.now(),
): Promise<Pick<WooOrder, "id" | "status" | "number" | "meta_data"> | null> {
  const { data } = await wooRequest<unknown>(opts, {
    path: "/orders",
    query: {
      status: "any",
      after: toWooGmtParam(new Date(now - WOO_SALE_LOOKBACK_MS)),
      dates_are_gmt: true,
      orderby: "date",
      order: "desc",
      per_page: 100,
      _fields: "id,status,number,meta_data",
    },
  });
  if (!Array.isArray(data)) throw new WooError("respuesta_invalida", "WooCommerce no devolvió una lista donde se esperaba una.");
  for (const o of data as WooOrder[]) {
    if (o && metaValue(o, WOO_META.requestId) === requestId) return o;
  }
  return null;
}

export type WooSaleOutcome =
  /** Creado (o retomado de un intento anterior pendiente) y ya `processing`. */
  | { kind: "created"; order: WooOrder }
  /** Ya existía vivo, de un intento anterior con lo mismo que pide el formulario ahora: no se creó otro. */
  | { kind: "adopted"; order: WooOrder }
  /** Ya existía vivo, de un intento anterior, pero con otra cosa: no se registra ni se crea otro. */
  | { kind: "conflict"; order: WooOrder; orderLabel: string | null; lineas: WooLineProblem[]; desajustes: PriceMismatch[] }
  | { kind: "price"; desajustes: PriceMismatch[]; cleanup: WooSaleCleanup; orderLabel: string | null }
  | { kind: "lines"; problemas: WooLineProblem[]; cleanup: WooSaleCleanup; orderLabel: string | null }
  | { kind: "error"; message: string; cleanup: WooSaleErrorCleanup | null; orderLabel: string | null };

export interface WooSaleLog {
  (event: string, data: Record<string, unknown>): void;
}

const defaultLog: WooSaleLog = (event, data) => {
  const line = `[woo-sale] ${JSON.stringify({ event, ...data })}`;
  if (event.endsWith("_failed") || event.endsWith("conflict")) console.error(line);
  else console.info(line);
};

function errorText(e: unknown): string {
  if (e instanceof WooError) return e.message;
  return "error desconocido";
}

/**
 * Un fallo después del cual el pedido PUDO haberse creado: WooCommerce no
 * contestó, se cortó la red o falló a mitad (5xx, una respuesta rota). Un
 * rechazo (4xx) no crea nada.
 */
function mayHaveCreated(e: unknown): boolean {
  return e instanceof WooError && (e.kind === "tiempo" || e.kind === "red" || e.kind === "servidor" || e.kind === "respuesta_invalida");
}

/**
 * Un fallo que es una RESPUESTA de WooCommerce: lo que se pidió terminó ahí
 * (un 4xx, o un 500 de PHP). No lo es un corte (`tiempo`, `red`), ni un
 * 502/503/504 de un proxy o un CDN, detrás del cual WordPress puede seguir
 * trabajando, ni una respuesta rota.
 */
function isAnsweredFailure(e: unknown): boolean {
  return (
    e instanceof WooError &&
    e.status != null &&
    e.status >= 400 &&
    ![502, 503, 504].includes(e.status) &&
    e.kind !== "tiempo" &&
    e.kind !== "red" &&
    e.kind !== "respuesta_invalida"
  );
}

function orderLabelOf(order: Pick<WooOrder, "number" | "id"> | null | undefined): string | null {
  if (!order) return null;
  const n = String(order.number ?? "").trim().replace(/^#/, "");
  return n ? `#${n}` : order.id ? `#${order.id}` : null;
}

/**
 * Crea la venta en WooCommerce con las garantías de Shopify (ver la cabecera):
 *
 *   1. busca el intento anterior (`kapta_request_id`) y lo lee entero. Con la
 *      misma huella (`kapta_request_hash`: el formulario dice lo mismo) y los
 *      precios en regla: si está vivo se adopta; si quedó `pending` se retoma
 *      en el paso 4. Si no: uno vivo es un `conflict` (ni se registra con lo de
 *      ahora ni se crea otro); uno `pending` se borra, y si no se puede borrar
 *      no se crea otro. Anulado o reembolsado: se crea uno nuevo;
 *   2. `POST /orders` en `pending`;
 *   3. compara (`wooSaleMismatches`, con los productos variables de
 *      `wooLinesToVerify`); si no cuadra, lo borra (o lo anula, si un plugin ya
 *      lo dejó vivo);
 *   4. `PUT {status: "processing"}`. Si el PUT falla, relee el pedido: vivo, es
 *      la venta; `pending` y WooCommerce contestó que no, se borra; `pending`
 *      sin saber si el PUT llegó, o sin poder releerlo, NO se toca: el
 *      reintento desde el mismo formulario lo retoma o lo adopta.
 *
 * Nunca lanza: devuelve qué pasó. Lo que registra lleva el id de WooCommerce,
 * nunca datos de la clienta ni las claves.
 */
export async function createWooSaleOrder(input: {
  client: WooClientOpts;
  body: Record<string, unknown>;
  expected: WooSaleExpectation;
  requestId: string;
  /** La hora para la ventana del intento anterior. */
  now?: () => number;
  /** El reloj de la venta (`WOO_SALE_BUDGET_MS`). */
  clock?: () => number;
  budgetMs?: number;
  timeouts?: Partial<WooSaleTimeouts>;
  log?: WooSaleLog;
}): Promise<WooSaleOutcome> {
  const t: WooSaleTimeouts = { ...WOO_SALE_TIMEOUTS, ...(input.timeouts ?? {}) };
  const log = input.log ?? defaultLog;
  const now = input.now ?? Date.now;
  const clock = input.clock ?? Date.now;
  const deadline = clock() + (input.budgetMs ?? WOO_SALE_BUDGET_MS);
  const expected = input.expected;
  let auth = input.client.auth ?? "basic";
  /** Las opciones de una llamada: su tope, o lo que quede del reloj si es menos. */
  const opts = (cap: number): WooClientOpts => {
    const ms = Math.min(cap, deadline - clock());
    if (ms < WOO_SALE_MIN_CALL_MS) {
      throw new WooError("tiempo", "WooCommerce está respondiendo lento y se acabó el tiempo de esta venta.");
    }
    return { ...input.client, auth, timeoutMs: ms };
  };

  // Cada línea con su precio fijado: sin él WooCommerce cobraría el de su
  // catálogo y no habría con qué compararlo (`wooSaleLinesProblem`).
  if (expected.lines.some((l) => l.subtotal == null || l.total == null || l.subtotal < 0 || l.total < 0)) {
    return {
      kind: "error",
      message: "Pedido NO generado: hay productos sin precio fijado. No se llamó a WooCommerce.",
      cleanup: null,
      orderLabel: null,
    };
  }

  /** Borra un pedido que Kapta no tomó (`pending`…), o anula uno que ya está vivo. */
  const discard = async (order: Pick<WooOrder, "id" | "status">, reason: string): Promise<WooSaleCleanup> => {
    const wooId = Number(order.id);
    if (!isWooOrderIngestible(order)) {
      try {
        await wooRequest(opts(t.cleanup), { method: "DELETE", path: `/orders/${wooId}`, query: { force: true } });
        log("woo.sale.deleted", { wooId, reason });
        return "deleted";
      } catch (e) {
        log("woo.sale.delete_failed", { wooId, reason, error: e instanceof WooError ? e.kind : "desconocido" });
        return "delete_failed";
      }
    }
    if (isClosedWooOrder(order)) return "cancelled";
    // Ya vivo: borrarlo no devolvería el stock, y el Master quizá ya lo tiene.
    try {
      await wooRequest(opts(t.cleanup), { method: "PUT", path: `/orders/${wooId}`, body: { status: "cancelled" } });
      log("woo.sale.cancelled", { wooId, reason });
      return "cancelled";
    } catch (e) {
      log("woo.sale.cancel_failed", { wooId, reason, error: e instanceof WooError ? e.kind : "desconocido" });
      return "cancel_failed";
    }
  };

  /** Lo guardado contra lo pedido, con los productos variables de las líneas sin elección del buscador. Lanza si no se pudo mirar. */
  const inspect = async (order: WooOrder) => {
    const ids = wooLinesToVerify(expected, order);
    const variable = new Set<number>();
    if (ids.length) {
      const { data } = await wooRequest<unknown>(opts(t.verify), {
        path: "/products",
        query: { include: ids.join(","), per_page: ids.length, _fields: "id,type" },
      });
      if (!Array.isArray(data)) throw new WooError("respuesta_invalida", "WooCommerce no devolvió una lista donde se esperaba una.");
      for (const p of data as { id?: unknown; type?: unknown }[]) {
        if (p?.type === "variable") variable.add(Number(p.id));
      }
    }
    return wooSaleMismatches(expected, order, variable);
  };

  // 1) El intento anterior.
  let previous: Pick<WooOrder, "id" | "status" | "number" | "meta_data"> | null;
  try {
    const found = await withWooAuthFallback(opts(t.lookup), (o) => findWooOrderByRequestId(o, input.requestId, now()));
    auth = found.auth;
    previous = found.value;
  } catch (e) {
    return {
      kind: "error",
      message: `No se pudo consultar WooCommerce antes de crear el pedido: ${errorText(e)} No se creó nada.`,
      cleanup: null,
      orderLabel: null,
    };
  }
  let resumed: WooOrder | null = null;
  if (previous && Number(previous.id) > 0 && !isClosedWooOrder(previous)) {
    let full: WooOrder;
    try {
      full = await fetchWooOrder(opts(t.lookup), previous.id);
    } catch (e) {
      const label = orderLabelOf(previous);
      return {
        kind: "error",
        message: `Este formulario ya creó ${label ? `el pedido ${label}` : "un pedido"} en WooCommerce, pero no se pudo leer: ${errorText(e)} Vuelve a intentarlo: no se creará otro.`,
        cleanup: null,
        orderLabel: label,
      };
    }
    const label = orderLabelOf(full) ?? orderLabelOf(previous);
    const sameForm = metaValue(full, WOO_META.requestHash) === expected.fingerprint;
    // Si lo anularon entre la búsqueda y la lectura, es como si no estuviera.
    if (!isClosedWooOrder(full)) {
      let check: { lineas: WooLineProblem[]; desajustes: PriceMismatch[] };
      try {
        check = await inspect(full);
      } catch (e) {
        return {
          kind: "error",
          message: `Este formulario ya creó ${label ? `el pedido ${label}` : "un pedido"} en WooCommerce, pero no se pudo comprobar: ${errorText(e)} Vuelve a intentarlo: no se creará otro.`,
          cleanup: null,
          orderLabel: label,
        };
      }
      const clean = !check.lineas.length && !check.desajustes.length;
      if (isLiveWooOrder(full)) {
        if (sameForm && clean) {
          log("woo.sale.adopted", { wooId: full.id });
          return { kind: "adopted", order: full };
        }
        log("woo.sale.conflict", { wooId: full.id, sameForm, lineas: check.lineas.length, desajustes: check.desajustes.length });
        return { kind: "conflict", order: full, orderLabel: label, lineas: check.lineas, desajustes: check.desajustes };
      }
      if (sameForm && clean) {
        // Un intento que no llegó a `processing` con lo mismo de ahora: se
        // retoma. Sin borrar, no hay carrera con un PUT anterior que tarde.
        log("woo.sale.resumed", { wooId: full.id });
        resumed = full;
      } else if ((await discard(full, "intento_anterior")) !== "deleted") {
        // Si no se pudo borrar, no se crea otro: quedarían dos pedidos con el
        // mismo intento, uno de ellos con lo de antes.
        return {
          kind: "error",
          message: `Quedó ${label ? `el pedido ${label}` : "un pedido"} (pendiente de pago) de un intento anterior de este formulario, con otros datos, y no se pudo eliminar: bórralo en WooCommerce y vuelve a intentarlo. No se creó otro.`,
          cleanup: null,
          orderLabel: label,
        };
      }
    }
  }

  let order: WooOrder;
  if (resumed) {
    order = resumed;
  } else {
    // 2) El pedido, en `pending`. Con su tope entero: un POST cortado por el
    // reloj es justo el que deja un pedido creado sin respuesta.
    if (deadline - clock() < t.create) {
      return {
        kind: "error",
        message: "WooCommerce está respondiendo lento: no se alcanzó a crear el pedido. No se creó nada; vuelve a intentarlo.",
        cleanup: null,
        orderLabel: null,
      };
    }
    let created: WooOrder;
    try {
      const { data } = await wooRequest<WooOrder>(opts(t.create), { method: "POST", path: "/orders", body: input.body });
      created = data;
    } catch (e) {
      let cleanup: WooSaleCleanup | null = null;
      if (mayHaveCreated(e)) {
        // Pudo haberse creado sin que llegara la respuesta: si está y Kapta no
        // lo toma (`pending`), se borra. Si no aparece, o ya está vivo, el
        // siguiente intento lo encuentra y lo resuelve.
        try {
          const orphan = await findWooOrderByRequestId(opts(t.cleanup), input.requestId, now());
          if (orphan && !isWooOrderIngestible(orphan)) cleanup = await discard(orphan, "creacion_sin_respuesta");
        } catch {
          /* el siguiente intento lo busca otra vez */
        }
      }
      return { kind: "error", message: `No se pudo crear el pedido en WooCommerce: ${errorText(e)}`, cleanup, orderLabel: null };
    }
    const wooId = Number(created?.id);
    if (!Number.isInteger(wooId) || wooId <= 0) {
      return { kind: "error", message: "WooCommerce no devolvió el pedido creado.", cleanup: null, orderLabel: null };
    }
    const label = orderLabelOf(created);

    // 3) Lo guardado contra lo pedido, ANTES de que sea un pedido vivo. Si un
    // plugin ya lo dejó vivo al crearlo, `discard` lo anula en vez de borrarlo.
    let check: { lineas: WooLineProblem[]; desajustes: PriceMismatch[] };
    try {
      check = await inspect(created);
    } catch (e) {
      return {
        kind: "error",
        message: `No se pudo comprobar en WooCommerce el producto de una línea: ${errorText(e)}`,
        cleanup: await discard(created, "sin_comprobar"),
        orderLabel: label,
      };
    }
    if (check.lineas.length) {
      return { kind: "lines", problemas: check.lineas, cleanup: await discard(created, "linea_sin_producto"), orderLabel: label };
    }
    if (check.desajustes.length) {
      return { kind: "price", desajustes: check.desajustes, cleanup: await discard(created, "precio"), orderLabel: label };
    }
    order = created;
  }

  // 4) Pedido vivo.
  const wooId = Number(order.id);
  const label = orderLabelOf(order);
  let updated: WooOrder;
  try {
    const { data } = await wooRequest<WooOrder>(opts(t.update), {
      method: "PUT",
      path: `/orders/${wooId}`,
      body: { status: "processing" },
    });
    updated = data;
  } catch (e) {
    // El PUT pudo llegar aunque la respuesta no: se mira cómo quedó. Solo se
    // borra lo que se VIO pendiente después de que WooCommerce contestara que
    // no; sin saberlo, borrar podría llevarse un pedido ya vivo (con el stock
    // descontado y quizá ya en el Master).
    let seen: WooOrder | null = null;
    try {
      seen = await fetchWooOrder(opts(t.cleanup), wooId);
    } catch {
      seen = null;
    }
    if (seen && isLiveWooOrder(seen)) return { kind: "created", order: seen };
    const message = `WooCommerce no confirmó el paso a «Procesando»: ${errorText(e)}`;
    if (!seen) {
      log("woo.sale.unknown", { wooId, error: e instanceof WooError ? e.kind : "desconocido" });
      return { kind: "error", message, cleanup: "unknown", orderLabel: label };
    }
    if (isWooOrderIngestible(seen)) {
      return { kind: "error", message: `${message} Quedó en «${statusOf(seen)}».`, cleanup: null, orderLabel: label };
    }
    if (isAnsweredFailure(e)) {
      return { kind: "error", message, cleanup: await discard(seen, "sin_processing"), orderLabel: label };
    }
    log("woo.sale.kept_pending", { wooId, error: e instanceof WooError ? e.kind : "desconocido" });
    return { kind: "error", message, cleanup: "kept_pending", orderLabel: label };
  }
  if (!isLiveWooOrder(updated)) {
    return {
      kind: "error",
      message: `WooCommerce dejó el pedido en «${statusOf(updated) || "sin estado"}» en vez de «processing».`,
      cleanup: isWooOrderIngestible(updated) ? null : await discard(updated, "estado_no_vivo"),
      orderLabel: label,
    };
  }
  return { kind: "created", order: updated };
}

/**
 * El pedido en el admin de WooCommerce (HPOS, que el brief pide). Solo para el
 * enlace del formulario.
 */
export function wooOrderAdminUrl(siteUrl: string, wooId: number | string): string {
  return `${siteUrl.replace(/\/+$/, "")}/wp-admin/admin.php?page=wc-orders&action=edit&id=${encodeURIComponent(String(wooId))}`;
}

// ---------------------------------------------------------------------------
// El buscador de productos
// ---------------------------------------------------------------------------

interface WooProduct {
  id?: number;
  name?: string | null;
  type?: string | null;
  status?: string | null;
  sku?: string | null;
  price?: string | number | null;
  stock_quantity?: number | null;
  images?: { src?: string | null }[] | null;
  /** Solo una variación (`type: variation`, que trae la búsqueda por `sku`): su producto. */
  parent_id?: number | null;
  /** Solo una variación: sus opciones (`{name, option}`). */
  attributes?: { name?: string | null; option?: string | null }[] | null;
}

interface WooVariation {
  id?: number;
  sku?: string | null;
  price?: string | number | null;
  stock_quantity?: number | null;
  status?: string | null;
  attributes?: { name?: string | null; option?: string | null }[] | null;
}

/** Productos por búsqueda, como mucho (con sus variaciones cada uno). */
export const WOO_SEARCH_MAX_PRODUCTS = 12;
/** Variaciones por producto, como mucho. */
export const WOO_SEARCH_MAX_VARIATIONS = 50;
/** Reloj de toda la búsqueda: lo que no llegó a tiempo no se muestra. */
export const WOO_SEARCH_BUDGET_MS = 10_000;
/** Tope de cada llamada de la búsqueda. */
export const WOO_SEARCH_CALL_MS = 8_000;
/** Variaciones pedidas a la vez. */
export const WOO_SEARCH_CONCURRENCY = 4;

const PRODUCT_FIELDS = "id,name,type,status,sku,price,stock_quantity,images,parent_id,attributes";
const PARENT_FIELDS = "id,name,images";
const VARIATION_FIELDS = "id,sku,price,stock_quantity,status,attributes";

/** Las entidades que WordPress deja en los títulos («Polo &amp; Short»). */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;|&#160;/g, " ");
}

function textOf(value: unknown): string {
  return decodeEntities(String(value ?? "")).trim();
}

function priceOf(value: unknown): number | null {
  const n = num(value);
  return n == null ? null : Math.round(n * 100) / 100;
}

function stockOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Busca en el catálogo de WooCommerce con la MISMA forma que
 * `searchCatalogProducts` de Shopify (`ProductSearchResult`), para que el
 * formulario funcione igual:
 *
 *   · `GET /products?search=…&status=publish&per_page=…`, y si lo escrito
 *     parece un SKU (sin espacios), también `?sku=…` (exacto), primero. Con
 *     `sku` WooCommerce busca también entre las variaciones
 *     (WC_REST_Products_V2_Controller: `post_type` producto y variación), y
 *     `search` solo mira el nombre y la descripción: pegar el SKU de una talla
 *     la encuentra por aquí, como en Shopify. Esa variación sale sola, con el
 *     nombre y la foto de su producto (`GET /products?include=…`); si su
 *     producto también salió, va con él y no aparte;
 *   · un producto simple es una variante (`woo:<id del producto>`); uno
 *     variable trae sus variaciones publicadas
 *     (`GET /products/<id>/variations`, `woo:<id de la variación>`), de a
 *     `WOO_SEARCH_CONCURRENCY`; agrupados y externos no se venden por aquí;
 *   · una variación sin SKU propio (WooCommerce le muestra el del padre) va
 *     con `sku: null`: «Generar pedido» la frena con su mensaje, porque por
 *     SKU se crearía el producto padre;
 *   · acotada: `WOO_SEARCH_MAX_PRODUCTS` resultados, `WOO_SEARCH_MAX_VARIATIONS`
 *     variaciones cada uno y `WOO_SEARCH_BUDGET_MS` en total.
 *
 * Los ids son de WooCommerce (`woo:<id>`): nada los manda a Shopify.
 */
export async function searchWooCatalog(
  client: WooClientOpts,
  input: { query: string; first?: number; now?: () => number },
): Promise<ProductSearchResult[]> {
  const now = input.now ?? Date.now;
  const deadline = now() + WOO_SEARCH_BUDGET_MS;
  const timeout = () => Math.max(1_000, Math.min(WOO_SEARCH_CALL_MS, deadline - now()));
  const perPage = Math.max(1, Math.min(WOO_SEARCH_MAX_PRODUCTS, Math.floor(input.first ?? WOO_SEARCH_MAX_PRODUCTS)));
  const q = input.query.trim();

  const list = (o: WooClientOpts, extra: Record<string, string>) =>
    wooRequest<unknown>(o, {
      path: "/products",
      query: { status: "publish", per_page: perPage, _fields: PRODUCT_FIELDS, ...extra },
    }).then(({ data }) => (Array.isArray(data) ? (data as WooProduct[]) : []));

  const first = await withWooAuthFallback({ ...client, timeoutMs: timeout() }, (o) =>
    Promise.all([
      /^\S{2,}$/.test(q) ? list(o, { sku: q }).catch(() => [] as WooProduct[]) : Promise.resolve([] as WooProduct[]),
      list(o, q ? { search: q } : {}),
    ]),
  );
  const auth = first.auth;
  const [bySku, bySearch] = first.value;

  // Lo que se muestra, en orden: productos (simples y variables) y variaciones
  // sueltas encontradas por su SKU.
  type Hit = { kind: "product"; p: WooProduct } | { kind: "variation"; v: WooProduct; parentId: number };
  const hits: Hit[] = [];
  const seenProducts = new Set<number>();
  const seenVariations = new Set<number>();
  for (const p of [...bySku, ...bySearch]) {
    if (hits.length >= perPage) break;
    const id = Number(p?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (p.type === "variation") {
      const parentId = Number(p.parent_id);
      if (!Number.isInteger(parentId) || parentId <= 0 || seenVariations.has(id) || !textOf(p.sku)) continue;
      seenVariations.add(id);
      hits.push({ kind: "variation", v: p, parentId });
      continue;
    }
    if (p.type !== "simple" && p.type !== "variable") continue;
    if (seenProducts.has(id)) continue;
    seenProducts.add(id);
    hits.push({ kind: "product", p });
  }
  const products = hits.flatMap((h) => (h.kind === "product" ? [h.p] : []));
  const variableIds = new Set(products.filter((p) => p.type === "variable").map((p) => Number(p.id)));
  // Una variación cuyo producto variable también salió ya va con él.
  const loose = hits.flatMap((h) => (h.kind === "variation" && !variableIds.has(h.parentId) ? [h] : []));

  const variationsOf = new Map<number, WooVariation[]>();
  const parents = new Map<number, WooProduct>();
  const variable = products.filter((p) => p.type === "variable");
  const jobs: (() => Promise<void>)[] = variable.map((p) => async () => {
    try {
      const { data } = await wooRequest<unknown>(
        { ...client, auth, timeoutMs: timeout() },
        {
          path: `/products/${p.id}/variations`,
          query: { status: "publish", per_page: WOO_SEARCH_MAX_VARIATIONS, _fields: VARIATION_FIELDS },
        },
      );
      if (Array.isArray(data)) variationsOf.set(Number(p.id), data as WooVariation[]);
    } catch {
      /* sin sus variaciones no se ofrece: se muestran las demás */
    }
  });
  const parentIds = [...new Set(loose.map((h) => h.parentId))];
  if (parentIds.length) {
    jobs.push(async () => {
      try {
        const { data } = await wooRequest<unknown>(
          { ...client, auth, timeoutMs: timeout() },
          { path: "/products", query: { include: parentIds.join(","), per_page: parentIds.length, _fields: PARENT_FIELDS } },
        );
        for (const p of Array.isArray(data) ? (data as WooProduct[]) : []) parents.set(Number(p?.id), p);
      } catch {
        /* sin el producto, la variación va con su propio nombre */
      }
    });
  }
  for (let i = 0; i < jobs.length; i += WOO_SEARCH_CONCURRENCY) {
    if (now() >= deadline) break;
    await Promise.all(jobs.slice(i, i + WOO_SEARCH_CONCURRENCY).map((job) => job()));
  }

  const optionsOf = (attrs: WooVariation["attributes"]) =>
    (attrs ?? [])
      .map((a) => textOf(a?.option))
      .filter(Boolean)
      .join(" / ");
  const out: ProductSearchResult[] = [];
  for (const h of hits) {
    if (h.kind === "variation") {
      if (variableIds.has(h.parentId)) continue;
      const v = h.v;
      const parent = parents.get(h.parentId);
      const imageOf = (p: WooProduct | undefined) => (p?.images ?? []).map((im) => String(im?.src ?? "").trim()).find(Boolean) ?? null;
      out.push({
        productId: wooVariantRef(h.parentId),
        title: textOf(parent?.name) || textOf(v.name),
        imageUrl: imageOf(v) ?? imageOf(parent),
        variants: [
          {
            variantId: wooVariantRef(Number(v.id)),
            variantTitle: optionsOf(v.attributes),
            price: priceOf(v.price),
            inventory: stockOf(v.stock_quantity),
            sku: textOf(v.sku),
          },
        ],
      });
      continue;
    }
    const p = h.p;
    const id = Number(p.id);
    const parentSku = textOf(p.sku);
    const variants: CatalogVariant[] = [];
    if (p.type === "simple") {
      variants.push({
        variantId: wooVariantRef(id),
        variantTitle: "",
        price: priceOf(p.price),
        inventory: stockOf(p.stock_quantity),
        sku: parentSku || null,
      });
    } else {
      for (const v of variationsOf.get(id) ?? []) {
        const vid = Number(v?.id);
        if (!Number.isInteger(vid) || vid <= 0) continue;
        if (v.status && v.status !== "publish") continue;
        const sku = textOf(v.sku);
        variants.push({
          variantId: wooVariantRef(vid),
          variantTitle: optionsOf(v.attributes),
          price: priceOf(v.price),
          inventory: stockOf(v.stock_quantity),
          sku: sku && sku !== parentSku ? sku : null,
        });
      }
    }
    if (!variants.length) continue;
    out.push({
      productId: wooVariantRef(id),
      title: textOf(p.name),
      imageUrl: (p.images ?? []).map((im) => String(im?.src ?? "").trim()).find(Boolean) ?? null,
      variants,
    });
  }
  return out;
}

/**
 * La búsqueda agrupada → la lista plana de `searchProductVariants` («Producto ·
 * Variante»), la que usa el selector de stock de Swayp.
 */
export function flattenCatalog(products: readonly ProductSearchResult[]): ProductVariantResult[] {
  const out: ProductVariantResult[] = [];
  for (const p of products) {
    for (const v of p.variants) {
      out.push({
        variantId: v.variantId,
        title: v.variantTitle ? `${p.title} · ${v.variantTitle}` : p.title,
        price: v.price,
        inventory: v.inventory,
        sku: v.sku,
        imageUrl: p.imageUrl,
      });
    }
  }
  return out;
}

/** Las opciones del cliente REST de una tienda con sus claves completas. */
export function wooSaleClient(creds: WooApiCreds, extra: Partial<WooClientOpts> = {}): WooClientOpts {
  return { siteUrl: creds.siteUrl, consumerKey: creds.consumerKey, consumerSecret: creds.consumerSecret, ...extra };
}
