// La pestaña «Sin SKU» del Catálogo de productos (Envíos → Aliclik, MOM
// §38.12, owner 17-11-2026).
//
// Un producto sin SKU en la tienda no se puede asociar a Aliclik ni vincular a
// Swayp, y el aviso rojo solo los contaba: «26 producto(s) publicado(s) no
// tienen SKU en WooCommerce». Para encontrarlos había que recorrer «Sin asociar
// Aliclik», donde se mezclan con los que sí tienen SKU y solo esperan su EAN.
//
// Aquí salen solos, agrupados por producto (que es como se arreglan) y
// clasificados en dos casos que se arreglan distinto:
//
//   * «El SKU está en el producto, no en la variación». El caso del Pack de 10
//     Pares de Calcetines FourLines (Aurela, 17-11-2026): le pusieron el SKU al
//     producto variable, en su pestaña Inventario, y la variación «FourLines»
//     siguió sin el suyo. WooCommerce le muestra el del padre, pero una venta
//     de esa variación no lo lleva propio, y Kapta la cuenta sin SKU a
//     propósito (MOM §38.12). Se arregla en Variaciones.
//   * «Sin SKU»: ni el producto ni la variación lo tienen.
//
// Pura.

export interface MissingSkuRow {
  shopifySku: string | null;
  /** WooCommerce: el SKU del producto cuando la variación no tiene el suyo. */
  parentSku?: string | null;
  title: string;
  variantTitle: string | null;
}

export type MissingSkuKind = "solo_en_producto" | "sin_sku";

export interface MissingSkuGroup<R extends MissingSkuRow> {
  title: string;
  kind: MissingSkuKind;
  /** El SKU que tiene el producto, si es `solo_en_producto`. */
  parentSku: string | null;
  rows: R[];
}

export const MISSING_SKU_KIND_LABEL: Record<MissingSkuKind, string> = {
  solo_en_producto: "El SKU está en el producto, no en la variación",
  sin_sku: "Sin SKU",
};

/** Cómo se arregla cada caso, en la tienda. */
export function missingSkuFix(kind: MissingSkuKind, source: string): string {
  return kind === "solo_en_producto"
    ? `Abre el producto ${source}, ve a Variaciones y pon el SKU en cada variación. Si el producto tiene una sola, quítale el SKU al producto y ponlo en la variación (WooCommerce no deja repetirlo). Después, «Sincronizar catálogo».`
    : `Abre el producto ${source} y pon el SKU en cada variación (o en el producto, si es simple). Después, «Sincronizar catálogo».`;
}

/** ¿A esta fila le falta el SKU? Un SKU de solo espacios tampoco es SKU. */
export function lacksSku(row: Pick<MissingSkuRow, "shopifySku">): boolean {
  return !(row.shopifySku ?? "").trim();
}

/**
 * Las filas sin SKU, una tarjeta por producto con sus variaciones dentro.
 * Primero los que tienen el SKU solo en el producto (el arreglo es mover un
 * dato que ya existe), después los que no lo tienen en ningún lado; dentro de
 * cada caso, por nombre, y las variaciones por la suya.
 */
export function groupMissingSku<R extends MissingSkuRow>(rows: readonly R[]): MissingSkuGroup<R>[] {
  const groups = new Map<string, R[]>();
  for (const row of rows) {
    if (!lacksSku(row)) continue;
    const list = groups.get(row.title);
    if (list) list.push(row);
    else groups.set(row.title, [row]);
  }
  const order: Record<MissingSkuKind, number> = { solo_en_producto: 0, sin_sku: 1 };
  return [...groups.entries()]
    .map(([title, list]) => {
      const parentSku = list.map((r) => (r.parentSku ?? "").trim()).find(Boolean) ?? null;
      return {
        title,
        kind: (parentSku ? "solo_en_producto" : "sin_sku") as MissingSkuKind,
        parentSku,
        rows: [...list].sort((a, b) => (a.variantTitle ?? "").localeCompare(b.variantTitle ?? "", "es")),
      };
    })
    .sort((a, b) => order[a.kind] - order[b.kind] || a.title.localeCompare(b.title, "es"));
}

/** Cuántos productos de cada caso, para el encabezado de la pestaña. */
export function missingSkuCounts(groups: readonly MissingSkuGroup<MissingSkuRow>[]): Record<MissingSkuKind, number> {
  return {
    solo_en_producto: groups.filter((g) => g.kind === "solo_en_producto").length,
    sin_sku: groups.filter((g) => g.kind === "sin_sku").length,
  };
}

/** «26 variantes de 9 productos», en singular cuando toca. */
export function missingSkuSummary(groups: readonly MissingSkuGroup<MissingSkuRow>[]): string {
  const variants = groups.reduce((sum, g) => sum + g.rows.length, 0);
  const products = groups.length;
  return `${variants} ${variants === 1 ? "variante" : "variantes"} de ${products} ${products === 1 ? "producto" : "productos"}`;
}
