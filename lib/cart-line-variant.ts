/**
 * La línea de un carrito que llegó SIN su variante (owner, 19-11-2026,
 * #AUR901173 y #AUR900973). COD Core (aurela.pe) manda el formulario abandonado
 * con el producto que tenía variaciones y `variante: "sin elegir"`: la clienta
 * se fue antes de elegir talla y color. Su SKU es el del producto con
 * variaciones, y WooCommerce no crea un pedido por él. El formulario la marca y
 * no deja generar el pedido hasta que se elija la variante del catálogo; el
 * servidor la vuelve a frenar antes de crear nada (`wooVariableSkuLines`).
 * Pura: la usan el servidor y el formulario.
 */

/** Lo que escribe COD Core en `variante` cuando la clienta no eligió. */
export const UNCHOSEN_VARIANT_LABEL = "sin elegir";

/** ¿Esta línea del carrito (`draft_orders.line_items`) llegó sin su variante? */
export function cartLineNeedsVariant(li: { variant_title?: unknown; variant_id?: unknown } | null | undefined): boolean {
  if (!li) return false;
  const title = typeof li.variant_title === "string" ? li.variant_title.trim().toLowerCase() : "";
  const variantId = li.variant_id == null ? "" : String(li.variant_id).trim();
  return title === UNCHOSEN_VARIANT_LABEL && !variantId;
}

/** El aviso de la línea en «Generar pedido». */
export const NEEDS_VARIANT_TEXT =
  "Falta elegir la variante (talla, color…): la clienta no la eligió en la web. Pregúntasela y elígela del catálogo.";

/** El rechazo del servidor cuando una línea va por el SKU del producto con variaciones. */
export function variableLinesProblem(titles: readonly string[]): string | null {
  if (!titles.length) return null;
  const una = titles.length === 1;
  const lista = titles.map((t) => `«${t}»`).join(", ");
  return (
    `Pedido NO generado: ${lista} ${una ? "es un producto" : "son productos"} con variaciones y falta elegir la variante (talla, color…). ` +
    `No se creó nada en la tienda. Quíta${una ? "lo" : "los"} y agréga${una ? "lo" : "los"} desde «Producto del catálogo» eligiendo la variante.`
  );
}
