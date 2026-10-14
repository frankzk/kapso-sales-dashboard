// La lectura del pedido en Shopify para su comprobante (MOM §35.3, §35.5).
//
// POR QUÉ SE VUELVE A LEER. Lo guardado en `orders` no alcanza para armar la
// boleta: `line_items[].price` es el precio antes de descuentos, y los descuentos
// del pedido entero, el envío cobrado, si el impuesto va encima o si el pedido
// se editó solo los sabe Shopify. Justo antes de emitir se le pregunta, y los
// ítems salen de esa lectura, al céntimo.
//
// LO QUE NO PIDE. Nada de la clienta: ni nombre, ni correo, ni celular, ni
// direcciones. La boleta va a «CLIENTES VARIOS» (§35.5), y esos campos son datos
// protegidos de Shopify (el memo de `ordersPhoneSupported` en lib/shopify.ts):
// sin pedirlos, el comprobante no depende de ese permiso ni los toca.
//
// FALLA CERRADA. Un dato que no vino, que no se entiende o que no cuadra es un
// motivo, nunca un ítem inventado ni un cero supuesto: una boleta enviada a
// SUNAT no se borra. Emitir de menos se arregla a mano; emitir de más, no.
// `mapOrderForInvoice` y `fetchOrderForInvoice` no lanzan: devuelven el motivo.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { decryptOrNull } from "@/lib/crypto";
import { shopifyGraphQL } from "@/lib/shopify";
import { extractNumericId } from "@/lib/shopify-urls";
import { CHECKOUT_GATEWAYS } from "@/lib/payment-gateway";
import type { InvoiceItem, InvoiceReason } from "@/lib/invoicing/rules";

/**
 * El pedido para su boleta (Admin API 2025-01). Las líneas son 100 como mucho:
 * si hay más, `hasNextPage` lo dice y el pedido no se emite. Los montos se leen
 * de `shopMoney`, la moneda de la tienda; la de presentación puede ser otra.
 */
export const ORDER_FOR_INVOICE_QUERY = /* GraphQL */ `
  query OrderForInvoice($id: ID!) {
    order(id: $id) {
      id
      name
      test
      edited
      cancelledAt
      displayFinancialStatus
      paymentGatewayNames
      taxesIncluded
      currencyCode
      totalPriceSet { shopMoney { amount currencyCode } }
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount } }
      netPaymentSet { shopMoney { amount } }
      totalOutstandingSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      totalTipReceivedSet { shopMoney { amount } }
      transactions(first: 20) {
        kind
        status
        gateway
        formattedGateway
        test
        amountSet { shopMoney { amount } }
      }
      lineItems(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id
          title
          variantTitle
          sku
          quantity
          currentQuantity
          isGiftCard
          variant { id }
          originalUnitPriceSet { shopMoney { amount } }
          discountAllocations { allocatedAmountSet { shopMoney { amount } } }
        }
      }
      shippingLines(first: 10, includeRemovals: true) {
        nodes {
          title
          isRemoved
          discountedPriceSet { shopMoney { amount } }
        }
      }
    }
  }
`;

export type InvoiceOrderRead =
  | {
      ok: true;
      orderGid: string;
      name: string;
      /** El total de Shopify, que es también la suma exacta de los ítems. */
      totalCents: number;
      items: InvoiceItem[];
      /**
       * Lo que Shopify dice del cobro, sin decidir. Solo pesa en el prepago web
       * (`webPrepaidConfirmed`): en los demás pedidos el pago lo prueban los
       * comprobantes validados en Kapta, y Shopify puede seguir en `PENDING`.
       */
      payment: {
        financialStatus: string;
        gatewayNames: string[];
        /** Ventas y capturas aprobadas, no de prueba, que cobró el checkout de Flow. */
        paidCents: number;
        /**
         * Lo mismo, cobrado por CUALQUIER otra pasarela: «manual», contraentrega,
         * tarjeta de regalo, o una cuyo nombre no se reconoce. Ese dinero no entró
         * a la cuenta de Flow y no va en su boleta.
         */
        otherPaidCents: number;
        netPaymentCents: number;
        outstandingCents: number;
      };
    }
  | { ok: false; reason: InvoiceReason; detail?: string };

type InvoiceOrderOk = Extract<InvoiceOrderRead, { ok: true }>;

