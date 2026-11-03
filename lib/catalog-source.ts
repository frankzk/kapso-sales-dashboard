// De dónde sale la lista de productos de Envíos → «Catálogo de productos»
// (MOM §38.12, «El catálogo de productos en WooCommerce»), y cómo se nombra en
// la pantalla. Puro y sin dependencias del servidor: lo importa también el
// componente del cliente.
//
//   · `shopify`: el catálogo activo de Shopify (la tienda crea en Shopify).
//   · `woocommerce`: el catálogo publicado de WooCommerce (`stores.platform =
//     woocommerce` con sus claves de la API).
//   · null: no se pudo saber la plataforma de la tienda; la lista sale solo del
//     historial de pedidos y los textos dicen «la tienda».

export type CatalogPlatform = "shopify" | "woocommerce" | null;

/** «Shopify», «WooCommerce» o null. */
export function catalogSourceName(platform: CatalogPlatform): string | null {
  if (platform === "shopify") return "Shopify";
  if (platform === "woocommerce") return "WooCommerce";
  return null;
}

/** «en Shopify», «en WooCommerce» o «en la tienda». */
export function catalogSourceIn(platform: CatalogPlatform): string {
  const name = catalogSourceName(platform);
  return name ? `en ${name}` : "en la tienda";
}

/** Para etiquetas: «Shopify», «WooCommerce» o «de la tienda» («SKU de la tienda»). */
export function catalogSourceTag(platform: CatalogPlatform): string {
  return catalogSourceName(platform) ?? "de la tienda";
}

/**
 * Los SKU de la tienda que contó la sincronización, para el aviso de
 * «Sincronizar catálogo» (Envíos y Ajustes): «12 SKUs activos de Shopify»,
 * «12 SKUs de WooCommerce» o «12 SKUs del historial de pedidos».
 */
export function catalogSkusPhrase(count: number, platform: CatalogPlatform): string {
  if (platform === "shopify") return `${count} SKUs activos de Shopify`;
  if (platform === "woocommerce") return `${count} SKUs de WooCommerce`;
  return `${count} SKUs del historial de pedidos`;
}

/**
 * El aviso de la pantalla cuando el catálogo de WooCommerce (o la tienda) no se
 * pudo leer, o se leyó a medias, y la lista se completó con el historial de
 * pedidos. Null sin problemas. Nombra la fuente: «Catálogo de WooCommerce: …».
 */
export function catalogSourceNotice(platform: CatalogPlatform, problems: readonly string[]): string | null {
  if (!problems.length) return null;
  const name = catalogSourceName(platform);
  return (
    `${name ? `Catálogo de ${name}` : "Catálogo de la tienda"}: ${problems.join(" ")} ` +
    "La lista se completó con el historial de pedidos del último año: un producto que todavía no se vendió puede no aparecer."
  );
}
