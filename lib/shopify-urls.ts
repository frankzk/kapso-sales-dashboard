// Pure Shopify id/URL helpers with no Node-only imports, so client components
// can use them directly (lib/shopify.ts pulls in node:crypto and must stay
// server-side). lib/shopify.ts re-exports everything here for back-compat.

/** Extract the trailing numeric id from a Shopify GID or pass numbers through. */
export function extractNumericId(
  gid: string | number | null | undefined,
): string {
  if (gid == null) return "";
  const s = String(gid);
  const m = s.match(/(\d+)\s*$/);
  return m?.[1] ?? s;
}

/**
 * Admin deep-link for a Shopify resource, e.g.
 * `https://admin.shopify.com/store/<handle>/<resource>/<numericId>`. The handle
 * is the myshopify subdomain. Returns null if we can't build a valid link.
 */
function shopifyAdminResourceUrl(
  domain: string | null | undefined,
  resource: "orders" | "draft_orders",
  gidOrId: string | number | null | undefined,
): string | null {
  const id = extractNumericId(gidOrId);
  if (!domain || !id) return null;
  const handle = String(domain).trim().toLowerCase().replace(/\.myshopify\.com$/i, "");
  if (!handle) return null;
  return `https://admin.shopify.com/store/${handle}/${resource}/${id}`;
}

/** Admin deep-link for an order (`…/orders/<id>`). */
export function shopifyOrderAdminUrl(
  domain: string | null | undefined,
  gidOrId: string | number | null | undefined,
): string | null {
  return shopifyAdminResourceUrl(domain, "orders", gidOrId);
}

/**
 * Admin deep-link for a draft order (`…/draft_orders/<id>`) — where "Ver
 * borrador en Shopify" points, instead of the customer-facing `invoiceUrl`
 * checkout page.
 */
export function shopifyDraftOrderAdminUrl(
  domain: string | null | undefined,
  gidOrId: string | number | null | undefined,
): string | null {
  return shopifyAdminResourceUrl(domain, "draft_orders", gidOrId);
}
