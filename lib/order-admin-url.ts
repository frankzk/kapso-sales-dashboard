// El pedido en el admin de SU tienda (MOM §38.12, 24-10-2026).
//
// POR QUÉ. Desde que Aurela recibe pedidos de WooCommerce, en la misma tienda
// de Kapta conviven pedidos de Shopify y de WooCommerce (§38: una tienda, dos
// fuentes). La flechita del cajón del Master armaba SIEMPRE el enlace de
// Shopify con `shopify_order_id`: para el #AUR900004 (`wc-aur-11076`) abrió
// `admin.shopify.com/store/aurela-peru/orders/11076`, que es otro pedido o
// ninguno. La plataforma la dice `orders.platform`, nunca la forma del id:
// `extractNumericId("wc-aur-11076")` devuelve "11076", que parece de Shopify.
//
// LO QUE FIJA:
//   · la plataforma: `woocommerce` solo si la columna lo dice; sin dato
//     (antes de la 0274, o un select que no la trae), `shopify`, como
//     `orderPlatformOf` (lib/shipment-order-capture.ts);
//   · WooCommerce: `<woo_site_url>/wp-admin/admin.php?page=wc-orders&action=edit&id=<id>`
//     con el id de `wc-<clave>-<id>`. Sin el sitio guardado, o con un id que no
//     es de WooCommerce, NO hay enlace: ninguno antes que uno equivocado;
//   · Shopify: el de siempre (`shopifyOrderAdminUrl`), pero solo con un id de
//     Shopify (los dígitos o su gid). La forma del id no elige la plataforma:
//     solo impide armar un enlace de Shopify con algo que no es suyo
//     (`wc-aur-11076` sin plataforma, o el `draft-<id>` de un borrador).
//
// Puro y sin imports de Node: lo usan los componentes del navegador
// (lib/woocommerce.ts y lib/woocommerce-orders.ts no se pueden importar ahí, y
// reexportan lo de aquí).

import { shopifyOrderAdminUrl } from "@/lib/shopify-urls";
import type { OrderPlatform } from "@/lib/types";

export type OrderPlatformName = "Shopify" | "WooCommerce";

/** Cómo se nombra cada plataforma en pantalla. */
export const ORDER_PLATFORM_NAME: Record<OrderPlatform, OrderPlatformName> = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
};

/**
 * La plataforma de un pedido a partir de `orders.platform`: `woocommerce` solo
 * si lo dice; cualquier otra cosa, también la falta del dato, es `shopify`.
 */
export function orderPlatform(value: unknown): OrderPlatform {
  return value === "woocommerce" ? "woocommerce" : "shopify";
}

/** «Shopify» o «WooCommerce», con la misma regla que `orderPlatform`. */
export function orderPlatformName(value: unknown): OrderPlatformName {
  return ORDER_PLATFORM_NAME[orderPlatform(value)];
}

// ---------------------------------------------------------------------------
// WooCommerce
// ---------------------------------------------------------------------------

const WOO_ORDER_ID_RE = /^wc-([a-z][a-z0-9]{1,11})-([1-9]\d*)$/;

/**
 * Lo contrario de `wooOrderId` (lib/woocommerce.ts): `wc-<clave>-<id>` → la
 * clave del sitio y el id de WooCommerce, o null si el valor no es un id de
 * WooCommerce.
 */
export function parseWooOrderId(value: unknown): { siteKey: string; wooId: string } | null {
  if (typeof value !== "string") return null;
  const m = value.match(WOO_ORDER_ID_RE);
  return m ? { siteKey: m[1]!, wooId: m[2]! } : null;
}

/**
 * El pedido en el admin de WooCommerce (HPOS, que el brief pide). Lo usan el
 * formulario de «Generar pedido» y `orderAdminLink`.
 */
export function wooOrderAdminUrl(siteUrl: string, wooId: number | string): string {
  return `${siteUrl.replace(/\/+$/, "")}/wp-admin/admin.php?page=wc-orders&action=edit&id=${encodeURIComponent(String(wooId))}`;
}

