// El «Punto» del pedido (MOM §25): el texto con el que la operación le pasa un
// pedido al punto de entrega. Hasta ahora lo armaba Shopify, con una plantilla
// Liquid, en el metacampo «Pedido» de cada pedido. Shopify cierra el 28-10-2026
// (MOM §37) y los pedidos de WooCommerce nunca lo tuvieron, así que la ficha lo
// arma con los mismos datos y la misma forma.
//
// La plantilla de Shopify, tal cual (la de Aurela; la de Kenku dice «Pedido de
// Kenku»):
//
//   PUNTO
//   {{order.displayAddress.name}}
//   {{order.displayAddress.address1}}
//   {{order.displayAddress.address2}} - {{order.displayAddress.zip}}
//   {{order.displayAddress.city}} -
//   {{order.displayAddress.phone}}
//   Pedido de Aurela {{order.name}}
//   COBRAR {{order.currentTotalPriceSet.shopMoney.amount}} SOLES
//   {{order.note}}
//
//   {% for lineItems_item in order.lineItems %}
//     {{lineItems_item.name}}
//   {% endfor %}
//
// Se reproduce CARÁCTER POR CARÁCTER, con los « - » sueltos y las líneas en
// blanco incluidas: quien lo recibe ya lo lee así. La prueba lo compara con el
// metacampo real de #KP143817 y con el de #AUR178593.
//
// DOS DIFERENCIAS CON LA PLANTILLA, a propósito (decisión del owner,
// 25-10-2026):
//   · «COBRAR» es el SALDO, no el total: el total vigente menos lo ya pagado y
//     validado (un adelanto por Yape), con la misma regla que usa la ruta del
//     motorizado (`collectionBalance`, lib/route-collection.ts); pagado en la web,
//     0. La plantilla de Shopify ponía el total aunque hubiera adelanto, y el
//     punto cobraba de más.
//   · Cada producto lleva su cantidad: «  2 x Producto». Con solo el nombre, un
//     pack de dos se leía como uno.

import type { OrderPaymentFacts } from "@/lib/order-paid";
import { collectionBalance } from "@/lib/route-collection";

/** `order.displayAddress` de Shopify: la de envío; sin ella, la de facturación. */
export interface PuntoAddress {
  name: string | null;
  address1: string | null;
  address2: string | null;
  zip: string | null;
  city: string | null;
  phone: string | null;
}

/** Lo que el Punto saca de `orders.raw`. Se arma en el servidor, sin el raw. */
export interface OrderPuntoSource {
  address: PuntoAddress | null;
  /** El total vigente del pedido (el de la plantilla de Shopify). */
  total: number | null;
  /** La nota del pedido, tal cual. */
  note: string | null;
}

/** Lo que el punto cobra (`puntoCollect`). */
export interface PuntoCollect {
  /** El saldo: lo que se cobra en la entrega. Null si los pagos no se pudieron leer. */
  amount: number | null;
  /** Lo ya pagado y validado (o el total, si se pagó en la web). */
  paid: number;
  /** Comprobantes por validar: no se restan, pero si se validan el saldo baja. */
  pending: number;
}

type Obj = Record<string, unknown>;

function record(value: unknown): Obj | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
}

