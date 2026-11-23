// Lo que dice el buscador de productos de Leads cuando no encuentra nada.
//
// En WooCommerce no hay permiso que falte: el producto no está publicado en el
// catálogo de ESA tienda (owner, 23-11-2026: «¿no aparece la astaxantina?». Era
// de Kenku y el lead, de Aurela). El aviso de Shopify sigue igual. Pura.

export function productPickerEmptyText(platform: "shopify" | "woocommerce" | null, storeName: string | null): string {
  if (platform === "woocommerce") {
    return `No está en el catálogo publicado de WooCommerce de ${storeName?.trim() || "esta tienda"}. Si debería estar, publícalo allí con su SKU.`;
  }
  return "Sin resultados (o falta el permiso read_products).";
}