/** Tope de la lectura: el barrido corre con presupuesto y un Shopify colgado no puede comérselo. */
const SHOPIFY_READ_TIMEOUT_MS = 15_000;

/** El largo del nombre de un ítem en SimpleFact (lo corta igual `buildSalePayload`). */
const ITEM_NAME_MAX = 250;

const SHIPPING_CODE = "ENVIO";
const SHIPPING_NAME = "Servicio de envío";

// ── Lectura estricta del nodo ────────────────────────────────────────────────
//
// Todo lo que la consulta pide y Shopify garantiza (los campos `!` del esquema)
// tiene que venir legible. Si no, la respuesta no es la que creemos y el pedido
// no se emite en esta pasada: `lectura_fallida`. Solo se toleran los campos que
// el esquema deja en null (sku, variante, título de la variante, impuesto).

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

function flagOf(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Unreadable(field);
}

function intOf(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  throw new Unreadable(field);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Céntimos enteros de un `MoneyBag` (`{ shopMoney: { amount } }`), o null si no
 * se puede leer. Shopify manda el monto como texto decimal («89.9»). Un texto
 * vacío o un null NO son cero: `Number("")` daría 0 y un dato ausente pasaría
 * por «sin reembolso» o «sin propina».
 */
function centsOrNull(bag: unknown): number | null {
  if (!bag || typeof bag !== "object") return null;
  const shopMoney = (bag as Obj).shopMoney;
  if (!shopMoney || typeof shopMoney !== "object") return null;
  const amount = (shopMoney as Obj).amount;
  const n =
    typeof amount === "string" && amount.trim()
      ? Number(amount)
      : typeof amount === "number"
        ? amount
        : Number.NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function centsOf(bag: unknown, field: string): number {
  const c = centsOrNull(bag);
  if (c === null) throw new Unreadable(field);
  return c;
}

/** Un monto que no puede ser negativo: un descuento, un precio, un envío. */
function nonNegativeCentsOf(bag: unknown, field: string): number {
  const c = centsOf(bag, field);
  if (c < 0) throw new Unreadable(field);
  return c;
}

function currencyOf(bag: unknown): unknown {
  if (!bag || typeof bag !== "object") return undefined;
  const shopMoney = (bag as Obj).shopMoney;
  return shopMoney && typeof shopMoney === "object" ? (shopMoney as Obj).currencyCode : undefined;
}

/** El número de un gid de Shopify, o null si no trae uno. */
function numericIdOf(gid: unknown): string | null {
  if (typeof gid !== "string" && typeof gid !== "number") return null;
  const id = extractNumericId(gid);
  return /^\d+$/.test(id) ? id : null;
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

// ── El mapeo, al céntimo ─────────────────────────────────────────────────────

/**
 * El código del ítem: el SKU; si no hay, la variante (`V…`); si tampoco, la
 * línea (`L…`). Siempre algo estable que se pueda buscar en Shopify.
 */
function lineCode(line: Obj): string | null {
  const sku = textOf(line.sku);
  if (sku) return sku;
  const variant = line.variant && typeof line.variant === "object" ? (line.variant as Obj) : null;
  const variantId = numericIdOf(variant?.id);
  if (variantId) return `V${variantId}`;
  const lineId = numericIdOf(line.id);
  return lineId ? `L${lineId}` : null;
}

/** «Faja Reductora - M / Negro». La variante única de Shopify se llama «Default Title» y no se pone. */
function lineName(title: string, variantTitle: unknown): string {
  const variant = textOf(variantTitle);
  const full = variant && variant.toLowerCase() !== "default title" ? `${title} - ${variant}` : title;
  return full.trim().slice(0, ITEM_NAME_MAX).trim();
}

// ── El dinero de Flow ────────────────────────────────────────────────────────
//
// La boleta de un prepago web va al RUC de la cuenta de Flow (MOM §35.2), así
// que solo puede cubrir lo que cobró Flow. `classifyPaymentGateway` dice
// «checkout» si CUALQUIER pasarela del pedido es Flow: un pedido con
// [Flow, «manual»] —Flow falló o cobró una parte, y alguien lo marcó pagado a
// mano, o el resto fue contraentrega o tarjeta de regalo— pasaría por pagado
// por Flow con dinero que Flow nunca recibió. Por eso se mira cada transacción.

/**
 * Un nombre de pasarela comparable: sin espacios de más, en minúsculas y sin
 * tildes. «Cuotas débito» y «Cuotas debito» son la misma pasarela.
 */
function normalizeGatewayName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Las pasarelas del checkout confirmadas por la operación (lib/payment-gateway.ts). */
const CHECKOUT_GATEWAY_KEYS = new Set(CHECKOUT_GATEWAYS.map(normalizeGatewayName).filter(Boolean));

/**
 * «flow» como palabra entera: «Flow», «flow_cl», «Checkout Flow | …». No
 * «overflow» ni «cashflow». El guion bajo separa, porque los handles de las
 * pasarelas lo usan.
 */
const FLOW_WORD_RE = /(?:^|[^a-z0-9])flow(?:[^a-z0-9]|$)/;

/**
 * ¿La transacción la cobró Flow? El texto de `gateway` de una transacción de
 * Flow nunca se ha visto en producción (los pedidos solo muestran
 * `paymentGatewayNames`), así que se aceptan el nombre exacto del checkout y la
 * palabra «flow», en `gateway` o en `formattedGateway`. Cualquier otra cosa
 * —o nada— es dinero de otra pasarela: falla cerrada.
 */
function isFlowTransaction(tx: Obj): boolean {
  return [tx.gateway, tx.formattedGateway].some((raw) => {
    const name = normalizeGatewayName(raw);
    return name !== "" && (CHECKOUT_GATEWAY_KEYS.has(name) || FLOW_WORD_RE.test(name));
  });
}

/** ¿El nombre es, tal cual, una pasarela del checkout confirmada? */
function isCheckoutGatewayName(value: unknown): boolean {
  return CHECKOUT_GATEWAY_KEYS.has(normalizeGatewayName(value));
}

function mapOrThrow(raw: unknown): InvoiceOrderRead {
  const o = objOf(raw, "order");
  const orderGid = textOf(o.id);
  if (!orderGid) throw new Unreadable("id");
  if (typeof o.name !== "string") throw new Unreadable("name");
  const name = o.name.trim();

  // 1. Lo que bloquea el pedido entero, en el orden de MOM §35.3.
  if (flagOf(o.test, "test")) return fail("prueba");
  if (o.cancelledAt === undefined) throw new Unreadable("cancelledAt");
  if (o.cancelledAt !== null) return fail("anulado");

  // La moneda de la tienda (`shopMoney`) tiene que ser soles. La de
  // totalPriceSet tiene que venir; las otras dos, si vienen, también en soles.
  const currencies = [currencyOf(o.totalPriceSet), currencyOf(o.currentTotalPriceSet), o.currencyCode];
  if (currencies[0] !== "PEN" || currencies.some((c) => c !== undefined && c !== "PEN")) {
    const other = currencies.find((c) => typeof c === "string" && /^[A-Z]{3}$/.test(c) && c !== "PEN");
    return fail("moneda", typeof other === "string" ? `Shopify lo cobra en ${other}.` : undefined);
  }

  // Cualquier monto reembolsado, propina o impuesto distinto de cero bloquea:
  // uno negativo tampoco se entiende.
  if (centsOf(o.totalRefundedSet, "totalRefundedSet") !== 0) return fail("reembolsado");
  if (flagOf(o.edited, "edited")) return fail("editado");
  if (centsOf(o.totalTipReceivedSet, "totalTipReceivedSet") !== 0) return fail("propina");
  // Con el IGV incluido, el impuesto ya está dentro del precio y no se mira. Si
  // Shopify lo sumó aparte, los ítems con IGV no darían el total.
  if (!flagOf(o.taxesIncluded, "taxesIncluded") && centsOf(o.totalTaxSet, "totalTaxSet") !== 0) {
    return fail("impuesto_encima");
  }
  const lineItems = objOf(o.lineItems, "lineItems");
  const pageInfo = objOf(lineItems.pageInfo, "lineItems.pageInfo");
  if (flagOf(pageInfo.hasNextPage, "lineItems.pageInfo.hasNextPage")) return fail("demasiadas_lineas");
  const nodes = listOf(lineItems.nodes, "lineItems.nodes");
  if (!nodes.length) return fail("no_cuadra", "Shopify no trajo ninguna línea.");

  // 2. Las líneas. La neta es precio original × cantidad − lo asignado de cada
  // descuento, que incluye los descuentos del pedido entero repartidos entre
  // las líneas. `discountedTotalSet` no sirve: deja fuera los del pedido.
  const items: InvoiceItem[] = [];
  for (const [i, node] of nodes.entries()) {
    const at = `lineItems.nodes[${i}]`;
    const line = objOf(node, at);
    const title = textOf(line.title);
    if (flagOf(line.isGiftCard, `${at}.isGiftCard`)) return fail("gift_card", lineLabel(title, i));
    const qty = intOf(line.quantity, `${at}.quantity`);
    // `quantity` guarda lo que se pidió y `currentQuantity` lo que queda tras una
    // edición; los descuentos se repartieron sobre lo primero.
    if (intOf(line.currentQuantity, `${at}.currentQuantity`) !== qty) {
      return fail("cantidad_editada", lineLabel(title, i));
    }
    if (qty <= 0) throw new Unreadable(`${at}.quantity`);

    const unit = nonNegativeCentsOf(line.originalUnitPriceSet, `${at}.originalUnitPriceSet`);
    let discount = 0;
    for (const [j, alloc] of listOf(line.discountAllocations, `${at}.discountAllocations`).entries()) {
      const allocAt = `${at}.discountAllocations[${j}]`;
      discount += nonNegativeCentsOf(objOf(alloc, allocAt).allocatedAmountSet, `${allocAt}.allocatedAmountSet`);
    }
    const net = unit * qty - discount;

    // Si la neta no se divide exacto entre la cantidad, la línea se parte en dos
    // ítems que difieren en un céntimo: S/ 100 entre 3 = 2 × 33.33 + 1 × 33.34.
    const base = Math.floor(net / qty);
    const rest = net - base * qty;
    // Una línea sin precio unitario —un 2x1, un regalo, o céntimos que no llegan
    // a uno por unidad— es para SUNAT una operación gratuita, con su propio
    // tratamiento. No se decide sola (MOM §35.3). Cubre también la neta <= 0.
    if (base <= 0) return fail("linea_gratuita", lineLabel(title, i));

    const code = lineCode(line);
    if (!code) throw new Unreadable(`${at}.id`);
    if (!title) return fail("sin_boleta", `La línea ${i + 1} no tiene nombre.`);
    const itemName = lineName(title, line.variantTitle);
    if (rest === 0) {
      items.push({ code, name: itemName, qty, priceCents: base });
    } else {
      if (qty - rest > 0) items.push({ code, name: itemName, qty: qty - rest, priceCents: base });
      items.push({ code, name: itemName, qty: rest, priceCents: base + 1 });
    }
  }

  // 3. El envío cobrado es un ítem más. Uno quitado o cambiado después es una
  // edición: lo que se pagó ya no es lo que dice el pedido.
  const shippingNodes = listOf(objOf(o.shippingLines, "shippingLines").nodes, "shippingLines.nodes");
  const shipping = shippingNodes.map((node, i) => objOf(node, `shippingLines.nodes[${i}]`));
  if (shipping.some((s, i) => flagOf(s.isRemoved, `shippingLines.nodes[${i}].isRemoved`))) {
    return fail("envio_editado");
  }
  for (const [i, s] of shipping.entries()) {
    const price = nonNegativeCentsOf(s.discountedPriceSet, `shippingLines.nodes[${i}].discountedPriceSet`);
    if (price === 0) continue; // Envío gratis: no va en la boleta.
    const title = textOf(s.title);
    items.push({
      code: SHIPPING_CODE,
      name: (title ? `${SHIPPING_NAME} - ${title}` : SHIPPING_NAME).slice(0, ITEM_NAME_MAX).trim(),
      qty: 1,
      priceCents: price,
    });
  }

  // 4. El cuadre. Es la red de todo lo de arriba: un campo que no significa lo
  // que creemos, un recargo, un arancel o más de 10 envíos dejan la suma
  // distinta del total, y la boleta no sale.
  const total = centsOf(o.totalPriceSet, "totalPriceSet");
  const current = centsOf(o.currentTotalPriceSet, "currentTotalPriceSet");
  const sum = items.reduce((acc, item) => acc + item.priceCents * item.qty, 0);
  if (sum !== total || sum !== current) {
    return fail(
      "no_cuadra",
      `El detalle suma S/ ${soles(sum)}; Shopify dice S/ ${soles(current)} (al crearse, S/ ${soles(total)}).`,
    );
  }

  // 5. El cobro según Shopify, sin decidir nada. Lo cobrado son las ventas y
  // capturas aprobadas que no son de prueba; una autorización no es dinero. Lo
  // de Flow y lo de cualquier otra pasarela van por separado: la boleta de la
  // cuenta de Flow no puede cubrir lo que cobró otro. Si hubiera más de 20
  // transacciones, se cuenta de menos —nunca de más—, y el neto de Shopify ya
  // no cuadraría con lo de Flow.
  let paidCents = 0;
  let otherPaidCents = 0;
  for (const [i, node] of listOf(o.transactions, "transactions").entries()) {
    const tx = objOf(node, `transactions[${i}]`);
    if (tx.kind !== "SALE" && tx.kind !== "CAPTURE") continue;
    if (tx.status !== "SUCCESS") continue;
    if (flagOf(tx.test, `transactions[${i}].test`)) continue;
    const cents = nonNegativeCentsOf(tx.amountSet, `transactions[${i}].amountSet`);
    if (isFlowTransaction(tx)) paidCents += cents;
    else otherPaidCents += cents;
  }
  // `[String!]!` en el esquema: una entrada que no es texto es una respuesta
  // que no entendemos, no una pasarela que se pueda saltar.
  const gatewayNames = listOf(o.paymentGatewayNames, "paymentGatewayNames").map((n, i) => {
    if (typeof n !== "string") throw new Unreadable(`paymentGatewayNames[${i}]`);
    return n;
  });

  return {
    ok: true,
    orderGid,
    name,
    totalCents: total,
    items,
    payment: {
      financialStatus: typeof o.displayFinancialStatus === "string" ? o.displayFinancialStatus : "",
      gatewayNames,
      paidCents,
      otherPaidCents,
      netPaymentCents: centsOf(o.netPaymentSet, "netPaymentSet"),
      outstandingCents: centsOf(o.totalOutstandingSet, "totalOutstandingSet"),
    },
  };
}

/**
 * El nodo `order` de ORDER_FOR_INVOICE_QUERY → los ítems de la boleta al
 * céntimo, o el primer motivo por el que no se emite. Puro y sin red.
 */
export function mapOrderForInvoice(order: unknown): InvoiceOrderRead {
  if (order === null || order === undefined) return fail("no_encontrado");
  try {
    return mapOrThrow(order);
  } catch (e) {
    if (e instanceof Unreadable) return fail("lectura_fallida", `Shopify devolvió un dato ilegible: ${e.message}.`);
    return fail("lectura_fallida", "No se pudo leer el pedido de Shopify.");
  }
}

/**
 * ¿Shopify confirma que FLOW cobró el total? Para el prepago web, que no deja
 * comprobantes en Kapta (MOM §35.3): pagado; todas las pasarelas del pedido son
 * el checkout de Flow; ni un céntimo aprobado por otra pasarela; lo que cobró
 * Flow igual al total; nada reembolsado de lo neto y nada pendiente. «Pagado»
 * solo no alcanza: un pedido marcado a mano también dice PAID, y uno con Flow y
 * «manual» también. La boleta va al RUC de la cuenta de Flow, así que solo
 * puede cubrir dinero que entró por Flow.
 */
export function webPrepaidConfirmed(read: InvoiceOrderOk): boolean {
  const { payment, totalCents } = read;
  const names: unknown = payment.gatewayNames;
  return (
    totalCents > 0 &&
    payment.financialStatus.trim().toUpperCase() === "PAID" &&
    Array.isArray(names) &&
    names.length > 0 &&
    names.every(isCheckoutGatewayName) &&
    payment.otherPaidCents === 0 &&
    payment.paidCents === totalCents &&
    payment.netPaymentCents === totalCents &&
    payment.outstandingCents === 0
  );
}

// ── La lectura en Shopify ────────────────────────────────────────────────────

/**
 * El dominio y el token de Shopify de la tienda, o null si no tiene conexión.
 * Lanza si la tienda no se pudo leer o el token no se pudo descifrar.
 *
 * Solo esas dos columnas: `getStoreCreds` (lib/ingest.ts) descifra todos los
 * secretos de la tienda —un secreto ajeno roto bloquearía la boleta— y arrastra
 * el módulo de ingesta entero. Además confunde «no se pudo leer» con «no hay
 * tienda», y aquí son motivos distintos: uno se reintenta y el otro no.
 */
async function shopifyConnOf(
  admin: SupabaseClient,
  storeId: string,
): Promise<{ domain: string; token: string } | null> {
  const { data, error } = await admin
    .from("stores")
    .select("shopify_domain,shopify_token_enc")
    .eq("id", storeId)
    .maybeSingle();
  if (error) throw new Error("stores");
  const row = data as { shopify_domain?: string | null; shopify_token_enc?: string | null } | null;
  const domain = (row?.shopify_domain ?? "").trim();
  const token = decryptOrNull(row?.shopify_token_enc ?? null);
  return domain && token ? { domain, token } : null;
}

/**
 * Por qué falló la llamada, en corto y sin nada de la respuesta: el cuerpo de un
 * error puede traer cualquier cosa, y el motivo se guarda y se muestra.
 */
function readFailureDetail(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  const message = e instanceof Error ? e.message : String(e);
  if (name === "TimeoutError" || name === "AbortError") return "Shopify no respondió a tiempo.";
  if (name === "SyntaxError") return "Shopify contestó algo que no se entiende.";
  const http = /^Shopify GraphQL HTTP (\d{3})/.exec(message);
  if (http) return `Shopify contestó HTTP ${http[1]}.`;
  if (message.startsWith("Shopify GraphQL errors")) {
    const code = /"code"\s*:\s*"([A-Z_]{2,40})"/.exec(message);
    return code ? `Shopify devolvió un error (${code[1]}).` : "Shopify devolvió un error de GraphQL.";
  }
  return "No se pudo conectar con Shopify.";
}

/**
 * Lee el pedido en Shopify y lo mapea para su boleta. Nunca lanza: una red
 * caída, un error de GraphQL o un tiempo agotado son `lectura_fallida` (se
 * vuelve a intentar en la próxima pasada); una tienda sin token,
 * `sin_token_shopify`; un pedido que Shopify no devuelve —por ejemplo, uno de
 * más de 60 días sin `read_all_orders`—, `no_encontrado`.
 */
export async function fetchOrderForInvoice(
  input: { storeId: string; shopifyOrderId: string },
  deps: { admin?: SupabaseClient; fetchImpl?: typeof fetch } = {},
): Promise<InvoiceOrderRead> {
  const numericId = numericIdOf(input.shopifyOrderId);
  if (!numericId) return fail("no_encontrado", "El pedido no tiene id de Shopify.");

  let conn: { domain: string; token: string } | null;
  try {
    conn = await shopifyConnOf(deps.admin ?? createAdminSupabase(), input.storeId);
  } catch {
    return fail("lectura_fallida", "No se pudo leer la conexión de la tienda con Shopify.");
  }
  if (!conn) return fail("sin_token_shopify");

  const baseFetch = deps.fetchImpl ?? fetch;
  let data: unknown;
  try {
    data = await shopifyGraphQL<unknown>({
      domain: conn.domain,
      token: conn.token,
      fetchImpl: (url, init) => baseFetch(url, { ...init, signal: AbortSignal.timeout(SHOPIFY_READ_TIMEOUT_MS) }),
      query: ORDER_FOR_INVOICE_QUERY,
      variables: { id: `gid://shopify/Order/${numericId}` },
    });
  } catch (e) {
    return fail("lectura_fallida", readFailureDetail(e));
  }

  // Sin `order` en la respuesta no es «no existe»: es una respuesta que no
  // entendemos. `order: null` sí es que Shopify no lo devolvió.
  if (!data || typeof data !== "object" || !("order" in data)) {
    return fail("lectura_fallida", "Shopify contestó sin el pedido.");
  }
  const read = mapOrderForInvoice((data as { order: unknown }).order);
  if (read.ok && numericIdOf(read.orderGid) !== numericId) {
    return fail("lectura_fallida", "Shopify devolvió otro pedido.");
  }
  return read;
}
