// La lectura del pedido en WooCommerce para su comprobante (MOM §35.11, §38).
//
// POR QUÉ. Desde el 24-10-2026 Aurela vende por WooCommerce, y Kenku desde el
// cierre de Shopify (27-10-2026). La boleta de un pedido de Shopify vuelve a
// leer el pedido en Shopify justo antes de emitir (§35.3); uno de WooCommerce
// no tiene a quién preguntarle en Shopify —su id `wc-kp-1532` no es de Shopify,
// aunque `extractNumericId` le saque un número—, así que hasta hoy quedaba en
// `no_encontrado` o `sin_token_shopify` y nunca salía. Esta es su lectura, con
// las MISMAS garantías: los ítems al céntimo, el total igual al de Kapta, y
// ante cualquier duda, un motivo y ninguna boleta.
//
// DE DÓNDE. De la API REST de WooCommerce (`GET /wp-json/wc/v3/orders/<id>`)
// con las claves guardadas de la tienda, justo antes de emitir. No de
// `orders.raw.woo`: eso es lo que llegó con el último webhook o la última
// pasada, y WooCommerce no reintenta un webhook que falló; un reembolso o una
// anulación de hace un minuto pueden no estar ahí todavía. WooCommerce no se
// apaga como Shopify: si no contesta, el pedido espera a la próxima pasada
// (`lectura_fallida`), nunca sale de una copia.
//
// LO QUE NO PIDE NI GUARDA. Nada de la clienta sale de aquí: la boleta va a
// «CLIENTES VARIOS» (§35.5). La respuesta de WooCommerce trae la facturación y
// el envío, pero esta lectura solo mira montos, estado, moneda, líneas y envío.
//
// FALLA CERRADA. Como la de Shopify: un dato que no vino, que no se entiende o
// que no cuadra es un motivo, nunca un ítem inventado ni un cero supuesto. Las
// funciones de este archivo no lanzan: devuelven el motivo.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { parseWooOrderId } from "@/lib/order-admin-url";
import {
  WOO_CANCELLED_STATUSES,
  WOO_SKIPPED_STATUSES,
  WooError,
  fetchWooOrder,
} from "@/lib/woocommerce";
import {
  hasWooApiCredentials,
  loadWooStoreCreds,
  withWooAuthFallback,
  wooClientOpts,
} from "@/lib/woocommerce-intake";
import type { InvoiceItem, InvoiceReason } from "@/lib/invoicing/rules";
import type { InvoiceOrderRead } from "@/lib/invoicing/shopify-order";

/**
 * Las líneas que se aceptan en una boleta: las mismas 100 que la consulta de
 * Shopify trae de una vez (`demasiadas_lineas`).
 */
export const WOO_INVOICE_MAX_LINES = 100;

/**
 * Lo que dice el prepago web de un pedido de WooCommerce (§35.11). WooCommerce
 * no guarda cuánto cobró la pasarela —solo que el plugin lo marcó pagado—, y la
 * regla de §35.3 pide que lo cobrado por Flow sume el total. No se adivina.
 */
export const WOO_PREPAID_UNCONFIRMED_DETAIL =
  "WooCommerce no guarda cuánto cobró la pasarela, solo que la marcó pagada: el prepago web de WooCommerce no lleva boleta automática.";

const ITEM_NAME_MAX = 250;
const SHIPPING_CODE = "ENVIO";
const SHIPPING_NAME = "Servicio de envío";

type Obj = Record<string, unknown>;

/** Un dato que vino mal. Corta el mapeo con `lectura_fallida`. */
class Unreadable extends Error {}

function objOf(value: unknown, field: string): Obj {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Obj;
  throw new Unreadable(field);
}

function listOf(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new Unreadable(field);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Un entero positivo de WooCommerce (id, cantidad). */
function positiveIntOf(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new Unreadable(field);
}

/**
 * Céntimos enteros de un monto de WooCommerce. La API manda texto decimal con
 * los decimales de la tienda («337.00»); también se acepta un número. Un texto
 * vacío, un null o algo que no es un decimal NO son cero, y un monto con
 * fracción de céntimo («33.333») no se redondea solo: no se sabe a qué lado.
 */
function centsOf(value: unknown, field: string): number {
  let n: number;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) n = Number(value.trim());
  else if (typeof value === "number") n = value;
  else throw new Unreadable(field);
  if (!Number.isFinite(n)) throw new Unreadable(field);
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) throw new Unreadable(field);
  return cents;
}

