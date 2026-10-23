// Historial de Shopify por API (MOM §37.5): la «bulk operation» de Shopify y la
// lectura de su archivo. Pura: el servidor la usa por tandas.
//
// CÓMO FUNCIONA. Kapta le pide a Shopify todos los pedidos (o clientes) con
// `bulkOperationRunQuery`. Shopify arma un archivo JSONL —una línea por
// objeto— y da su URL. En el archivo, los productos de cada pedido van en
// líneas propias con `__parentId`, DESPUÉS de su pedido. Kapta lo lee desde el
// byte donde quedó la tanda anterior y corta siempre justo antes de un pedido
// nuevo, así ningún pedido queda partido entre dos tandas.
//
// Lo que se guarda es lo mismo que deja un CSV (lib/shopify-history.ts) y va
// a las mismas tablas: con la misma clave, la API y el CSV se pisan, no se
// duplican.

import { normalizePhone } from "@/lib/phone";
import type { HistoryCustomer, HistoryLineItem, HistoryOrder } from "@/lib/shopify-history";

export type BulkKind = "pedidos" | "clientes";

const money = `shopMoney { amount }`;

/** Todos los pedidos de la tienda, con sus productos. */
export const ORDERS_BULK_QUERY = `{
  orders {
    edges {
      node {
        id name createdAt processedAt closedAt cancelledAt cancelReason
        displayFinancialStatus displayFulfillmentStatus currencyCode
        subtotalPriceSet { ${money} }
        totalShippingPriceSet { ${money} }
        totalTaxSet { ${money} }
        totalPriceSet { ${money} }
        totalDiscountsSet { ${money} }
        totalRefundedSet { ${money} }
        discountCodes paymentGatewayNames
        email phone note tags sourceName
        customer { id firstName lastName email phone }
        billingAddress { name phone }
        shippingAddress { name address1 address2 city province zip country phone }
        customAttributes { key value }
        fulfillments { createdAt }
        transactions { kind status processedAt }
        lineItems {
          edges {
            node {
              id name sku quantity vendor
              originalUnitPriceSet { ${money} }
              totalDiscountSet { ${money} }
            }
          }
        }
      }
    }
  }
}`;

/** Todos los clientes de la tienda. */
export const CUSTOMERS_BULK_QUERY = `{
  customers {
    edges {
      node {
        id firstName lastName email phone note tags numberOfOrders
        amountSpent { amount }
        emailMarketingConsent { marketingState }
        defaultAddress { company address1 address2 city province country zip phone }
      }
    }
  }
}`;

export const bulkQueryFor = (kind: BulkKind) => (kind === "pedidos" ? ORDERS_BULK_QUERY : CUSTOMERS_BULK_QUERY);

/** «gid://shopify/Order/123» → «123». */
export function gidNumber(gid: unknown): string | null {
  if (typeof gid !== "string") return null;
  const m = gid.match(/\/(\d+)$/);
  return m ? m[1]! : null;
}

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t : null;
};

