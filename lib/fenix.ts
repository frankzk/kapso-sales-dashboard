// Fenix re-routing eligibility gate. Pure + tested. A failed shipment can be
// re-routed to Fenix only when its city is covered AND there's stock of the
// product in that city. Real stock comes from the fenix_stock table; this module
// decides eligibility from a shipment + the relevant stock rows.

import { deriveFenixCoverageCity, fenixWarehouseKey, isFenixCity, normalizeCity } from "./shipments";

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

export type FenixAvailabilityFilter = "all" | "ok" | "sin_stock" | "sin_cobertura";

/** Puno and Juliaca are distinct delivery locations but draw inventory from
 * the same Fenix warehouse — igual que Chupaca desde Huancayo. Keep the visible
 * city untouched and only collapse the key used to compare stock rows. La tabla
 * de equivalencias vive junto a `FENIX_CITIES` (`FENIX_CITY_ALIASES`), para que
 * cobertura y stock no puedan discrepar. */
export function fenixStockCityKey(city: string | null | undefined): string {
  return fenixWarehouseKey(city);
}

/** Resolves the UI status, including a safe fallback for legacy rows that were
 * loaded without the read-time reason enrichment. */
/**
 * La clave de cobertura de un envío. UNA sola definición, a propósito.
 *
 * Existió repartida en dos: `evaluateFenix` (que decide en la cola, del lado
 * del servidor) leía sólo `city`, y la creación de guía derivaba de la
 * dirección. Con `city` vacía —el alta por la API de Aliclik no la rellena— la
 * pantalla decía «fuera de cobertura» sobre envíos que el despacho aceptaba sin
 * chistar. 234 envíos así, 33 de ellos pendientes, con stock y despachables.
 *
 * `city` manda cuando viene: el courier puede contradecir a Shopify, y esa
 * discrepancia la reporta `localityMismatch()`. Derivar por encima de un dato
 * presente la taparía. Sólo se deriva cuando no hay nada que tapar. Pura.
 */
export function coverageCityOf(shipment: {
  city?: string | null;
  district?: string | null;
  province?: string | null;
}): string {
  const explicit = normalizeCity(shipment.city);
  if (explicit) return explicit;
  return normalizeCity(deriveFenixCoverageCity(shipment.district, shipment.province));
}

/**
 * Las columnas de `shipments` que describen el destino. Se seleccionan JUNTAS o
 * la cobertura miente.
 *
 * `coverageCityOf` sabe derivar la ciudad del distrito, pero solo puede hacerlo
 * con los datos que le pasan: un llamador que selecciona `city` a secas le
 * entrega un destino vacío, y un destino vacío es «fuera de cobertura». Eso pasó
 * —la cola decía «Fenix Ok» sobre un envío que el botón rechazaba— porque la
 * lectura de la cola sí traía el distrito y las rejas de escritura no. Tener el
 * nombre de las columnas en un solo sitio no lo impide, pero deja el olvido a la
 * vista en el diff.
 */
export const FENIX_COVERAGE_COLUMNS = "city,district,province,region";

/** Fila con destino, tal cual sale de `shipments`. */
export interface FenixCoverageRow {
  city?: string | null;
  district?: string | null;
  province?: string | null;
  /** La columna vieja. `province` (migración 0039) llegó después y no todas las
   *  filas la tienen; sin este respaldo, la mitad del histórico pierde la
   *  provincia y con ella la derivación por distrito. */
  region?: string | null;
}

/** Normaliza el destino de una fila a lo que `evaluateFenix` sabe leer,
 *  resolviendo el par `province`/`region` en un solo lugar. Pura. */
export function coverageInputOf<T extends FenixCoverageRow>(
  row: T,
): T & { province: string | null } {
  return { ...row, province: row.province ?? row.region ?? null };
}

/**
 * La razón que se le muestra al operador. Pura.
 *
 * Camino de respaldo: en la cola gana `fenix_reason`, que el servidor calcula
 * con `evaluateFenix`. Los dos resuelven la ciudad con `coverageCityOf`, que
 * es donde vive la regla — separarlos fue el bug.
 */
