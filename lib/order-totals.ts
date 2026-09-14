import type { OrderLineItem } from "./types";

/**
 * LO QUE SUMA UN PEDIDO, LEÍDO DE SHOPIFY Y NO RECALCULADO.
 *
 * El desglose de productos mostraba el título y «×1», nada más. Ni la variante,
 * ni el precio, ni el subtotal, ni el envío — todo eso obligaba a abrir el admin
 * de Shopify en otra pestaña para responder «¿cuánto se cobra y por qué?», que
 * es la pregunta que se hace mientras se confirma un pedido por teléfono.
 *
 * Los importes vienen de `orders.raw`, el payload que Shopify ya manda y que
 * guardamos entero: `subtotal_price`, `total_discounts`, `total_shipping_price_set`
 * y `total_price`. NO se recalculan sumando líneas. Si se recalcularan, un
 * descuento por línea, un impuesto o un redondeo harían que Kapta dijera un
 * número y Shopify otro, y ante esa discrepancia la operación no sabría a cuál
 * creerle. El subtotal de cada línea (precio × cantidad) sí se calcula acá,
 * porque Shopify no lo manda y es aritmética sin ambigüedad.
 *
 * Todos los pedidos son PEN (19.553 de 19.553 en los últimos 90 días, medido el
 * 14-09-2026), así que el formateo vive en la pantalla y no hay conversión.
 */
export interface OrderTotals {
  /** Suma de las líneas ANTES de descuentos, tal como la informa Shopify. */
  subtotal: number | null;
  /** Descuentos aplicados al pedido. 0 y null son distintos: ver `has`. */
  discounts: number | null;
  /** Envío cobrado a la clienta. En COD suele ser 0 y eso es información. */
  shipping: number | null;
  /** Lo que la clienta paga. Es el número que el motorizado cobra en la puerta. */
  total: number | null;
}

/** Lee un importe de Shopify, que los manda como cadena («99.00»). */
function money(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}

/** `total_shipping_price_set.shop_money.amount`, con sus tres niveles opcionales. */
function fromPriceSet(set: unknown): number | null {
  if (!set || typeof set !== "object") return null;
  const shop = (set as { shop_money?: unknown }).shop_money;
  if (!shop || typeof shop !== "object") return null;
  return money((shop as { amount?: unknown }).amount);
}

/**
 * Los totales del pedido. `fallbackTotal` es `orders.total_amount`, que es la
 * columna que el resto del Master ya usa: si `raw` no trajera `total_price`
 * —pedidos viejos, importaciones— el total sigue siendo el mismo número que se
 * muestra en la cabecera, y no dos cifras distintas en la misma pantalla.
 */
export function orderTotals(raw: unknown, fallbackTotal: number | null = null): OrderTotals {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    subtotal: money(o.subtotal_price),
    discounts: money(o.total_discounts),
    shipping: fromPriceSet(o.total_shipping_price_set),
    total: money(o.total_price) ?? fallbackTotal,
  };
}

/** Lo que cuesta una línea: Shopify no lo manda, y es aritmética sin ambigüedad. */
export function lineSubtotal(item: Pick<OrderLineItem, "price" | "quantity">): number | null {
  if (item.price == null) return null;
  const qty = Math.max(0, item.quantity || 0);
  return item.price * qty;
}

/** Cuántas unidades lleva el pedido, que no es lo mismo que cuántos productos. */
export function totalUnits(items: Pick<OrderLineItem, "quantity">[]): number {
  return items.reduce((sum, item) => sum + Math.max(0, item.quantity || 0), 0);
}

/**
 * ¿Se puede pintar el desglose del pedido? Solo si Shopify lo desglosó.
 *
 * `orders.raw` llega en DOS formas, según por dónde entró el pedido. Medido
 * sobre 7.669 pedidos de 30 días el 14-09-2026:
 *
 *   * Forma REST (923, el 12%): trae `subtotal_price`, `total_discounts`,
 *     `total_shipping_price_set` y `total_price`. El desglose completo, y
 *     consistente por construcción porque son los números de Shopify.
 *   * Forma GraphQL (6.746, el 88%): trae el total y NADA más. Sin subtotal,
 *     sin envío, sin descuento.
 *
 * La tentación es rellenar el 88% sumando las líneas. NO SE HACE, y esta es la
 * razón medida: la suma de líneas difiere del total del pedido en **7.949 de
 * 21.017 casos (38%), con una diferencia promedio de S/ 101,51** — no es
 * redondeo, es otra cosa. Pintar «Suma S/ 99 · Total S/ 200» sin poder nombrar
 * a qué corresponde la diferencia es peor que no pintar nada: obliga a dudar
 * de los dos números en la pantalla donde se decide cuánto cobrar.
 *
 * Así que el bloque aparece cuando Shopify dio el subtotal, y se calla cuando
 * no. El total del pedido no se pierde: la cabecera del cajón ya lo muestra.
 */
export function totalsWorthShowing(totals: OrderTotals, itemCount: number): boolean {
  // Sin subtotal de Shopify no hay desglose que mostrar, solo aritmética propia
  // que no cuadra con el total.
  if (totals.subtotal == null) return false;
  // Con subtotal, el bloque se gana su sitio salvo que repita lo de arriba:
  // un solo producto, sin descuento ni envío, ya está dicho en su línea.
  if (itemCount > 1) return true;
  if (totals.discounts != null && totals.discounts > 0) return true;
  if (totals.shipping != null && totals.shipping > 0) return true;
  return false;
}
