// Fenix re-routing eligibility gate. Pure + tested. A failed shipment can be
// re-routed to Fenix only when its city is covered AND there's stock of the
// product in that city. Real stock comes from the fenix_stock table; this module
// decides eligibility from a shipment + the relevant stock rows.

import { isFenixCity, normalizeCity } from "./shipments";

export interface FenixStockRow {
  city: string; // normalized coverage key
  product: string;
  quantity: number;
}

export interface FenixEligibility {
  eligible: boolean;
  reason: "ok" | "sin_cobertura" | "sin_stock";
  city: string; // normalized
}

function normProduct(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/** Loose product match: equal, or one label contains the other (handles the
 *  report's long product strings vs. a short stock label). */
function productMatches(stockProduct: string, shipmentProduct: string): boolean {
  const a = normProduct(stockProduct);
  const b = normProduct(shipmentProduct);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Evaluate whether a shipment can be re-routed to Fenix.
 *   - city must be in the covered set (a fenix_stock row for that city exists,
 *     or it's a known FENIX_CITY), AND
 *   - some stock row for that city loosely matches the product with quantity > 0.
 * `stockRows` should already be scoped to the shipment's org and (ideally) city.
 */
export function evaluateFenix(
  shipment: { city?: string | null; product?: string | null },
  stockRows: FenixStockRow[],
): FenixEligibility {
  const city = normalizeCity(shipment.city);
  const cityRows = stockRows.filter((r) => normalizeCity(r.city) === city);
  const covered = isFenixCity(city) || cityRows.length > 0;
  if (!city || !covered) {
    return { eligible: false, reason: "sin_cobertura", city };
  }
  const hasStock = cityRows.some(
    (r) => r.quantity > 0 && productMatches(r.product, shipment.product ?? ""),
  );
  if (!hasStock) {
    return { eligible: false, reason: "sin_stock", city };
  }
  return { eligible: true, reason: "ok", city };
}
