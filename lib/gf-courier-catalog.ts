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

// ---- Sincronización (owner, 16-11-2026): lo que la tienda vende en Kapta existe en GF, sin importar archivos ----
// GF recibe POST /v1/products/batch (permiso catalogue:write) por SKU: crea lo nuevo sin conteo, actualiza nombre y
// disponibilidad, nunca borra ni toca el modo o el conteo. Kapta manda solo lo que falta o cambió.

export interface GfSyncItem { sku: string; name: string; sales_status: "IN_STOCK" | "OUT_OF_STOCK" }
export interface GfSyncPlan {
  /** SKU que GF no tiene: se crean «En existencias». */
  create: GfSyncItem[];
  /** SKU que GF tiene con otro nombre: se renombran conservando la disponibilidad que tenga en GF. */
  rename: GfSyncItem[];
  /** SKU sin conteo que la tienda ya no publica y GF tiene «En existencias»: pasan a «Agotado». */
  discontinue: GfSyncItem[];
  /** Por qué no se marcó nada como Agotado, si se frenó. */
  discontinueSkipped: string | null;
}
/** Tope de seguridad: si «dejó de vender» supera esta parte del catálogo en GF, lo más probable es una lectura incompleta. */
export const GF_DISCONTINUE_MAX_SHARE = 0.3;
/** GF admite hasta 200 productos por llamada. */
export const GF_BATCH_SIZE = 200;

/**
 * Qué mandar a GF. `partial`: la lectura del catálogo de la tienda tuvo problemas; entonces no se marca nada como
 * Agotado (una lectura a medias no es «dejó de vender»). Tampoco si son demasiados de golpe.
 * Solo se agotan productos sin conteo (UNBOUNDED): los de stock físico los gobierna el inventario de GF.
 */
export function planGfCatalogSync(store: readonly { sku: string; name: string }[], gf: readonly GfCatalogProduct[], opts: { partial?: boolean } = {}): GfSyncPlan {
  const key = (s: string) => s.trim().toUpperCase();
  const gfBySku = new Map<string, GfCatalogProduct>();
  for (const p of gf) gfBySku.set(key(p.merchant_sku), p);
  const storeSkus = new Set(store.map((r) => key(r.sku)));
  const create: GfSyncItem[] = [], rename: GfSyncItem[] = [];
  for (const r of store) {
    const g = gfBySku.get(key(r.sku));
    if (!g) create.push({ sku: r.sku, name: r.name, sales_status: "IN_STOCK" });
    else if (g.name.trim() !== r.name.trim()) rename.push({ sku: g.merchant_sku, name: r.name, sales_status: g.sales_status === "OUT_OF_STOCK" ? "OUT_OF_STOCK" : "IN_STOCK" });
  }
  const gone = gf.filter((p) => !storeSkus.has(key(p.merchant_sku)) && p.mode === "UNBOUNDED" && p.sales_status !== "OUT_OF_STOCK")
    .map((p) => ({ sku: p.merchant_sku, name: p.name, sales_status: "OUT_OF_STOCK" as const }));
  let discontinueSkipped: string | null = null;
  if (gone.length && (opts.partial || !store.length)) discontinueSkipped = "El catálogo de la tienda se leyó en parte: no se marcó nada como Agotado.";
  else if (gone.length && gf.length && gone.length / gf.length > GF_DISCONTINUE_MAX_SHARE)
    discontinueSkipped = `${gone.length} de ${gf.length} productos dejarían de venderse de golpe: no se marcaron como Agotado. Revisa el catálogo de la tienda.`;
  return { create, rename, discontinue: discontinueSkipped ? [] : gone, discontinueSkipped };
}

/** En lotes de hasta 200, en el orden: crear, renombrar, agotar. */
export function gfSyncBatches(plan: GfSyncPlan, size = GF_BATCH_SIZE): GfSyncItem[][] {
  const all = [...plan.create, ...plan.rename, ...plan.discontinue], out: GfSyncItem[][] = [];
  for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size));
  return out;
}

// ---- El SKU que GF no tiene, al crear la guía (owner, 26-11-2026, #KP201969: «el shampoo de cebolla de kenku.pe no
// está en GF courier… sí, así automatizamos»). Si GF responde SKU_NOT_FOUND, Kapta sube ese SKU al catálogo de la
// tienda en GF (el mismo POST /v1/products/batch de la sincronización) y reintenta la guía con la misma clave. ----

/** SKU de la lista que GF no tiene en el catálogo de la tienda, sin distinguir mayúsculas, en orden y sin repetir. */
export function gfMissingSkus(skus: readonly string[], gf: readonly GfCatalogProduct[]): string[] {
  const first = new Map<string, string>();
  for (const s of skus.map((v) => v.trim()).filter(Boolean)) if (!first.has(s.toUpperCase())) first.set(s.toUpperCase(), s);
  const unique = [...first.values()];
  return compareGfCatalog(unique.map((sku) => ({ sku, name: sku })), gf).missingInGf.map((r) => r.sku);
}

/**
 * El SKU que GF dice que no tiene, a partir de su error: el campo `items.N.sku` señala la línea; si no, el texto
 * «El SKU X no está en el catálogo…». Otro código de error: null.
 */
export function gfSkuNotFound(error: { code: string; field?: string; message?: string }, items: readonly { sku: string }[]): string | null {
  if (error.code !== "SKU_NOT_FOUND") return null;
  const index = /^items\.(\d+)\.sku$/.exec(error.field ?? "")?.[1];
  const fromField = index !== undefined ? clean(items[Number(index)]?.sku) : "";
  if (fromField) return fromField;
  return /El SKU (\S+) no está/u.exec(error.message ?? "")?.[1] ?? null;
}

/**
 * El producto que se sube a GF para un SKU del pedido: el nombre de la línea del pedido como lo arma la sincronización
 * («título – variante»), o el SKU si la línea no trae nombre. Se crea «En existencias» y sin conteo, como en la
 * sincronización de cada hora (que después le pone el nombre del catálogo vivo si cambia).
 */
export function gfSkuUploadItem(sku: string, line: { title?: string | null; variantTitle?: string | null } | null): GfSyncItem {
  const name = line ? gfCatalogName(line.title ?? "", line.variantTitle ?? null) : "";
  return { sku: sku.trim(), name: name || sku.trim(), sales_status: "IN_STOCK" };
}
