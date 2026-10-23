// Historial de Shopify: leer las exportaciones del propio Shopify (MOM §37,
// 23-10-2026).
//
// POR QUÉ. Aurela tiene 177.515 pedidos en Shopify desde 2021 y Kapta solo los
// de junio de 2026 en adelante: la conexión no tiene `read_all_orders`. Con la
// tienda a punto de suspenderse, la vía segura fue exportar desde Shopify (un
// CSV de pedidos por año y uno de clientes) y guardarlo en Kapta como archivo.
//
// EL FORMATO. El CSV de pedidos de Shopify trae UNA FILA POR PRODUCTO: la
// primera fila de cada pedido lleva todo (cliente, dirección, montos, estado) y
// las siguientes solo el número de pedido y su producto. Aquí se juntan en un
// pedido con su lista de productos. Las cabeceras vienen en inglés aunque el
// panel esté en español; se aceptan igual sin importar mayúsculas ni espacios.
// Lo que no se reconoce no se pierde: `raw` guarda la primera fila tal cual.
//
// Pura: la pantalla la corre en el navegador (el archivo puede pesar decenas de
// MB y no pasa por el servidor) y manda los pedidos ya armados por tandas.

import { parseCsvRows } from "@/lib/csv-parse";
import { normalizePhone } from "@/lib/phone";

export type HistoryFileKind = "pedidos" | "clientes" | "productos" | "otro";

export interface HistoryLineItem {
  /** El id de Shopify del producto del pedido; solo lo trae la API (§37.5). */
  id?: string | null;
  name: string;
  sku: string | null;
  quantity: number;
  price: number | null;
  discount: number | null;
  vendor: string | null;
}

export interface HistoryOrder {
  order_name: string;
  shopify_order_id: string | null;
  created_at: string | null;
  paid_at: string | null;
  fulfilled_at: string | null;
  cancelled_at: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  currency: string | null;
  subtotal: number | null;
  shipping: number | null;
  taxes: number | null;
  total: number | null;
  discount_code: string | null;
  discount_amount: number | null;
  refunded_amount: number | null;
  payment_method: string | null;
  email: string | null;
  phone: string | null;
  phone_norm: string | null;
  customer_name: string | null;
  shipping_name: string | null;
  shipping_address1: string | null;
  shipping_address2: string | null;
  shipping_city: string | null;
  shipping_province: string | null;
  shipping_zip: string | null;
  shipping_country: string | null;
  shipping_phone: string | null;
  notes: string | null;
  tags: string | null;
  source: string | null;
  line_items: HistoryLineItem[];
  raw: Record<string, string>;
}

export interface HistoryCustomer {
  customer_key: string;
  shopify_customer_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  phone_norm: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  zip: string | null;
  total_spent: number | null;
  total_orders: number | null;
  accepts_marketing: string | null;
  tags: string | null;
  note: string | null;
  raw: Record<string, string>;
}

/** Cabecera comparable: minúsculas, sin tildes ni espacios de más. */
export function headerKey(header: string): string {
  return header
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** El texto del archivo, sea UTF-8 (con o sin BOM) o UTF-16 (el «CSV para Excel» de algunos Shopify). */
export function decodeExport(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
}

/** El separador de la primera línea: coma, punto y coma o tabulación. */
export function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, Math.max(text.indexOf("\n"), 0) || 2000);
  const counts: [string, number][] = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ",";
}

/** Qué exportación es, por sus cabeceras. */
export function detectKind(headers: readonly string[]): HistoryFileKind {
  const keys = new Set(headers.map(headerKey));
  if (keys.has("name") && (keys.has("lineitem name") || keys.has("lineitem quantity"))) return "pedidos";
  if ((keys.has("total spent") || keys.has("total orders")) && (keys.has("email") || keys.has("customer id"))) return "clientes";
  if (keys.has("handle") && (keys.has("variant sku") || keys.has("title"))) return "productos";
  return "otro";
}

const text = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

/**
 * Ids, celulares y códigos postales: Shopify les antepone un apóstrofo
 * («'7012345678», «'+51987654321») para que Excel no los vuelva números.
 */
