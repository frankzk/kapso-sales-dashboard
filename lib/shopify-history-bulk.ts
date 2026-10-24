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
import type {
  HistoryAddress,
  HistoryAttribution,
  HistoryCart,
  HistoryCustomer,
  HistoryLineItem,
  HistoryOrder,
  HistoryProduct,
  HistoryProductImage,
  HistoryVisit,
} from "@/lib/shopify-history";

export type BulkKind = "pedidos" | "clientes" | "productos" | "carritos" | "borradores";
export const BULK_KINDS: readonly BulkKind[] = ["pedidos", "clientes", "productos", "carritos", "borradores"];

/**
 * La versión de la API con que se piden los archivos (§37.6). Fija y probada
 * contra Shopify el 24-10-2026: desde ella el correo y el celular del cliente
 * van en `defaultEmailAddress` y `defaultPhoneNumber`.
 */
export const HISTORY_API_VERSION = "2026-10";

const money = `shopMoney { amount }`;
const visit = `occurredAt source sourceType referrerUrl landingPage utmParameters { campaign content medium source term }`;
const contact = `defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber }`;

/** Todos los pedidos de la tienda, con sus productos, despachos, devoluciones y de dónde vinieron. */
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
        customer { id firstName lastName ${contact} }
        billingAddress { name phone }
        shippingAddress { name address1 address2 city province zip country phone }
        shippingLine { title code source }
        customAttributes { key value }
        fulfillments { createdAt deliveredAt displayStatus status trackingInfo { company number url } }
        refunds { createdAt note totalRefundedSet { ${money} } }
        transactions { kind status processedAt }
        customerJourneySummary { customerOrderIndex daysToConversion firstVisit { ${visit} } lastVisit { ${visit} } }
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

/** Todos los clientes de la tienda, con sus permisos de marketing y sus direcciones. */
export const CUSTOMERS_BULK_QUERY = `{
  customers {
    edges {
      node {
        id firstName lastName note tags numberOfOrders createdAt state
        amountSpent { amount }
        defaultEmailAddress { emailAddress marketingState }
        defaultPhoneNumber { phoneNumber smsMarketingConsent { state } whatsAppMarketingConsent { state } }
        defaultAddress { company address1 address2 city province country zip phone }
        addressesV2 {
          edges { node { id name company address1 address2 city province country zip phone } }
        }
      }
    }
  }
}`;

/** El catálogo completo: variantes, fotos en tamaño original, colecciones y metacampos. */
export const PRODUCTS_BULK_QUERY = `{
  products {
    edges {
      node {
        id handle title status vendor productType tags descriptionHtml createdAt updatedAt publishedAt
        seo { title description }
        options { name values }
        variants {
          edges { node { id title sku barcode price compareAtPrice inventoryQuantity position selectedOptions { name value } } }
        }
        media {
          edges { node { ... on MediaImage { id alt image { url width height } } } }
        }
        collections {
          edges { node { id handle title } }
        }
        metafields {
          edges { node { id namespace key type value } }
        }
      }
    }
  }
}`;

const cartLineItem = `id title variantTitle sku quantity originalUnitPriceSet { ${money} }`;

/** Los carritos abandonados de la web (y los recuperados). */
export const CHECKOUTS_BULK_QUERY = `{
  abandonedCheckouts {
    edges {
      node {
        id name createdAt updatedAt completedAt abandonedCheckoutUrl note discountCodes
        customer { id firstName lastName ${contact} }
        shippingAddress { name phone address1 address2 city province zip country }
        billingAddress { name phone }
        totalPriceSet { shopMoney { amount currencyCode } }
        customAttributes { key value }
        lineItems { edges { node { ${cartLineItem} } } }
      }
    }
  }
}`;

/** Los pedidos borradores: el formulario contra entrega deja uno por cada envío. */
export const DRAFTS_BULK_QUERY = `{
  draftOrders {
    edges {
      node {
        id name status createdAt updatedAt completedAt invoiceUrl tags email phone
        customer { id firstName lastName ${contact} }
        shippingAddress { name phone address1 address2 city province zip country }
        totalPriceSet { shopMoney { amount currencyCode } }
        customAttributes { key value }
        order { name }
        lineItems { edges { node { ${cartLineItem} } } }
      }
    }
  }
}`;