export function currentFenixReason(shipment: {
  city?: string | null;
  district?: string | null;
  province?: string | null;
  fenix_eligible: boolean;
  fenix_reason?: FenixEligibility["reason"];
}): FenixEligibility["reason"] {
  if (shipment.fenix_reason) return shipment.fenix_reason;
  if (shipment.fenix_eligible) return "ok";
  return isFenixCity(coverageCityOf(shipment)) ? "sin_stock" : "sin_cobertura";
}

export function matchesFenixAvailability(
  shipment: Parameters<typeof currentFenixReason>[0],
  filter: FenixAvailabilityFilter,
): boolean {
  return filter === "all" || currentFenixReason(shipment) === filter;
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
  shipment: {
    city?: string | null;
    /**
     * Se usan SÓLO si `city` viene vacía. El alta por la API de Aliclik no
     * rellena esa columna, y leerla sola convertía «falta el dato» en «no hay
     * cobertura» — dos cosas distintas, y la segunda esconde trabajo
     * despachable. Misma regla y misma función que la creación de guía, para
     * que la cola y el despacho no respondan distinto sobre el mismo envío.
     */
    district?: string | null;
    province?: string | null;
    product?: string | null;
  },
  stockRows: FenixStockRow[],
  orderProducts?: ProductRef[],
): FenixEligibility {
  const city = coverageCityOf(shipment);
  const stockCity = fenixStockCityKey(city);
  const cityRows = stockRows.filter((r) => fenixStockCityKey(r.city) === stockCity);
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

// ── Guías Fenix directas: validación de stock por ítem ──────────────────────

/** A line item to validate against stock (from the Shopify order). */
export interface DirectStockItem {
  title?: string | null;
  sku?: string | null;
  quantity?: number | null;
}

export interface DirectFenixStockCheck {
  ok: boolean;
  reason?: "sin_cobertura" | "sin_stock";
  city: string; // normalized destination
  uncovered: string[]; // titles of items with no stock row covering them
}

/**
 * Creation gate for a DIRECT Fenix guide (no Aliclik parent): unlike
 * evaluateFenix — which passes when ANY product has stock — a direct dispatch
 * leaves the regional warehouse with the complete order, so EVERY line item
 * must be covered by a stock row of the destination city with quantity > 0.
 * Items are matched by exact SKU first (naming-independent), then by the
 * loose title match. Validation only: the stock itself keeps being consumed
 * on delivery (salida_entrega), same as every Fenix guide. Pure.
 */
export function evaluateDirectFenixStock(
  city: string | null | undefined,
  stockRows: FenixStockRow[],
  items: DirectStockItem[],
): DirectFenixStockCheck {
  const normalized = normalizeCity(city);
  const stockCity = fenixStockCityKey(normalized);
  const cityRows = stockRows.filter((r) => fenixStockCityKey(r.city) === stockCity);
  const covered = isFenixCity(normalized) || cityRows.length > 0;
  if (!normalized || !covered) {
    return { ok: false, reason: "sin_cobertura", city: normalized, uncovered: [] };
  }

  const refs: DirectStockItem[] = items.length ? items : [{ title: null, sku: null, quantity: 1 }];
  const available = cityRows.filter((r) => r.quantity > 0);
  const uncovered: string[] = [];
  for (const item of refs) {
    const ref: ProductRef = { title: item.title ?? null, sku: item.sku ?? null };
    const bySku = available.find((r) => {
      const sSku = (r.sku ?? "").trim().toLowerCase();
      const rSku = (ref.sku ?? "").trim().toLowerCase();
      return !!sSku && !!rSku && sSku === rSku;
    });
    const match = bySku ?? available.find((r) => stockCoversRef(r, ref));
    if (!match) uncovered.push(item.title?.trim() || "(producto sin nombre)");
  }
  if (uncovered.length) {
    return { ok: false, reason: "sin_stock", city: normalized, uncovered };
  }
  return { ok: true, city: normalized, uncovered: [] };
}
