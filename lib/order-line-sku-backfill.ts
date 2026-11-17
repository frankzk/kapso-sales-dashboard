// El SKU que el pedido no guardó (MOM §38.12, 17-11-2026).
//
// Un pedido guarda sus productos tal como estaban al venderse. #AUR900965
// (Aurela, 16-11) se vendió cuando la variación «FourLines» del Pack de 10
// Pares de Calcetines no tenía SKU propio: la línea quedó con `sku: null`. Al
// día siguiente le pusieron el SKU en WooCommerce y sincronizaron, pero el
// pedido siguió igual, y GF Courier decía «Hay un producto sin SKU: GF solo
// despacha productos de su catálogo». Aliclik ya completaba el SKU al crear la
// guía (`hydrateOrderLineSkusFromCatalog`), pero solo con Shopify; GF, Swayp y
// los rótulos leen la línea tal cual.
//
// La sincronización del catálogo completa ahora, en los pedidos abiertos, el
// SKU que falta, y lo deja escrito en el pedido para que lo vean todos.
//
// ESTRICTO A PROPÓSITO. Esto escribe en el pedido, así que solo empareja por la
// identidad de la variante: su id, o el del producto si en el catálogo ese
// producto tiene una sola variante. Nunca por nombre: en un producto con tallas
// donde solo «M» tiene SKU, adivinar por nombre le pondría a una «L» el SKU de
// la «M», y GF despacharía la talla equivocada.
//
// Pura.

/** Una variante del catálogo vivo de la tienda (`ShopifySkuDetails`). */
export interface CatalogVariantRef {
  productId: string | null;
  variantId: string | null;
  shopifySku: string | null;
}

/** Una línea de `orders.line_items`, como la guardan los ingestores. */
export interface StoredOrderLine {
  sku?: string | null;
  title?: string | null;
  variant_title?: string | null;
  product_id?: string | number | null;
  variant_id?: string | number | null;
  [key: string]: unknown;
}

/** «woo:9935», «gid://shopify/ProductVariant/9935» o «9935» → «9935». «0» no es id. */
export function catalogRefId(raw: string | number | null | undefined): string {
  const value = String(raw ?? "").trim().replace(/^woo:/i, "");
  const id = value.match(/([^/]+)$/)?.[1]?.toLowerCase() ?? "";
  return id && id !== "0" ? id : "";
}

const cleanSku = (sku: string | null | undefined) => (sku ?? "").trim();

export interface LineSkuFill {
  index: number;
  sku: string;
  title: string | null;
  variantTitle: string | null;
}

/**
 * Las líneas sin SKU que el catálogo resuelve sin dudas, y las líneas ya
 * completadas. Una línea que ya tiene SKU no se toca nunca, ni aunque el
 * catálogo diga otro: ese es el que se vendió.
 */
export function backfillLineSkus<L extends StoredOrderLine>(
  lines: readonly L[],
  catalog: readonly CatalogVariantRef[],
): { lines: L[]; filled: LineSkuFill[] } {
  const byVariant = new Map<string, Set<string>>();
  // Todas las variantes de cada producto, también las que no tienen SKU: para
  // saber si «el producto» identifica una sola.
  const variantsOfProduct = new Map<string, Set<string>>();
  const skuOfProductVariant = new Map<string, Set<string>>();
  for (const ref of catalog) {
    const vid = catalogRefId(ref.variantId);
    const pid = catalogRefId(ref.productId);
    const sku = cleanSku(ref.shopifySku);
    if (pid) {
      const vs = variantsOfProduct.get(pid) ?? new Set<string>();
      vs.add(vid || pid);
      variantsOfProduct.set(pid, vs);
    }
    if (!sku) continue;
    if (vid) byVariant.set(vid, new Set([...(byVariant.get(vid) ?? []), sku]));
    if (pid) skuOfProductVariant.set(pid, new Set([...(skuOfProductVariant.get(pid) ?? []), sku]));
  }
  const only = (set: Set<string> | undefined) => (set && set.size === 1 ? [...set][0]! : null);

  const filled: LineSkuFill[] = [];
  const out = lines.map((line, index) => {
    if (cleanSku(line.sku as string | null | undefined)) return line;
    const vid = catalogRefId(line.variant_id);
    const pid = catalogRefId(line.product_id);
    let sku = vid ? only(byVariant.get(vid)) : null;
    // Sin id de variante (un producto simple): el producto, solo si en el
    // catálogo tiene UNA variante.
    if (!sku && !vid && pid && (variantsOfProduct.get(pid)?.size ?? 0) === 1) {
      sku = only(skuOfProductVariant.get(pid));
    }
    if (!sku) return line;
    filled.push({
      index,
      sku,
      title: (line.title as string | null | undefined) ?? null,
      variantTitle: (line.variant_title as string | null | undefined) ?? null,
    });
    return { ...line, sku };
  });
  return { lines: out, filled };
}

/** La nota que queda en la línea de tiempo del pedido. */
export function lineSkuBackfillNote(filled: readonly LineSkuFill[], sourceName: string): string {
  const parts = filled.map(
    (f) => `«${f.title ?? "producto"}»${f.variantTitle ? ` (${f.variantTitle})` : ""} → ${f.sku}`,
  );
  return `SKU completado desde el catálogo de ${sourceName}: ${parts.join("; ")}. El pedido se guardó cuando el producto no tenía SKU.`;
}

/** Las etapas en las que todavía se crea una guía o una salida. */
export const BACKFILL_STAGES = ["por_confirmar", "preparacion", "por_despachar", "en_curso"] as const;
/** Hasta cuántos días atrás se miran los pedidos abiertos. */
export const BACKFILL_DAYS = 120;
