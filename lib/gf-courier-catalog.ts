// Catálogo de una tienda → lista para GF Courier (MOM §29.17). GF solo despacha productos registrados para la tienda
// y cada línea del pedido viaja con su SKU (lib/gf-courier-order.ts), así que GF debe tener EXACTAMENTE los SKU del
// catálogo vivo de la tienda (WooCommerce publicado o Shopify activo, la misma fuente que Envíos → Catálogo de
// productos). Función pura: la lectura del catálogo vive en la ruta /api/stores/[storeId]/gf-catalog.
//
// - Una fila por SKU; el nombre es «título – variante».
// - Una variante sin SKU no se puede pedir a GF: no va en la lista y se cuenta para avisar.
// - Un mismo SKU en dos variantes es un error de catálogo: va una vez y se informa.
export interface GfCatalogSource {
  shopifySku: string | null;
  title: string;
  variantTitle: string | null;
}
export interface GfCatalogExport {
  rows: { sku: string; name: string }[];
  withoutSku: string[];
  repeatedSkus: string[];
}

const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/gu, " ").trim();
const NO_VARIANT = new Set(["default title", "default", "título por defecto"]);

export function gfCatalogName(title: string, variantTitle: string | null): string {
  const t = clean(title), v = clean(variantTitle);
  return (v && !NO_VARIANT.has(v.toLowerCase()) && !t.toLowerCase().includes(v.toLowerCase()) ? `${t} – ${v}` : t).slice(0, 150);
}

export function buildGfCatalogExport(details: Iterable<GfCatalogSource>): GfCatalogExport {
  const bySku = new Map<string, { sku: string; name: string }>(), withoutSku: string[] = [], repeated = new Set<string>();
  for (const d of details) {
    const sku = clean(d.shopifySku), name = gfCatalogName(d.title, d.variantTitle);
    if (!sku || sku.startsWith("__")) { if (name) withoutSku.push(name); continue; }
    const key = sku.toUpperCase();
    if (bySku.has(key)) { repeated.add(sku); continue; }
    bySku.set(key, { sku, name: name || sku });
  }
  const rows = [...bySku.values()].sort((a, b) => a.name.localeCompare(b.name, "es") || a.sku.localeCompare(b.sku));
  return { rows, withoutSku, repeatedSkus: [...repeated] };
}

/** CSV «sku,nombre» que importa GF (Comercios → Catálogo → Importar productos). Sin BOM ni guardas de fórmula: el SKU va tal cual. */
export function gfCatalogCsv(rows: readonly { sku: string; name: string }[]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return ["sku,nombre", ...rows.map((r) => `${cell(r.sku)},${cell(r.name)}`)].join("\r\n") + "\r\n";
}

export interface GfCatalogProduct { merchant_sku: string; sku?: string; name: string; mode?: string; sales_status?: string }
export interface GfCatalogComparison {
  /** SKU de la tienda que GF todavía no tiene: un pedido con ellos respondería SKU_NOT_FOUND. */
  missingInGf: { sku: string; name: string }[];
  /** SKU que GF tiene marcados como Agotado: un pedido con ellos respondería OUT_OF_STOCK. */
  outOfStock: { sku: string; name: string }[];
  /** SKU que GF tiene y la tienda ya no publica (no molestan; se informan). */
  onlyInGf: string[];
}

/** Compara el catálogo vivo de la tienda con el catálogo de la tienda en GF (GET /v1/products), sin distinguir mayúsculas. */
export function compareGfCatalog(store: readonly { sku: string; name: string }[], gf: readonly GfCatalogProduct[]): GfCatalogComparison {
  const key = (s: string) => s.trim().toUpperCase();
  const gfBySku = new Map<string, GfCatalogProduct>();
  for (const p of gf) { gfBySku.set(key(p.merchant_sku), p); if (p.sku) gfBySku.set(key(p.sku), gfBySku.get(key(p.sku)) ?? p); }
  const storeSkus = new Set(store.map((r) => key(r.sku)));
  const missingInGf = store.filter((r) => !gfBySku.has(key(r.sku)));
  const outOfStock = store.filter((r) => gfBySku.get(key(r.sku))?.sales_status === "OUT_OF_STOCK");
  const onlyInGf = gf.filter((p) => !storeSkus.has(key(p.merchant_sku)) && !(p.sku && storeSkus.has(key(p.sku)))).map((p) => p.merchant_sku);
  return { missingInGf, outOfStock, onlyInGf };
}
