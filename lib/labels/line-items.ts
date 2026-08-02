// Qué productos van en el rótulo, y en qué forma.
//
// El rótulo lo lee quien arma la caja, así que necesita responder dos cosas de
// un vistazo: CUÁNTOS y CUÁL. Hasta ahora se imprimía un único texto corrido
// ("Título ×2 | Título2"), con títulos de Shopify de hasta 219 caracteres de
// copy publicitario — ilegible y, peor, sin la variante.
//
// La variante importa: hay pedidos con tres líneas del MISMO título que solo se
// distinguen por `variant_title` (37-38:24cm, 39-40:25cm, 41-42:26cm). Sin ella
// el almacén no sabe qué tallas empacar.

export interface LabelLineItem {
  quantity: number;
  /** Título del producto en Shopify. */
  name: string;
  /** Talla, color o presentación. `null` cuando el producto no tiene variantes. */
  variant: string | null;
}

/** Shopify escribe esto cuando el producto no tiene variantes reales. */
const DEFAULT_VARIANT = "default title";

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function cleanVariant(value: unknown): string | null {
  const text = cleanText(value);
  if (!text || text.toLowerCase() === DEFAULT_VARIANT) return null;
  return text;
}

function cleanQuantity(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
}

/**
 * Convierte `orders.line_items` en las líneas del rótulo.
 *
 * Agrupa por producto + variante: dos líneas del mismo par son la misma caja a
 * empacar, y el almacén cuenta unidades, no líneas de pedido.
 */
export function parseLabelLineItems(raw: unknown): LabelLineItem[] {
  if (!Array.isArray(raw)) return [];
  const merged = new Map<string, LabelLineItem>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const name = cleanText(row.title) || cleanText(row.name) || "Producto";
    const variant = cleanVariant(row.variant_title);
    const key = `${name.toLowerCase()}|${(variant ?? "").toLowerCase()}`;
    const existing = merged.get(key);
    if (existing) existing.quantity += cleanQuantity(row.quantity);
    else merged.set(key, { quantity: cleanQuantity(row.quantity), name, variant });
  }
  return [...merged.values()];
}

/**
 * Reconstruye las líneas desde el texto plano de `shipments.product`, que es lo
 * único que hay cuando la salida no está vinculada a un pedido. Formato que
 * escribe el propio sistema: `Título ×2 | Otro título`.
 */
export function parseLabelItemsFromText(product: string | null | undefined): LabelLineItem[] {
  const text = cleanText(product);
  if (!text) return [];
  return text
    .split("|")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const match = chunk.match(/^(.*?)\s*[×x]\s*(\d+)$/i);
      if (match) {
        return { quantity: cleanQuantity(match[2]), name: match[1]!.trim() || "Producto", variant: null };
      }
      return { quantity: 1, name: chunk, variant: null };
    });
}

/** Las líneas del pedido si existen; si no, lo que se guardó en la salida. */
export function labelItemsFor(
  lineItems: unknown,
  productText: string | null | undefined,
): LabelLineItem[] {
  const parsed = parseLabelLineItems(lineItems);
  return parsed.length ? parsed : parseLabelItemsFromText(productText);
}