/** La misma forma que exige `stores_woo_site_url_check` (0274): solo https. */
const WOO_SITE_URL_RE = /^https:\/\/[^/?#@\s]+(\/[^?#\s]*)?$/i;

// ---------------------------------------------------------------------------
// El enlace
// ---------------------------------------------------------------------------

/** Un id de pedido de Shopify: los dígitos, o su gid. */
const SHOPIFY_ORDER_ID_RE = /^(?:gid:\/\/shopify\/Order\/)?(\d+)$/;

export interface OrderAdminLink {
  url: string;
  label: "Abrir en Shopify" | "Abrir en WooCommerce";
  platform: OrderPlatform;
  platformName: OrderPlatformName;
}

/**
 * El enlace al pedido en el admin de la plataforma de la que vino, o null si
 * no se puede armar uno correcto. Decide SOLO por `platform`.
 */
export function orderAdminLink(input: {
  /** `orders.platform`; sin dato, Shopify. */
  platform?: OrderPlatform | string | null;
  /** `orders.shopify_order_id` (`7549608558887` o `wc-aur-11076`). */
  shopifyOrderId: string | number | null | undefined;
  /** `stores.shopify_domain`. */
  shopDomain?: string | null;
  /** `stores.woo_site_url`. */
  wooSiteUrl?: string | null;
}): OrderAdminLink | null {
  const platform = orderPlatform(input.platform);
  const id = input.shopifyOrderId == null ? "" : String(input.shopifyOrderId).trim();
  if (platform === "woocommerce") {
    const parsed = parseWooOrderId(id);
    const site = (input.wooSiteUrl ?? "").trim();
    if (!parsed || !WOO_SITE_URL_RE.test(site)) return null;
    return {
      url: wooOrderAdminUrl(site, parsed.wooId),
      label: "Abrir en WooCommerce",
      platform,
      platformName: ORDER_PLATFORM_NAME[platform],
    };
  }
  const shopifyId = id.match(SHOPIFY_ORDER_ID_RE)?.[1];
  const url = shopifyId ? shopifyOrderAdminUrl(input.shopDomain, shopifyId) : null;
  return url ? { url, label: "Abrir en Shopify", platform, platformName: ORDER_PLATFORM_NAME[platform] } : null;
}

// ---------------------------------------------------------------------------
// La fuente del estado
// ---------------------------------------------------------------------------

/**
 * `order_master.status_source` para leer. `shopify` ahí quiere decir «el estado
 * del pedido en su tienda» (lib/order-status.ts lo pone al pendiente y al
 * anulado de todo pedido) y así se sigue guardando; en un pedido de WooCommerce
 * se dice «tienda (WooCommerce)». Lo demás (un courier, `manual`, `system`),
 * tal cual.
 */
export function statusSourceLabel(source: string | null | undefined, platform: unknown): string {
  if (!source) return "—";
  if (source === "shopify" && orderPlatform(platform) === "woocommerce") return "tienda (WooCommerce)";
  return source;
}

// ---------------------------------------------------------------------------
// La nota guardada de la tarea de anulación
// ---------------------------------------------------------------------------

/**
 * La nota que `register_confirmation_attempt_v1` (0122, 0190) guarda en el
 * hecho `confirmation_cancellation_task_created` al cerrar el séptimo día, sea
 * cual sea la tienda del pedido.
 */
export const CANCELLATION_TASK_STORED_NOTE = "Revisar y anular manualmente en Shopify si el cliente no confirmó.";

/**
 * La nota de un hecho de la actividad para leer. Solo cambia esa nota exacta en
 * un pedido de WooCommerce («… en WooCommerce …»): lo guardado no se toca, y
 * una nota escrita por una persona sale tal cual.
 */
export function eventNoteLabel(kind: string, note: string | null | undefined, platform: unknown): string | null {
  if (note == null) return null;
  if (
    kind === "confirmation_cancellation_task_created" &&
    note === CANCELLATION_TASK_STORED_NOTE &&
    orderPlatform(platform) === "woocommerce"
  ) {
    return "Revisar y anular manualmente en WooCommerce si el cliente no confirmó.";
  }
  return note;
}

// ---------------------------------------------------------------------------
// «Pedidos anteriores» de Leads
// ---------------------------------------------------------------------------

/**
 * «Pedidos anteriores» cuando Shopify contestó con los del cliente: esa lista
 * manda (trae también los anulados y los que no pasaron por Kapta), pero no
 * conoce los pedidos de WooCommerce de la misma tienda. Se le suman los locales
 * de WooCommerce (MOM §38.12) y los del historial de Shopify importado que no
 * trajo (MOM §37.7: la consulta en vivo no ve los antiguos), sin repetir número,
 * y quedan los `limit` más nuevos. Sin ninguno de esos, la de Shopify tal cual.
 */
export function mergePriorOrders<
  T extends { name?: string | null; createdAt: string | null; platform?: OrderPlatform; fromHistory?: boolean },
>(shopify: T[], local: T[], limit = 3): T[] {
  const names = new Set(shopify.map((o) => o.name).filter(Boolean));
  const extra = local.filter(
    (o) => o.platform === "woocommerce" || (o.fromHistory === true && !(o.name && names.has(o.name))),
  );
  if (!extra.length) return shopify;
  const at = (o: T) => (o.createdAt ? Date.parse(o.createdAt) || 0 : 0);
  return [...shopify, ...extra].sort((a, b) => at(b) - at(a)).slice(0, limit);
}
