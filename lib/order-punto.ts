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
  /** El total vigente con la forma de Shopify: «89.1», «89.0». */
  amount: string | null;
  /** La nota del pedido, tal cual. */
  note: string | null;
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

/**
 * Un importe con la forma del `Decimal` de Shopify: sin ceros de más, pero
 * nunca sin decimal. «89.10» → «89.1», «89.00» → «89.0», 89 → «89.0». Así sale
 * igual venga del GraphQL («89.1»), del REST («89.10») o del total de Kapta.
 */
export function shopifyDecimal(value: unknown): string | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(n)) return null;
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
  const amount =
    shopifyDecimal(shopMoney(r?.currentTotalPriceSet)) ??
    shopifyDecimal(r?.current_total_price) ??
    shopifyDecimal(shopMoney(r?.totalPriceSet)) ??
    shopifyDecimal(r?.total_price) ??
    shopifyDecimal(fallbackTotal);
  return { address, amount, note: field(r?.note) };
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

/** El texto del Punto, idéntico al del metacampo de Shopify. */
export function orderPuntoText(input: {
  source: OrderPuntoSource | null | undefined;
  storeName: string;
  orderName: string;
  items: readonly { title: string; variant_title?: string | null }[];
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
    `COBRAR ${v(input.source?.amount)} SOLES`,
    v(input.source?.note),
  ].join("\n");
  // La línea en blanco de la plantilla, y por cada producto el salto que deja
  // la etiqueta `{% for %}`, el nombre con dos espacios y el salto de antes del
  // `{% endfor %}`.
  return `${head}\n\n${input.items.map((item) => `\n  ${puntoItemName(item)}\n`).join("")}`;
}