const QUERIES: Record<BulkKind, string> = {
  pedidos: ORDERS_BULK_QUERY,
  clientes: CUSTOMERS_BULK_QUERY,
  productos: PRODUCTS_BULK_QUERY,
  carritos: CHECKOUTS_BULK_QUERY,
  borradores: DRAFTS_BULK_QUERY,
};

export const bulkQueryFor = (kind: BulkKind) => QUERIES[kind];

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
  const phone =
    str(node.phone) ?? str(ship.phone) ?? str(bill.phone) ?? str(customer.defaultPhoneNumber?.phoneNumber) ?? str(customer.phone);
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
    email: str(node.email) ?? str(customer.defaultEmailAddress?.emailAddress) ?? str(customer.email),
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
    shipping_method: str(node.shippingLine?.title),
    fulfillments: ((node.fulfillments ?? []) as AnyNode[]).map((f) => ({
      created_at: iso(f.createdAt),
      delivered_at: iso(f.deliveredAt),
      status: str(f.displayStatus ?? f.status)?.toLowerCase() ?? null,
      tracking: ((f.trackingInfo ?? []) as AnyNode[]).map((t) => ({ company: str(t.company), number: str(t.number), url: str(t.url) })),
    })),
    refunds: ((node.refunds ?? []) as AnyNode[]).map((r) => ({
      created_at: iso(r.createdAt),
      amount: amount(r.totalRefundedSet),
      note: str(r.note),
    })),
    attribution: mapAttribution(node.customerJourneySummary),
  };
}

function mapVisit(v: AnyNode | null | undefined): HistoryVisit | null {
  if (!v) return null;
  const u = (v.utmParameters ?? null) as AnyNode | null;
  return {
    at: iso(v.occurredAt),
    source: str(v.source),
    source_type: str(v.sourceType)?.toLowerCase() ?? null,
    referrer: str(v.referrerUrl),
    landing_page: str(v.landingPage),
    utm: u
      ? { campaign: str(u.campaign), content: str(u.content), medium: str(u.medium), source: str(u.source), term: str(u.term) }
      : null,
  };
}

/** De qué visita o campaña vino la compra; null si Shopify no la registró. */
export function mapAttribution(j: AnyNode | null | undefined): HistoryAttribution | null {
  if (!j) return null;
  const first = mapVisit(j.firstVisit);
  const last = mapVisit(j.lastVisit);
  const index = Number.isFinite(Number(j.customerOrderIndex)) && j.customerOrderIndex != null ? Number(j.customerOrderIndex) : null;
  const days = Number.isFinite(Number(j.daysToConversion)) && j.daysToConversion != null ? Number(j.daysToConversion) : null;
  if (!first && !last && index === null && days === null) return null;
  return { customer_order_index: index, days_to_conversion: days, first_visit: first, last_visit: last };
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
  const phoneNumber = (node.defaultPhoneNumber ?? null) as AnyNode | null;
  const phone = str(phoneNumber?.phoneNumber) ?? str(node.phone) ?? str(addr.phone);
  const orders = Number(node.numberOfOrders);
  return {
    customer_key: id,
    shopify_customer_id: id,
    first_name: str(node.firstName),
    last_name: str(node.lastName),
    email: str(node.defaultEmailAddress?.emailAddress) ?? str(node.email),
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
    accepts_marketing:
      str(node.defaultEmailAddress?.marketingState ?? node.emailMarketingConsent?.marketingState)?.toLowerCase() ?? null,
    tags: join(node.tags),
    note: str(node.note),
    raw: { fuente: "api" },
    sms_marketing: str(phoneNumber?.smsMarketingConsent?.state)?.toLowerCase() ?? null,
    whatsapp_marketing: str(phoneNumber?.whatsAppMarketingConsent?.state)?.toLowerCase() ?? null,
    addresses: [],
    customer_since: iso(node.createdAt),
    account_state: str(node.state)?.toLowerCase() ?? null,
  };
}

