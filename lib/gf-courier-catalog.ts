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
