// Los productos de un pedido, para el filtro «Producto» del Master (MOM §6,
// pedido del owner 02-11-2026). Puro + testeado: lo usan el recálculo del
// Master (que escribe `order_master.product_titles`), el códec de la URL, la
// consulta del servidor y la píldora del navegador, así que no importa nada.
//
// QUÉ ES UN PRODUCTO AQUÍ. El `title` de cada línea de `orders.line_items`, que
// en Shopify y en WooCommerce ya es el nombre del producto SIN la variante
// (lib/woocommerce.ts lo toma de `parent_name`; la variante va aparte en
// `variant_title`). Se recortan los espacios y se juntan los repetidos, igual
// que `squish` de lib/metrics.ts: 807 pedidos traían dobles espacios al
// 02-11-2026 y sin esto el mismo producto salía dos veces en las opciones.
//
// La migración 0300 hace lo mismo en SQL (`order_product_titles`) para rellenar
// lo que ya existía; test/order-product-titles.test.ts comprueba que digan lo
// mismo.

/** Una línea de pedido, tal como llega en `orders.line_items`. */
type LineLike = { title?: unknown } | null | undefined;

/** El título normalizado de una línea, o "" si no trae ninguno utilizable. */
function lineTitle(line: LineLike): string {
  if (!line || typeof line !== "object") return "";
  const raw = (line as { title?: unknown }).title;
  // Solo texto (o un número, que la base lee igual con `->>`). Un objeto no es
  // un título: «[object Object]» no es un producto que alguien vaya a buscar.
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  return String(raw).replace(/\s+/g, " ").trim();
}

/**
 * Los títulos de producto del pedido, sin repetir y en el orden de sus líneas.
 * Un pedido con dos líneas del mismo producto (dos variantes) es UN producto
 * para el filtro: lo que se pregunta es «¿lleva este producto?».
 */
export function orderProductTitles(lineItems: unknown): string[] {
  if (!Array.isArray(lineItems)) return [];
  const seen = new Set<string>();
  for (const line of lineItems as LineLike[]) {
    const title = lineTitle(line);
    if (title) seen.add(title);
  }
  return [...seen];
}

/**
 * Un arreglo de texto de Postgres, con cada elemento entre comillas.
 *
 * `.overlaps(col, [...])` de supabase-js arma `ov.{a,b}` sin comillas, y eso
 * basta para códigos como `gf:Roy`, pero no para un título: 31 productos tenían
 * comas al 02-11-2026 («Faja, talla única») y la base los partiría en dos
 * elementos que no casan con nada. Se pasa ya escrito.
 */
export function pgTextArrayLiteral(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

/**
 * Cómo viaja cada título dentro de `?pr=`: la lista va separada por comas, como
 * las demás de la URL, así que la coma y el `%` del propio título se escapan.
 * URLSearchParams vuelve a codificar todo encima; esto solo protege el separador.
 */
export function encodeProductParam(titles: Iterable<string>): string {
  return [...titles].map((t) => t.replace(/%/g, "%25").replace(/,/g, "%2C")).join(",");
}

/** La inversa de `encodeProductParam`. Nunca lanza: lo que no entiende lo deja como está. */
export function decodeProductParam(raw: string): string[] {
  return raw
    .split(",")
    .map((v) => v.replace(/%2C/gi, ",").replace(/%25/g, "%").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Una fila de `order_master_product_options` (0300): pedidos por tienda y producto. */
export interface ProductOptionRow {
  store_id: string;
  title: string;
  orders: number;
}

/**
 * Las opciones de la píldora «Producto» para las tiendas elegidas (todas si no
 * hay ninguna), con cuántos pedidos tiene cada una. Las más pedidas primero:
 * son 464 productos y la búsqueda está para el resto.
 *
 * Lo que ya está elegido se queda en la lista aunque no sea de esas tiendas,
 * con su cifra a 0: si no, la casilla desaparecería y no habría cómo quitarla.
 */
export function productFilterOptions(
  rows: readonly ProductOptionRow[] | null | undefined,
  stores: ReadonlySet<string>,
  selected: ReadonlySet<string> = new Set(),
): { value: string; label: string; count: number }[] {
  const totals = new Map<string, number>();
  for (const row of rows ?? []) {
    if (!row || typeof row.title !== "string" || !row.title) continue;
    if (stores.size && !stores.has(row.store_id)) continue;
    totals.set(row.title, (totals.get(row.title) ?? 0) + (Number(row.orders) || 0));
  }
  for (const title of selected) if (!totals.has(title)) totals.set(title, 0);
  return [...totals]
    .sort(([a, na], [b, nb]) => nb - na || a.localeCompare(b, "es"))
    .map(([title, count]) => ({ value: title, label: title, count }));
}