function mapAddress(a: AnyNode): HistoryAddress {
  return {
    name: str(a.name),
    company: str(a.company),
    address1: str(a.address1),
    address2: str(a.address2),
    city: str(a.city),
    province: str(a.province),
    country: str(a.country),
    zip: str(a.zip),
    phone: str(a.phone),
  };
}

const gidType = (gid: unknown): string | null => (typeof gid === "string" ? (gid.match(/^gid:\/\/shopify\/([A-Za-z]+)\//)?.[1] ?? null) : null);

/** Clientes de una tanda, con todas sus direcciones (líneas hijas «MailingAddress»). */
export function groupBulkCustomers(lines: readonly JsonlLine[]): HistoryCustomer[] {
  const byGid = new Map<string, HistoryCustomer>();
  for (const { value: v } of lines) {
    const parent = typeof v.__parentId === "string" ? v.__parentId : null;
    if (!parent) {
      const c = gidType(v.id) === "Customer" ? mapBulkCustomer(v) : null;
      if (c) byGid.set(v.id, c);
      continue;
    }
    const c = byGid.get(parent);
    if (c && gidType(v.id) === "MailingAddress") (c.addresses ??= []).push(mapAddress(v));
  }
  return [...byGid.values()];
}

/** Un producto del archivo, sin sus hijos (variantes, fotos, colecciones y metacampos van aparte). */
export function mapBulkProduct(node: AnyNode): HistoryProduct | null {
  const id = gidNumber(node.id);
  if (!id) return null;
  return {
    product_id: id,
    handle: str(node.handle),
    title: str(node.title),
    status: str(node.status)?.toLowerCase() ?? null,
    vendor: str(node.vendor),
    product_type: str(node.productType),
    tags: join(node.tags),
    description_html: typeof node.descriptionHtml === "string" ? node.descriptionHtml : null,
    seo_title: str(node.seo?.title),
    seo_description: str(node.seo?.description),
    created_at: iso(node.createdAt),
    updated_at: iso(node.updatedAt),
    published_at: iso(node.publishedAt),
    options: ((node.options ?? []) as AnyNode[]).map((o) => ({
      name: String(o.name ?? ""),
      values: Array.isArray(o.values) ? o.values.map(String) : [],
    })),
    variants: [],
    collections: [],
    metafields: [],
  };
}

/**
 * Productos de una tanda con sus hijos: variantes, fotos (en su tamaño
 * original), colecciones y metacampos. Las fotos van aparte porque cada una se
 * copia a Storage por su cuenta.
 */
export function groupBulkProducts(lines: readonly JsonlLine[]): { products: HistoryProduct[]; images: HistoryProductImage[] } {
  const byGid = new Map<string, HistoryProduct>();
  const images: HistoryProductImage[] = [];
  const positions = new Map<string, number>();
  for (const { value: v } of lines) {
    const parent = typeof v.__parentId === "string" ? v.__parentId : null;
    if (!parent) {
      const p = gidType(v.id) === "Product" ? mapBulkProduct(v) : null;
      if (p) byGid.set(v.id, p);
      continue;
    }
    const p = byGid.get(parent);
    if (!p) continue;
    switch (gidType(v.id)) {
      case "ProductVariant":
        p.variants.push({
          id: gidNumber(v.id),
          title: str(v.title),
          sku: str(v.sku),
          barcode: str(v.barcode),
          price: amount({ amount: v.price }),
          compare_at_price: amount({ amount: v.compareAtPrice }),
          inventory_quantity: Number.isFinite(Number(v.inventoryQuantity)) && v.inventoryQuantity != null ? Number(v.inventoryQuantity) : null,
          position: Number.isFinite(Number(v.position)) && v.position != null ? Number(v.position) : null,
          options: ((v.selectedOptions ?? []) as AnyNode[]).map((o) => ({ name: String(o.name ?? ""), value: String(o.value ?? "") })),
        });
        break;
      case "MediaImage": {
        const url = str(v.image?.url);
        const imageId = gidNumber(v.id);
        if (!url || !imageId) break;
        const position = (positions.get(p.product_id) ?? 0) + 1;
        positions.set(p.product_id, position);
        images.push({
          image_id: imageId,
          product_id: p.product_id,
          position,
          src_url: url,
          alt: str(v.alt),
          width: Number(v.image?.width) || null,
          height: Number(v.image?.height) || null,
        });
        break;
      }
      case "Collection":
        p.collections.push({ id: gidNumber(v.id), handle: str(v.handle), title: str(v.title) });
        break;
      case "Metafield":
        p.metafields.push({ namespace: str(v.namespace), key: str(v.key), type: str(v.type), value: typeof v.value === "string" ? v.value : null });
        break;
    }
  }
  return { products: [...byGid.values()], images };
}

/** Un carrito abandonado o un borrador del archivo, sin sus productos. */
export function mapBulkCart(node: AnyNode, kind: "carrito" | "borrador"): HistoryCart | null {
  const id = gidNumber(node.id);
  if (!id) return null;
  const ship = (node.shippingAddress ?? {}) as AnyNode;
  const bill = (node.billingAddress ?? {}) as AnyNode;
  const customer = (node.customer ?? {}) as AnyNode;
  const phone = str(node.phone) ?? str(ship.phone) ?? str(bill.phone) ?? str(customer.defaultPhoneNumber?.phoneNumber);
  const raw: Record<string, string> = { fuente: "api" };
  for (const attr of (node.customAttributes ?? []) as AnyNode[]) {
    const k = str(attr.key);
    const v = str(attr.value);
    if (k && v) raw[k.slice(0, 120)] = v.slice(0, 4000);
  }
  const note = str(node.note);
  if (note) raw.note = note.slice(0, 4000);
  const codes = join(node.discountCodes);
  if (codes) raw.discountCodes = codes;
  const customerId = gidNumber(customer.id);
  if (customerId) raw.customerId = customerId;
  const completedAt = iso(node.completedAt);
  return {
    cart_key: `${kind}:${id}`,
    kind,
    name: str(node.name),
    status:
      kind === "carrito"
        ? completedAt
          ? "recuperado"
          : "abandonado"
        : (str(node.status)?.toLowerCase() ?? null),
    created_at: iso(node.createdAt),
    updated_at: iso(node.updatedAt),
    completed_at: completedAt,
    email: str(node.email) ?? str(customer.defaultEmailAddress?.emailAddress),
    phone,
    phone_norm: normalizePhone(phone),
    customer_name: str(ship.name) ?? str(bill.name) ?? str([customer.firstName, customer.lastName].filter(Boolean).join(" ")),
    address1: str(ship.address1),
    address2: str(ship.address2),
    city: str(ship.city),
    province: str(ship.province),
    total: amount(node.totalPriceSet),
    currency: str(node.totalPriceSet?.shopMoney?.currencyCode),
    url: str(node.abandonedCheckoutUrl ?? node.invoiceUrl),
    order_name: str(node.order?.name),
    tags: join(node.tags),
    line_items: [],
    raw,
  };
}

/** Carritos o borradores de una tanda, con sus productos. */
export function groupBulkCarts(lines: readonly JsonlLine[], kind: "carrito" | "borrador"): HistoryCart[] {
  const byGid = new Map<string, HistoryCart>();
  for (const { value: v } of lines) {
    const parent = typeof v.__parentId === "string" ? v.__parentId : null;
    if (!parent) {
      const c = mapBulkCart(v, kind);
      if (c) byGid.set(v.id, c);
      continue;
    }
    const c = byGid.get(parent);
    if (!c) continue;
    const title = str(v.title) ?? "(sin nombre)";
    const variant = str(v.variantTitle);
    c.line_items.push({
      id: typeof v.id === "string" ? v.id.slice(0, 200) : null,
      name: variant && variant !== "Default Title" ? `${title} - ${variant}` : title,
      sku: str(v.sku),
      quantity: Number(v.quantity) || 1,
      price: amount(v.originalUnitPriceSet),
      discount: null,
      vendor: null,
    });
  }
  return [...byGid.values()];
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