/** Un monto que no puede ser negativo: un precio, una línea, un envío. */
function nonNegativeCentsOf(value: unknown, field: string): number {
  const c = centsOf(value, field);
  if (c < 0) throw new Unreadable(field);
  return c;
}

function soles(cents: number): string {
  return (cents / 100).toFixed(2);
}

const fail = (reason: InvoiceReason, detail?: string): InvoiceOrderRead => ({
  ok: false,
  reason,
  ...(detail ? { detail } : {}),
});

/** «Faja Reductora» para el detalle de un motivo: el producto, nunca la clienta. */
function lineLabel(title: string, index: number): string {
  return title ? `Línea «${title.slice(0, 80)}».` : `Línea ${index + 1}.`;
}

/**
 * El código del ítem: el SKU; si no hay, la variación (`V…`), el producto
 * (`P…`) o la línea (`L…`). Siempre algo estable que se pueda buscar en
 * WooCommerce.
 */
function lineCode(line: Obj): string | null {
  const sku = textOf(line.sku);
  if (sku) return sku;
  for (const [prefix, value] of [
    ["V", line.variation_id],
    ["P", line.product_id],
    ["L", line.id],
  ] as const) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return `${prefix}${value}`;
  }
  return null;
}

/** El estado como lo guarda Kapta: minúsculas y sin el `wc-` de algunos plugins (§38.3). */
function statusOf(value: unknown): string {
  return textOf(value).toLowerCase().replace(/^wc-/, "");
}

