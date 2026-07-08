// Fenix re-routing eligibility gate. Pure + tested. A failed shipment can be
// re-routed to Fenix only when its city is covered AND there's stock of the
// product in that city. Real stock comes from the fenix_stock table; this module
// decides eligibility from a shipment + the relevant stock rows.

import { isFenixCity, normalizeCity } from "./shipments";

export interface FenixStockRow {
  city: string; // normalized coverage key
  product: string;
  sku?: string | null; // exact catalog key when available
  quantity: number;
}

/** A product to check against stock — from the linked Shopify order's line
 *  items (title + sku from the same catalog the stock is keyed on). */
export interface ProductRef {
  title?: string | null;
  sku?: string | null;
}

export interface FenixEligibility {
  eligible: boolean;
  reason: "ok" | "sin_cobertura" | "sin_stock";
  city: string; // normalized
}

function normProduct(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents (cápsulas -> capsulas)
    .trim()
    .toLowerCase();
}

// Generic packaging / format / brand words that carry no identity — dropped
// before token-overlap so a shared "capsulas superhuman" can't fake a match.
const PRODUCT_STOPWORDS = new Set([
  "capsulas", "capsula", "caps", "comprimidos", "tabletas", "softgels", "gomitas",
  "gramos", "gotas", "sachets", "pack", "unidades", "frasco", "ultra", "complex",
  "formula", "superhuman", "para", "con", "del", "los", "las", "por",
]);

/** Distinctive tokens of a product label: alphanumeric words ≥4 chars that
 *  aren't generic packaging/format words. */
function productTokens(s: string): Set<string> {
  return new Set(
    normProduct(s)
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !PRODUCT_STOPWORDS.has(t)),
  );
}

/**
 * Loose product match. First the cheap path: equal, or one label contains the
 * other. Then a token-overlap fallback for real-world naming drift where the
 * report and the stock sheet describe the same product differently — e.g.
 * "8 en 1 Cápsulas - Shilajit Ashwagandha Rhodiola…" vs "8 en 1 Ultra - Cápsulas
 * de Shilajit Ashwagandha Rhodiola … (120 Cápsulas) SuperHuman™": neither
 * contains the other, but they share the distinctive ingredient tokens. Matches
 * when ≥2 distinctive tokens are shared and they cover ≥60% of the shorter
 * label's distinctive tokens.
 */
function productMatches(stockProduct: string, shipmentProduct: string): boolean {
  const a = normProduct(stockProduct);
  const b = normProduct(shipmentProduct);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;

  const ta = productTokens(stockProduct);
  const tb = productTokens(shipmentProduct);
  if (!ta.size || !tb.size) return false;
  let shared = 0;
  for (const t of tb) if (ta.has(t)) shared++;
  return shared >= 2 && shared / Math.min(ta.size, tb.size) >= 0.6;
}

/** True when a stock row covers a product reference: by SKU (exact, naming-
 *  independent) when both sides have one, else by the loose title match. */
export function stockCoversRef(stock: FenixStockRow, ref: ProductRef): boolean {
  const sSku = (stock.sku ?? "").trim().toLowerCase();
  const rSku = (ref.sku ?? "").trim().toLowerCase();
  if (sSku && rSku) return sSku === rSku;
  return productMatches(stock.product, ref.title ?? "");
}

/**
 * Evaluate whether a shipment can be re-routed to Fenix.
 *   - city must be in the covered set (a fenix_stock row for that city exists,
 *     or it's a known FENIX_CITY), AND
 *   - some stock row for that city covers the product with quantity > 0.
 *
 * When the guide is linked to a Shopify order, pass its line items as
 * `orderProducts`: the stock sheet is keyed on the Shopify catalog (title +
 * SKU), so matching against the order is exact — the Aliclik report's free-text
 * `shipment.product` is only a fallback for still-unmatched guides.
 * `stockRows` should already be scoped to the shipment's org and (ideally) city.
 */
export function evaluateFenix(
  shipment: { city?: string | null; product?: string | null },
  stockRows: FenixStockRow[],
  orderProducts?: ProductRef[],
): FenixEligibility {
  const city = normalizeCity(shipment.city);
  const cityRows = stockRows.filter((r) => normalizeCity(r.city) === city);
  const covered = isFenixCity(city) || cityRows.length > 0;
  if (!city || !covered) {
    return { eligible: false, reason: "sin_cobertura", city };
  }
  const refs: ProductRef[] =
    orderProducts && orderProducts.length
      ? orderProducts
      : [{ title: shipment.product ?? null, sku: null }];
  const hasStock = cityRows.some(
    (r) => r.quantity > 0 && refs.some((ref) => stockCoversRef(r, ref)),
  );
  if (!hasStock) {
    return { eligible: false, reason: "sin_stock", city };
  }
  return { eligible: true, reason: "ok", city };
}