// Liquid imprime el valor como viene; solo se descarta lo que no es texto. El
// código postal de WooCommerce puede llegar como número.
function field(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function puntoAddress(value: unknown): PuntoAddress | null {
  const a = record(value);
  if (!a) return null;
  const address: PuntoAddress = {
    name: field(a.name),
    address1: field(a.address1),
    address2: field(a.address2),
    zip: field(a.zip),
    city: field(a.city),
    phone: field(a.phone),
  };
  return Object.values(address).some((v) => v !== null && v.trim() !== "") ? address : null;
}

/** Un importe como número, venga como número o como texto. */
function money(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Un importe con la forma del `Decimal` de Shopify: sin ceros de más, pero
 * nunca sin decimal. «89.10» → «89.1», «89.00» → «89.0», 89 → «89.0». Así sale
 * igual venga del GraphQL («89.1»), del REST («89.10») o del total de Kapta.
 */
export function shopifyDecimal(value: unknown): string | null {
  const n = money(value);
  if (n === null) return null;
  const text = String(Math.round(n * 100) / 100);
  return text.includes(".") ? text : `${text}.0`;
}

function shopMoney(value: unknown): unknown {
  return record(record(value)?.shopMoney)?.amount;
}

/**
 * Lo que el Punto necesita del pedido, leído de `orders.raw` en cualquiera de
 * sus formas: GraphQL (`shippingAddress`, `currentTotalPriceSet`), REST
 * (`shipping_address`, `current_total_price`) o WooCommerce, que se guarda con
 * la forma REST. `fallbackTotal` es el total de Kapta, para un raw sin total.
 */
export function orderPuntoSource(raw: unknown, fallbackTotal?: number | string | null): OrderPuntoSource {
  const r = record(raw);
  const address =
    puntoAddress(r?.shippingAddress) ??
    puntoAddress(r?.shipping_address) ??
    puntoAddress(r?.billingAddress) ??
    puntoAddress(r?.billing_address);
  // El total VIGENTE, como en la plantilla: si el pedido se editó o se
  // reembolsó una parte, es el que cuenta. El original solo si no hay otro.
  const total =
    money(shopMoney(r?.currentTotalPriceSet)) ??
    money(r?.current_total_price) ??
    money(shopMoney(r?.totalPriceSet)) ??
    money(r?.total_price) ??
    money(fallbackTotal);
  return { address, total, note: field(r?.note) };
}

/**
 * Lo que cobra el punto: el saldo del pedido, con la regla de la ruta del
 * motorizado (`collectionBalance`): el total menos los pagos de la clienta ya
 * validados —nunca la rendición de un courier ni uno rechazado—, y 0 si lo cobró
 * el checkout. Sin pagos legibles (`payments` null) no se adivina: ni cero ni el
 * total, y la ficha lo avisa.
 */
export function puntoCollect(
  total: number | null,
  facts: OrderPaymentFacts,
  payments: readonly { kind: string; amount: number | null; validation_status: string }[] | null,
): PuntoCollect {
  if (!payments) return { amount: null, paid: 0, pending: 0 };
  const balance = collectionBalance(total, facts, payments);
  return { amount: balance.remaining, paid: balance.validated, pending: balance.pending };
}

/**
 * La marca para «Pedido de …». La tienda se llama «Kenku Peru» en Kapta, pero
 * el Punto de Shopify dice «Pedido de Kenku»: el país sobra.
 */
export function puntoBrand(storeName: string): string {
  return storeName.replace(/\s+per[uú]$/i, "").trim();
}

/** `lineItem.name` de Shopify: «Producto - Variante»; la variante única («Default Title») no se pone. */
export function puntoItemName(item: { title: string; variant_title?: string | null }): string {
  const variant = item.variant_title?.trim();
  return variant && variant.toLowerCase() !== "default title" ? `${item.title} - ${variant}` : item.title;
}

/** Una línea de producto: «2 x Producto - Variante». Sin cantidad legible, solo el nombre. */
export function puntoItemLine(item: { title: string; variant_title?: string | null; quantity?: number | null }): string {
  const q = item.quantity;
  return typeof q === "number" && Number.isFinite(q) && q > 0 ? `${q} x ${puntoItemName(item)}` : puntoItemName(item);
}

/** El texto del Punto: el del metacampo de Shopify, con el saldo y las cantidades. */
export function orderPuntoText(input: {
  source: OrderPuntoSource | null | undefined;
  /** Lo que se cobra (`puntoCollect`). */
  collect: PuntoCollect | null | undefined;
  storeName: string;
  orderName: string;
  items: readonly { title: string; variant_title?: string | null; quantity?: number | null }[];
  /**
   * El teléfono del cliente en Kapta. Solo si la dirección no trae uno: sin
   * teléfono el punto no puede avisar, y Shopify ahí dejaba la línea vacía.
   */
  fallbackPhone?: string | null;
}): string {
  const address = input.source?.address ?? null;
  const v = (value: string | null | undefined) => value ?? "";
  const phone = address?.phone?.trim() ? address.phone : input.fallbackPhone;
  const head = [
    "PUNTO",
    v(address?.name),
    v(address?.address1),
    `${v(address?.address2)} - ${v(address?.zip)}`,
    `${v(address?.city)} - `,
    v(phone),
    `Pedido de ${puntoBrand(input.storeName)} ${input.orderName}`,
    `COBRAR ${v(shopifyDecimal(input.collect?.amount))} SOLES`,
    v(input.source?.note),
  ].join("\n");
  // La línea en blanco de la plantilla, y por cada producto el salto que deja
  // la etiqueta `{% for %}`, la línea con dos espacios y el salto de antes del
  // `{% endfor %}`. Una línea que el pedido quitó (cantidad 0) no se cobra ni
  // se entrega: no va.
  const items = input.items.filter((item) => !(typeof item.quantity === "number" && item.quantity <= 0));
  return `${head}\n\n${items.map((item) => `\n  ${puntoItemLine(item)}\n`).join("")}`;
}