function mapOrThrow(raw: unknown, kaptaId: string): InvoiceOrderRead {
  const o = objOf(raw, "order");
  const wooId = positiveIntOf(o.id, "id");
  const number = textOf(o.number).replace(/^#/, "") || String(wooId);
  const name = `#${number}`;

  // 1. Lo que bloquea el pedido entero, en el orden de MOM §35.3.
  const status = statusOf(o.status);
  if (!status) throw new Unreadable("status");
  if (WOO_CANCELLED_STATUSES.includes(status)) return fail("anulado");
  if (status === "refunded") return fail("reembolsado");
  // Pendiente de pago, fallido o un borrador: para Kapta no es un pedido
  // (§38.3), aunque alguien lo haya devuelto ahí después de que entró.
  if (WOO_SKIPPED_STATUSES.includes(status)) {
    return fail("no_encontrado", `Está en «${status}» en WooCommerce: no es un pedido vivo (MOM §38.3).`);
  }

  const currency = o.currency;
  if (currency !== "PEN") {
    return fail(
      "moneda",
      typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? `WooCommerce lo cobra en ${currency}.` : undefined,
    );
  }

  // Cualquier reembolso, aunque sea de cero, bloquea: es un cambio después de
  // la venta, y la boleta no se arma sobre un pedido que se está deshaciendo.
  if (listOf(o.refunds, "refunds").length > 0) return fail("reembolsado");

  // El IGV va incluido en el precio (owner, 14-10-2026): Kapta no suma
  // impuestos. Si WooCommerce calculó alguno —en el pedido, en una línea, en el
  // envío o en un cargo—, los ítems con IGV incluido no darían su total.
  for (const field of ["total_tax", "cart_tax", "shipping_tax", "discount_tax"] as const) {
    if (centsOf(o[field], field) !== 0) return fail("impuesto_encima", "WooCommerce calculó impuestos.");
  }
  if (listOf(o.tax_lines, "tax_lines").length > 0) return fail("impuesto_encima", "WooCommerce calculó impuestos.");

  const lines = listOf(o.line_items, "line_items");
  if (!lines.length) return fail("no_cuadra", "WooCommerce no trajo ninguna línea.");
  if (lines.length > WOO_INVOICE_MAX_LINES) return fail("demasiadas_lineas");

  // 2. Las líneas. En WooCommerce `total` ya es la línea neta: el precio por la
  // cantidad menos su parte de los cupones (`subtotal` es antes de ellos).
  const items: InvoiceItem[] = [];
  for (const [i, node] of lines.entries()) {
    const at = `line_items[${i}]`;
    const line = objOf(node, at);
    const title = textOf(line.name);
    const qty = positiveIntOf(line.quantity, `${at}.quantity`);
    if (centsOf(line.subtotal_tax, `${at}.subtotal_tax`) !== 0 || centsOf(line.total_tax, `${at}.total_tax`) !== 0) {
      return fail("impuesto_encima", "WooCommerce calculó impuestos.");
    }
    const subtotal = nonNegativeCentsOf(line.subtotal, `${at}.subtotal`);
    const net = nonNegativeCentsOf(line.total, `${at}.total`);
    // Un «descuento» negativo es un recargo escondido en la línea: no se entiende.
    if (net > subtotal) return fail("no_cuadra", `${lineLabel(title, i)} Cuesta más que su precio antes de descuentos.`);

    // Si la neta no se divide exacto entre la cantidad, la línea se parte en dos
    // ítems que difieren en un céntimo, como en Shopify.
    const base = Math.floor(net / qty);
    const rest = net - base * qty;
    // Un regalo a S/ 0 (el «3 + 2 gratis» del formulario), o céntimos que no
    // llegan a uno por unidad: para SUNAT es una operación gratuita, con su
    // propio tratamiento. No se decide sola (MOM §35.3).
    if (base <= 0) return fail("linea_gratuita", lineLabel(title, i));

    const code = lineCode(line);
    if (!code) throw new Unreadable(`${at}.id`);
    if (!title) return fail("sin_boleta", `La línea ${i + 1} no tiene nombre.`);
    const itemName = title.slice(0, ITEM_NAME_MAX).trim();
    if (rest === 0) {
      items.push({ code, name: itemName, qty, priceCents: base });
    } else {
      if (qty - rest > 0) items.push({ code, name: itemName, qty: qty - rest, priceCents: base });
      items.push({ code, name: itemName, qty: rest, priceCents: base + 1 });
    }
  }

  // 3. Los cargos sueltos (`fee_lines`): un recargo por contraentrega, o un
  // descuento armado como cargo negativo. No hay regla del owner para
  // repartirlos ni para cobrarlos como ítem: no se emite sola.
  for (const [i, node] of listOf(o.fee_lines, "fee_lines").entries()) {
    const fee = objOf(node, `fee_lines[${i}]`);
    if (centsOf(fee.total_tax, `fee_lines[${i}].total_tax`) !== 0) {
      return fail("impuesto_encima", "WooCommerce calculó impuestos.");
    }
    if (centsOf(fee.total, `fee_lines[${i}].total`) !== 0) {
      const feeName = textOf(fee.name).slice(0, 80);
      return fail("no_cuadra", `Tiene un cargo suelto en WooCommerce${feeName ? ` («${feeName}»)` : ""}: no se reparte solo.`);
    }
  }

  // 4. El envío cobrado es un ítem más.
  for (const [i, node] of listOf(o.shipping_lines, "shipping_lines").entries()) {
    const at = `shipping_lines[${i}]`;
    const s = objOf(node, at);
    if (centsOf(s.total_tax, `${at}.total_tax`) !== 0) return fail("impuesto_encima", "WooCommerce calculó impuestos.");
    const price = nonNegativeCentsOf(s.total, `${at}.total`);
    if (price === 0) continue; // Envío gratis: no va en la boleta.
    const title = textOf(s.method_title);
    items.push({
      code: SHIPPING_CODE,
      name: (title ? `${SHIPPING_NAME} - ${title}` : SHIPPING_NAME).slice(0, ITEM_NAME_MAX).trim(),
      qty: 1,
      priceCents: price,
    });
  }

  // 5. El cuadre: la suma de los ítems tiene que ser exactamente el total de
  // WooCommerce. Es la red de todo lo de arriba.
  const total = centsOf(o.total, "total");
  const sum = items.reduce((acc, item) => acc + item.priceCents * item.qty, 0);
  if (sum !== total) {
    return fail("no_cuadra", `El detalle suma S/ ${soles(sum)}; WooCommerce dice S/ ${soles(total)}.`);
  }

  // 6. El cobro: WooCommerce no guarda las transacciones de la pasarela ni
  // cuánto cobró. Para la boleta, lo cobrado por Flow es 0 y lo pendiente, el
  // total: un prepago web de WooCommerce nunca pasa `webPrepaidConfirmed`. Los
  // pedidos pagados con constancias no lo miran: su pago lo prueban los
  // comprobantes validados en Kapta, como en Shopify.
  const title = textOf(o.payment_method_title);
  return {
    ok: true,
    orderGid: kaptaId,
    name,
    totalCents: total,
    items,
    payment: {
      financialStatus: status,
      gatewayNames: title ? [title] : [],
      paidCents: 0,
      otherPaidCents: 0,
      netPaymentCents: 0,
      outstandingCents: total,
    },
  };
}

/**
 * Un pedido de la API REST de WooCommerce (`GET /orders/<id>`) → los ítems de
 * la boleta al céntimo, o el primer motivo por el que no se emite. Puro y sin
 * red. `expected` es el pedido que se pidió: si la respuesta es de otro, no se
 * usa.
 */
export function mapWooOrderForInvoice(
  order: unknown,
  expected: { siteKey: string; wooId: string },
): InvoiceOrderRead {
  if (order === null || order === undefined) return fail("no_encontrado", "WooCommerce no devolvió el pedido.");
  const kaptaId = `wc-${expected.siteKey}-${expected.wooId}`;
  try {
    const id = order && typeof order === "object" ? (order as Obj).id : undefined;
    if (typeof id === "number" && String(id) !== expected.wooId) {
      return fail("lectura_fallida", "WooCommerce devolvió otro pedido.");
    }
    return mapOrThrow(order, kaptaId);
  } catch (e) {
    if (e instanceof Unreadable) return fail("lectura_fallida", `WooCommerce devolvió un dato ilegible: ${e.message}.`);
    return fail("lectura_fallida", "No se pudo leer el pedido de WooCommerce.");
  }
}

/**
 * Lee el pedido en WooCommerce y lo mapea para su boleta. Nunca lanza.
 *
 *   · un id que no es `wc-<clave>-<id>`, o de otro sitio que el de la tienda:
 *     `no_encontrado` (se emite a mano);
 *   · la tienda sin la dirección, la clave del sitio o las dos claves de la
 *     API, o con claves que no se pueden descifrar: `sin_claves_woo` (se vuelve
 *     a mirar en unas horas, como `sin_token_shopify`);
 *   · WooCommerce dice que no existe (404 de un pedido): `no_encontrado`;
 *   · cualquier otro fallo —la base, la red, un tiempo agotado, un 5xx, un
 *     401/403, una ruta sin la API—: `lectura_fallida`, se reintenta en la
 *     próxima pasada. El mensaje de `WooError` no lleva claves ni la dirección.
 *
 * Usa las mismas credenciales y el mismo cliente que la entrada de pedidos
 * (§38.11): Basic y, si el hosting borra la cabecera, la query string.
 */
export async function fetchWooOrderForInvoice(
  input: { storeId: string; shopifyOrderId: string },
  deps: { admin?: SupabaseClient; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<InvoiceOrderRead> {
  const parsed = parseWooOrderId(input.shopifyOrderId.trim());
  if (!parsed) return fail("no_encontrado", "El pedido no tiene id de WooCommerce.");
  const admin = deps.admin ?? createAdminSupabase();

  let loaded: Awaited<ReturnType<typeof loadWooStoreCreds>>;
  try {
    loaded = await loadWooStoreCreds(admin, input.storeId);
  } catch {
    return fail("lectura_fallida", "No se pudo leer la conexión de la tienda con WooCommerce.");
  }
  if (loaded.error) return fail("lectura_fallida", "No se pudo leer la conexión de la tienda con WooCommerce.");
  const creds = loaded.creds;
  if (!creds) return fail("lectura_fallida", "No se encontró la tienda del pedido.");
  if (creds.undecryptable.some((c) => c === "woo_consumer_key_enc" || c === "woo_consumer_secret_enc")) {
    return fail("sin_claves_woo", "Las claves guardadas no se pueden descifrar: vuelve a pegarlas en Ajustes → WooCommerce.");
  }
  if (!hasWooApiCredentials(creds)) return fail("sin_claves_woo");
  // La clave del sitio no cambia después del primer pedido (§38.2): un id con
  // otra clave no es un pedido de este sitio, y no se le pregunta a éste.
  if (creds.siteKey !== parsed.siteKey) {
    return fail("no_encontrado", `El id del pedido es de otro sitio (clave «${parsed.siteKey}»), no del de esta tienda.`);
  }

  let data: unknown;
  try {
    const opts = wooClientOpts(creds, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
    data = (await withWooAuthFallback(opts, (o) => fetchWooOrder(o, parsed.wooId))).value;
  } catch (e) {
    if (e instanceof WooError) {
      if (e.kind === "no_encontrado" && e.status === 404 && e.code !== "rest_no_route") {
        return fail("no_encontrado", "WooCommerce no lo encontró (HTTP 404).");
      }
      return fail("lectura_fallida", e.message);
    }
    return fail("lectura_fallida", "No se pudo leer el pedido en WooCommerce.");
  }

  const read = mapWooOrderForInvoice(data, parsed);
  if (!read.ok) return read;
  return { ...read, woocommerce: { readAt: new Date((deps.now ?? Date.now)()).toISOString() } };
}