const amount = (v: unknown): number | null => {
  const raw = (v as { shopMoney?: { amount?: unknown }; amount?: unknown } | null | undefined);
  const a = raw?.shopMoney?.amount ?? raw?.amount;
  if (a == null || a === "") return null;
  const n = Number(a);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

const iso = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const join = (v: unknown, sep = ", "): string | null =>
  Array.isArray(v) ? str(v.map((x) => String(x)).filter(Boolean).join(sep)) : str(v);

type AnyNode = Record<string, any>;

/** Un pedido del archivo de Shopify → el mismo pedido del historial que deja el CSV. */
export function mapBulkOrder(node: AnyNode): HistoryOrder {
  const ship = (node.shippingAddress ?? {}) as AnyNode;
  const bill = (node.billingAddress ?? {}) as AnyNode;
  const customer = (node.customer ?? {}) as AnyNode;
  const phone = str(node.phone) ?? str(ship.phone) ?? str(bill.phone) ?? str(customer.phone);
  const customerName = str(bill.name) ?? str(ship.name) ?? str([customer.firstName, customer.lastName].filter(Boolean).join(" "));
  const fulfilledAt = ((node.fulfillments ?? []) as AnyNode[])
    .map((f) => iso(f.createdAt))
    .filter((d): d is string => !!d)
    .sort()[0] ?? null;
  const paidAt = ((node.transactions ?? []) as AnyNode[])
    .filter((t) => (t.kind === "SALE" || t.kind === "CAPTURE") && t.status === "SUCCESS")
    .map((t) => iso(t.processedAt))
    .filter((d): d is string => !!d)
    .sort()[0] ?? null;
  const raw: Record<string, string> = { fuente: "api" };
  for (const attr of (node.customAttributes ?? []) as AnyNode[]) {
    const k = str(attr.key);
    const v = str(attr.value);
    if (k && v) raw[k.slice(0, 120)] = v.slice(0, 4000);
  }
  for (const [k, v] of [
    ["processedAt", node.processedAt],
    ["closedAt", node.closedAt],
    ["cancelReason", node.cancelReason],
    ["customerId", gidNumber(customer.id)],
  ] as const) {
    const s = str(v);
    if (s) raw[k] = s;
  }
  return {
    order_name: str(node.name) ?? "",
    shopify_order_id: gidNumber(node.id),
    created_at: iso(node.createdAt),
    paid_at: paidAt,
    fulfilled_at: fulfilledAt,
    cancelled_at: iso(node.cancelledAt),
    financial_status: str(node.displayFinancialStatus)?.toLowerCase() ?? null,
    fulfillment_status: str(node.displayFulfillmentStatus)?.toLowerCase() ?? null,
    currency: str(node.currencyCode),
    subtotal: amount(node.subtotalPriceSet),
    shipping: amount(node.totalShippingPriceSet),
    taxes: amount(node.totalTaxSet),
    total: amount(node.totalPriceSet),
    discount_code: join(node.discountCodes),
    discount_amount: amount(node.totalDiscountsSet),
    refunded_amount: amount(node.totalRefundedSet),
    payment_method: join(node.paymentGatewayNames, " + "),
    email: str(node.email) ?? str(customer.email),
    phone,
    phone_norm: normalizePhone(phone),
    customer_name: customerName,
    shipping_name: str(ship.name),
    shipping_address1: str(ship.address1),
    shipping_address2: str(ship.address2),
    shipping_city: str(ship.city),
    shipping_province: str(ship.province),
    shipping_zip: str(ship.zip),
    shipping_country: str(ship.country),
    shipping_phone: str(ship.phone),
    notes: str(node.note),
    tags: join(node.tags),
    source: str(node.sourceName),
    line_items: [],
    raw,
  };
}

/** Un producto del archivo → un producto del pedido. */
export function mapBulkLineItem(node: AnyNode): HistoryLineItem {
  return {
    id: gidNumber(node.id),
    name: str(node.name) ?? "(sin nombre)",
    sku: str(node.sku),
    quantity: Number(node.quantity) || 1,
    price: amount(node.originalUnitPriceSet),
    discount: amount(node.totalDiscountSet),
    vendor: str(node.vendor),
  };
}

/** Un cliente del archivo → el mismo cliente que deja el CSV (clave: su id). */
export function mapBulkCustomer(node: AnyNode): HistoryCustomer | null {
  const id = gidNumber(node.id);
  if (!id) return null;
  const addr = (node.defaultAddress ?? {}) as AnyNode;
  const phone = str(node.phone) ?? str(addr.phone);
  const orders = Number(node.numberOfOrders);
  return {
    customer_key: id,
    shopify_customer_id: id,
    first_name: str(node.firstName),
    last_name: str(node.lastName),
    email: str(node.email),
    phone,
    phone_norm: normalizePhone(phone),
    company: str(addr.company),
    address1: str(addr.address1),
    address2: str(addr.address2),
    city: str(addr.city),
    province: str(addr.province),
    country: str(addr.country),
    zip: str(addr.zip),
    total_spent: amount(node.amountSpent),
    total_orders: Number.isFinite(orders) ? orders : null,
    accepts_marketing: str(node.emailMarketingConsent?.marketingState)?.toLowerCase() ?? null,
    tags: join(node.tags),
    note: str(node.note),
    raw: { fuente: "api" },
  };
}

/** Una línea del archivo, con el byte donde empieza. */
export interface JsonlLine {
  start: number;
  end: number;
  value: AnyNode;
}

/**
 * Corta el pedazo leído en líneas completas. Lo que queda después del último
 * salto de línea vuelve como `rest`, para pegarlo al pedazo siguiente. Una
 * línea que no es JSON se salta (cuenta en `bad`).
 */
export function splitJsonl(buffer: Uint8Array, baseOffset: number): { lines: JsonlLine[]; rest: Uint8Array; bad: number } {
  const decoder = new TextDecoder("utf-8");
  const lines: JsonlLine[] = [];
  let bad = 0;
  let lineStart = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== 0x0a) continue;
    const text = decoder.decode(buffer.subarray(lineStart, i)).trim();
    if (text) {
      try {
        lines.push({ start: baseOffset + lineStart, end: baseOffset + i + 1, value: JSON.parse(text) });
      } catch {
        bad++;
      }
    }
    lineStart = i + 1;
  }
  return { lines, rest: buffer.slice(lineStart), bad };
}

