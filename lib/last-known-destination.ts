// «Último destino conocido de esta clienta» (MOM §37.8, owner 30-10-2026).
//
// Un pedido que entra sin dirección (p. ej. del Catálogo de WhatsApp) queda en
// «Por revisar». Si la misma clienta —mismo celular normalizado— ya tiene otro
// pedido con dirección en cualquiera de las tiendas de la organización, el
// cajón la SUGIERE. Nunca se aplica sola: la clienta pudo mudarse, y la
// dirección solo entra al pedido cuando una persona la guarda por «Corregir
// ubicación» (con su auditoría).
//
// Este fichero es la regla pura: qué pedido necesita sugerencia, con qué
// celulares se busca y qué direcciones se ofrecen. Las consultas viven en
// `app/dashboard/pedidos/last-destination-actions.ts`.

import { normalizePhone } from "@/lib/phone";

/** Hasta cuántas direcciones distintas se ofrecen para elegir. */
export const LAST_DESTINATION_MAX = 3;
/** Cuántos pedidos de la clienta se leen por fuente (los más recientes). */
export const LAST_DESTINATION_SCAN = 25;

export type LastDestinationSource = "kapta" | "shopify_pedido" | "shopify_clienta";

export interface LastKnownDestination {
  /** Clave de la dirección (sin tildes, mayúsculas ni signos) para no repetirla. */
  key: string;
  address: string;
  reference: string | null;
  district: string | null;
  province: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  source: LastDestinationSource;
  /** Solo los de Kapta: el pedido se puede abrir. */
  orderId: string | null;
  /** Número del pedido de donde sale (#KP200293); la ficha de clienta no tiene. */
  orderName: string | null;
  storeId: string;
  storeName: string | null;
  /** Fecha del pedido de donde sale; la ficha de clienta no tiene. */
  date: string | null;
  /** El pedido de donde sale está anulado (su dirección sirve igual, pero se dice). */
  cancelled: boolean;
  /** El pedido de donde sale se entregó en esa dirección. */
  delivered: boolean;
}