const code = (v: string | undefined): string | null => text(text(v)?.replace(/^'+/, ""));

/** «1,234.50», «S/ 99», «99.0» → número; vacío o ilegible → null. */
export function money(v: string | undefined): number | null {
  const t = (v ?? "").replace(/[^\d.,-]/g, "");
  if (!t) return null;
  // Formato de Shopify: punto decimal, coma de miles.
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** «2021-12-31 21:55:31 -0500» → ISO. Vacío o ilegible → null. */
export function shopifyDate(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  if (!t) return null;
  const m = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2}):?(\d{2})?$/);
  const iso = m ? `${m[1]}T${m[2]!.length === 5 ? `${m[2]}:00` : m[2]}${m[3]}:${m[4] ?? "00"}` : t;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Lector de una fila por nombre de cabecera, tolerante a mayúsculas, tildes y espacios. */
function rowReader(headers: readonly string[]) {
  const index = new Map<string, number>();
  headers.forEach((h, i) => {
    const k = headerKey(h);
    if (!index.has(k)) index.set(k, i);
  });
  return (cells: readonly string[], ...names: string[]): string | undefined => {
    for (const name of names) {
      const i = index.get(headerKey(name));
      if (i !== undefined && (cells[i] ?? "").trim() !== "") return cells[i];
    }
    return undefined;
  };
}

/** La fila como objeto, solo con lo que trae (las celdas vacías no ocupan lugar). */
function rawRow(headers: readonly string[], cells: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((h, i) => {
    const v = (cells[i] ?? "").trim();
    if (h.trim() && v) out[h.trim()] = v;
  });
  return out;
}

export interface ParsedExport {
  kind: HistoryFileKind;
  rowsRead: number;
  orders: HistoryOrder[];
  customers: HistoryCustomer[];
}

/** Lee el texto de una exportación de Shopify: pedidos agrupados o clientes. */
export function parseShopifyExport(textContent: string): ParsedExport {
  const delimiter = detectDelimiter(textContent);
  const rows = parseCsvRows(textContent, delimiter);
  const headers = (rows[0] ?? []).map((h) => h.trim());
  const kind = detectKind(headers);
  const body = rows.slice(1).filter((cells) => cells.some((c) => c.trim() !== ""));
  if (kind === "pedidos") return { kind, rowsRead: body.length, orders: groupOrders(headers, body), customers: [] };
  if (kind === "clientes") return { kind, rowsRead: body.length, orders: [], customers: mapCustomers(headers, body) };
  return { kind, rowsRead: body.length, orders: [], customers: [] };
}

function groupOrders(headers: readonly string[], body: readonly string[][]): HistoryOrder[] {
  const get = rowReader(headers);
  const byName = new Map<string, HistoryOrder>();
  for (const cells of body) {
    const name = text(get(cells, "Name"));
    if (!name) continue;
    let order = byName.get(name);
    if (!order) {
      const phone = code(get(cells, "Phone", "Shipping Phone", "Billing Phone"));
      order = {
        order_name: name,
        shopify_order_id: code(get(cells, "Id")),
        created_at: shopifyDate(get(cells, "Created at")),
        paid_at: shopifyDate(get(cells, "Paid at")),
        fulfilled_at: shopifyDate(get(cells, "Fulfilled at")),
        cancelled_at: shopifyDate(get(cells, "Cancelled at")),
        financial_status: text(get(cells, "Financial Status")),
        fulfillment_status: text(get(cells, "Fulfillment Status")),
        currency: text(get(cells, "Currency")),
        subtotal: money(get(cells, "Subtotal")),
        shipping: money(get(cells, "Shipping")),
        taxes: money(get(cells, "Taxes")),
        total: money(get(cells, "Total")),
        discount_code: text(get(cells, "Discount Code")),
        discount_amount: money(get(cells, "Discount Amount")),
        refunded_amount: money(get(cells, "Refunded Amount")),
        payment_method: text(get(cells, "Payment Method")),
        email: text(get(cells, "Email")),
        phone,
        phone_norm: normalizePhone(phone),
        customer_name: text(get(cells, "Billing Name", "Shipping Name")),
        shipping_name: text(get(cells, "Shipping Name")),
        shipping_address1: text(get(cells, "Shipping Address1", "Shipping Street")),
        shipping_address2: text(get(cells, "Shipping Address2")),
        shipping_city: text(get(cells, "Shipping City")),
        shipping_province: text(get(cells, "Shipping Province Name", "Shipping Province")),
        shipping_zip: code(get(cells, "Shipping Zip")),
        shipping_country: text(get(cells, "Shipping Country")),
        shipping_phone: code(get(cells, "Shipping Phone")),
        notes: text(get(cells, "Notes")),
        tags: text(get(cells, "Tags")),
        source: text(get(cells, "Source")),
        line_items: [],
        raw: rawRow(headers, cells),
      };
      byName.set(name, order);
    }
    const itemName = text(get(cells, "Lineitem name"));
    if (itemName) {
      order.line_items.push({
        name: itemName,
        sku: text(get(cells, "Lineitem sku")),
        quantity: Number(get(cells, "Lineitem quantity") ?? "1") || 1,
        price: money(get(cells, "Lineitem price")),
        discount: money(get(cells, "Lineitem discount")),
        vendor: text(get(cells, "Vendor")),
      });
    }
  }
  return [...byName.values()];
}

function mapCustomers(headers: readonly string[], body: readonly string[][]): HistoryCustomer[] {
  const get = rowReader(headers);
  const byKey = new Map<string, HistoryCustomer>();
  for (const cells of body) {
    const id = code(get(cells, "Customer ID", "Id"));
    const email = text(get(cells, "Email"));
    const phone = code(get(cells, "Phone", "Default Address Phone"));
    const phoneNorm = normalizePhone(phone);
    const key = id ?? email?.toLowerCase() ?? phoneNorm;
    if (!key) continue;
    byKey.set(key, {
      customer_key: key,
      shopify_customer_id: id,
      first_name: text(get(cells, "First Name")),
      last_name: text(get(cells, "Last Name")),
      email,
      phone,
      phone_norm: phoneNorm,
      company: text(get(cells, "Default Address Company", "Company")),
      address1: text(get(cells, "Default Address Address1", "Address1")),
      address2: text(get(cells, "Default Address Address2", "Address2")),
      city: text(get(cells, "Default Address City", "City")),
      province: text(get(cells, "Default Address Province Code", "Province", "Province Code")),
      country: text(get(cells, "Default Address Country Code", "Country", "Country Code")),
      zip: code(get(cells, "Default Address Zip", "Zip")),
      total_spent: money(get(cells, "Total Spent")),
      total_orders: Number(get(cells, "Total Orders") ?? "") || null,
      accepts_marketing: text(get(cells, "Accepts Email Marketing", "Accepts Marketing")),
      tags: text(get(cells, "Tags")),
      note: text(get(cells, "Note")),
      raw: rawRow(headers, cells),
    });
  }
  return [...byKey.values()];
}

/** Primera y última fecha de los pedidos, para el resumen del archivo. */
export function dateRange(orders: readonly HistoryOrder[]): { first: string | null; last: string | null } {
  let first: string | null = null;
  let last: string | null = null;
  for (const o of orders) {
    if (!o.created_at) continue;
    if (!first || o.created_at < first) first = o.created_at;
    if (!last || o.created_at > last) last = o.created_at;
  }
  return { first, last };
}

/** Tandas para mandar al servidor sin pasarse del límite de una acción (6 MB). */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Pedidos por tanda: con su `raw` cada pedido pesa ~2–4 KB. */
export const ORDERS_PER_BATCH = 400;
export const CUSTOMERS_PER_BATCH = 1000;

/**
 * Números de pedido únicos para guardar (MOM §37.3). En Shopify dos pedidos
 * distintos pueden tener el mismo número (Aurela, 23-10-2026: la traída por
 * API se detuvo en una tanda con un número repetido). La clave del historial
 * es (tienda, número), así que el segundo se guarda como «#1234 · 5551234567»
 * (su id de Shopify): no se pierde ninguno. El mismo pedido repetido (mismo
 * id) queda una sola vez, con lo último. `existing` es lo ya guardado con esos
 * números: número → id de Shopify.
 */
export function uniqueOrderNames<T extends { order_name: string | null; shopify_order_id: string | null }>(
  rows: readonly T[],
  existing: ReadonlyMap<string, string | null>,
): T[] {
  const byName = new Map<string, T>();
  for (const row of rows) {
    const base = row.order_name;
    if (!base) continue;
    const owner = byName.get(base)?.shopify_order_id ?? existing.get(base) ?? null;
    const taken = byName.has(base) || existing.has(base);
    const other = taken && owner !== null && row.shopify_order_id !== null && owner !== row.shopify_order_id;
    const name = other ? `${base} · ${row.shopify_order_id}` : base;
    byName.set(name, name === base ? row : { ...row, order_name: name });
  }
  return [...byName.values()];
}