/** ¿Es un objeto de primer nivel (un pedido o un cliente), no un hijo? */
export const isTopLevel = (line: JsonlLine) => !("__parentId" in line.value);

/**
 * Junta las líneas de una tanda en pedidos con sus productos. Un producto
 * cuyo pedido no está en la tanda vuelve en `orphans` (por id de pedido) para
 * sumarlo al pedido ya guardado.
 */
export function groupBulkOrders(lines: readonly JsonlLine[]): {
  orders: HistoryOrder[];
  orphans: Map<string, HistoryLineItem[]>;
} {
  const byGid = new Map<string, HistoryOrder>();
  const orphans = new Map<string, HistoryLineItem[]>();
  for (const line of lines) {
    const v = line.value;
    const parent = typeof v.__parentId === "string" ? v.__parentId : null;
    if (!parent) {
      if (typeof v.id === "string" && v.id.includes("/Order/")) {
        const order = mapBulkOrder(v);
        if (order.order_name) byGid.set(v.id, order);
      }
      continue;
    }
    if (!(typeof v.id === "string" && v.id.includes("/LineItem/"))) continue;
    const item = mapBulkLineItem(v);
    const order = byGid.get(parent);
    if (order) {
      order.line_items.push(item);
    } else {
      const key = gidNumber(parent);
      if (key) orphans.set(key, [...(orphans.get(key) ?? []), item]);
    }
  }
  return { orders: [...byGid.values()], orphans };
}

/** Suma productos a los que ya tenía el pedido, sin repetir los que ya estaban. */
export function mergeLineItems(current: readonly HistoryLineItem[], extra: readonly HistoryLineItem[]): HistoryLineItem[] {
  const seen = new Set(current.map((li) => li.id).filter(Boolean));
  return [...current, ...extra.filter((li) => !li.id || !seen.has(li.id))];
}

/** El estado de Shopify de una bulk operation → qué hace Kapta. */
export function bulkOutcome(status: string | null | undefined): "esperar" | "listo" | "fallo" {
  if (status === "COMPLETED") return "listo";
  if (status === "FAILED" || status === "CANCELED" || status === "CANCELING" || status === "EXPIRED") return "fallo";
  return "esperar";
}

/** Shopify deja leer por API solo los últimos 60 días sin `read_all_orders`. */
export const SHOPIFY_DEFAULT_ORDERS_WINDOW_DAYS = 60;

/**
 * ¿El token ve TODOS los pedidos de la tienda? (§37.5) Sí si tiene
 * `read_all_orders`, o si el pedido más antiguo que alcanza es de antes de la
 * ventana de 60 días. No se mira «antes de 2022»: Kenku Peru abrió en 2023 y
 * su #1001 es del 14-04-2023, así que no tiene nada antes de 2022 aunque el
 * token vea todo.
 */
export function hasFullOrderAccess(input: { scopes: readonly string[]; oldestCreatedAt: string | null; now: Date }): boolean {
  if (input.scopes.includes("read_all_orders")) return true;
  if (!input.oldestCreatedAt) return false;
  const oldest = Date.parse(input.oldestCreatedAt);
  const windowStart = input.now.getTime() - (SHOPIFY_DEFAULT_ORDERS_WINDOW_DAYS + 1) * 86_400_000;
  return Number.isFinite(oldest) && oldest < windowStart;
}