/** Fila de `order_master` (Kapta) con lo que hace falta para sugerir. */
export interface KaptaDestinationRow {
  order_id: string;
  order_name: string | null;
  store_id: string;
  order_created_at: string | null;
  general_status: string | null;
  address: string | null;
  reference: string | null;
  district: string | null;
  province: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * Fila de `shopify_history_orders` (MOM §37). En Perú Shopify llama `province`
 * al departamento y `city` al distrito; la provincia no viene (la infiere el
 * ubigeo al guardar), y `address2` es la referencia.
 */
export interface ShopifyHistoryDestinationRow {
  order_name: string;
  store_id: string;
  created_at: string | null;
  cancelled_at: string | null;
  fulfilled_at?: string | null;
  shipping_address1: string | null;
  shipping_address2: string | null;
  shipping_city: string | null;
  shipping_province: string | null;
}

/** Ficha de `shopify_history_customers`: su dirección por defecto. */
export interface ShopifyCustomerDestinationRow {
  store_id: string;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
}

/** Lo que el cajón mira del pedido abierto para decidir si sugerir. */
export interface DestinationNeedRow {
  coverage?: string | null;
  region?: string | null;
  district?: string | null;
  address?: string | null;
}

const text = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

/**
 * Solo se sugiere cuando el pedido está «Por revisar» y le falta la región, el
 * distrito o la dirección. Un pedido con su ubicación completa no lleva
 * sugerencia aunque la clienta tenga otra dirección: ya dijo a dónde va.
 */
export function needsDestinationSuggestion(row: DestinationNeedRow): boolean {
  if ((row.coverage ?? "por_revisar") !== "por_revisar") return false;
  return !text(row.region) || !text(row.district) || !text(row.address);
}

/**
 * Los celulares con que se busca en `order_master.customer_phone`: el guardado
 * tal cual, el normalizado (51 + nueve dígitos) y los nueve nacionales. Todos
 * van por el índice de teléfono con un `in`, sin funciones sobre la columna.
 */
export function phoneLookupVariants(raw: string | null | undefined): string[] {
  const out = new Set<string>();
  const stored = text(raw);
  if (stored) out.add(stored);
  const norm = normalizePhone(raw);
  if (norm) {
    out.add(norm);
    if (norm.length === 11 && norm.startsWith("51")) out.add(norm.slice(2));
  }
  return [...out];
}

/** Sin tildes, mayúsculas ni signos: «Av. Grau 123» y «AV GRAU 123» son la misma. */
export function destinationKey(address: string | null, district: string | null): string {
  const norm = (v: string | null) =>
    (v ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return `${norm(address)}|${norm(district)}`;
}

/** Una dirección sirve si trae la calle y al menos el distrito o la región. */
function usable(address: string | null, district: string | null, region: string | null): boolean {
  return Boolean(text(address) && (text(district) || text(region)));
}

const time = (v: string | null) => (v ? Date.parse(v) || 0 : 0);

function distinctNewest(list: LastKnownDestination[], limit: number): LastKnownDestination[] {
  const sorted = [...list].sort((a, b) => time(b.date) - time(a.date));
  const seen = new Set<string>();
  const out: LastKnownDestination[] = [];
  for (const d of sorted) {
    if (seen.has(d.key)) continue;
    seen.add(d.key);
    out.push(d);
    if (out.length >= limit) break;
  }
  return out;
}

export interface PickDestinationsInput {
  kapta: readonly KaptaDestinationRow[];
  shopifyOrders?: readonly ShopifyHistoryDestinationRow[];
  shopifyCustomers?: readonly ShopifyCustomerDestinationRow[];
  /** Nombre de cada tienda de la organización, por id. */
  storeNames?: Readonly<Record<string, string>>;
  /** El pedido abierto: nunca se sugiere a sí mismo. */
  excludeOrderId: string;
  /** Su número, para no tomar su propia copia del historial de Shopify. */
  excludeOrderName?: string | null;
  limit?: number;
}

/**
 * Las direcciones que se sugieren, de la más reciente a la más vieja, sin
 * repetir la misma dirección. Orden de preferencia de las fuentes:
 *
 *   1. Pedidos de Kapta (`order_master`) de las tiendas de la organización.
 *   2. Si Kapta no tiene ninguna que sirva: pedidos del historial de Shopify.
 *   3. Si tampoco: la dirección de la ficha de clienta del historial.
 *
 * Un anulado entra solo si su dirección sirve (y se marca como anulado); el
 * pedido abierto y su copia en el historial nunca entran.
 */
export function pickLastKnownDestinations(input: PickDestinationsInput): LastKnownDestination[] {
  const limit = input.limit ?? LAST_DESTINATION_MAX;
  const names = input.storeNames ?? {};
  const ownName = text(input.excludeOrderName);

  const kapta: LastKnownDestination[] = [];
  const kaptaNames = new Set<string>();
  for (const r of input.kapta) {
    if (r.order_id === input.excludeOrderId) continue;
    if (r.order_name) kaptaNames.add(r.order_name);
    if (!usable(r.address, r.district, r.region)) continue;
    kapta.push({
      key: destinationKey(r.address, r.district),
      address: text(r.address)!,
      reference: text(r.reference),
      district: text(r.district),
      province: text(r.province),
      region: text(r.region),
      latitude: r.latitude != null && r.longitude != null ? r.latitude : null,
      longitude: r.latitude != null && r.longitude != null ? r.longitude : null,
      source: "kapta",
      orderId: r.order_id,
      orderName: r.order_name,
      storeId: r.store_id,
      storeName: names[r.store_id] ?? null,
      date: r.order_created_at,
      cancelled: r.general_status === "anulado",
      delivered: r.general_status === "entregado",
    });
  }
  if (kapta.length) return distinctNewest(kapta, limit);

  const history: LastKnownDestination[] = [];
  for (const r of input.shopifyOrders ?? []) {
    // Manda Kapta: el mismo número ya se miró allí (y el propio pedido, nunca).
    if (r.order_name === ownName || kaptaNames.has(r.order_name)) continue;
    if (!usable(r.shipping_address1, r.shipping_city, r.shipping_province)) continue;
    history.push({
      key: destinationKey(r.shipping_address1, r.shipping_city),
      address: text(r.shipping_address1)!,
      reference: text(r.shipping_address2),
      district: text(r.shipping_city),
      province: null,
      region: text(r.shipping_province),
      latitude: null,
      longitude: null,
      source: "shopify_pedido",
      orderId: null,
      orderName: r.order_name,
      storeId: r.store_id,
      storeName: names[r.store_id] ?? null,
      date: r.created_at,
      cancelled: Boolean(r.cancelled_at),
      delivered: Boolean(r.fulfilled_at) && !r.cancelled_at,
    });
  }
  if (history.length) return distinctNewest(history, limit);

  const customers: LastKnownDestination[] = [];
  for (const r of input.shopifyCustomers ?? []) {
    if (!usable(r.address1, r.city, r.province)) continue;
    customers.push({
      key: destinationKey(r.address1, r.city),
      address: text(r.address1)!,
      reference: text(r.address2),
      district: text(r.city),
      province: null,
      region: text(r.province),
      latitude: null,
      longitude: null,
      source: "shopify_clienta",
      orderId: null,
      orderName: null,
      storeId: r.store_id,
      storeName: names[r.store_id] ?? null,
      date: null,
      cancelled: false,
      delivered: false,
    });
  }
  return distinctNewest(customers, limit);
}

/**
 * La nota que deja el formulario de «Corregir ubicación» al usar una
 * sugerencia: queda en el historial del pedido junto con quién la guardó.
 */
export function destinationNote(d: LastKnownDestination, fmtDay: (iso: string) => string): string {
  const where = [d.orderName, d.storeName, d.date ? fmtDay(d.date) : null].filter(Boolean).join(", ");
  const from =
    d.source === "kapta"
      ? `pedido ${where}`
      : d.source === "shopify_pedido"
        ? `historial de Shopify, pedido ${where}`
        : `ficha de clienta del historial de Shopify${d.storeName ? `, ${d.storeName}` : ""}`;
  return `Último destino conocido de la clienta (${from}).`;
}
