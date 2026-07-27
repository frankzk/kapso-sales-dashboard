// El dinero que Aliclik le va a cobrar a la clienta en la puerta.
//
// POR QUÉ EXISTE ESTE ARCHIVO. `OrderLineItem.price` viene de Shopify como
// `originalUnitPriceSet`: el precio unitario ANTES de descuentos. Aliclik no
// tiene campo de descuento ni de total — calcula lo que cobra como la suma de
// `precio × cantidad` de los productos que le mandamos. Con un pedido de 3× S/149
// y un descuento de S/149, mandarle los precios de Shopify tal cual hace que
// cobre S/447 cuando la clienta debe pagar S/298. Pasó de verdad, en la primera
// guía creada por API.
//
// La verdad de cuánto se cobra es `orders.total_amount` (el Total de Shopify,
// ya con descuentos e impuestos). Aquí se ajustan los precios unitarios para que
// su suma dé exactamente ese total.

/** Lo mínimo que hace falta de cada línea para repartir el dinero. */
export interface PricedLine {
  quantity: number;
  price: number;
}

export interface ReconcileResult<T> {
  /** Las líneas con el precio unitario ajustado. */
  items: T[];
  /** Lo que Aliclik va a cobrar con esos precios. Se enseña ANTES de crear. */
  total: number;
  /**
   * Diferencia contra el total del pedido, en soles. Cero casi siempre; puede
   * quedar 1 céntimo cuando el total no es divisible entre las unidades (3×
   * S/99,3333…). No se oculta: se enseña.
   */
  drift: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Suma de `precio × cantidad`, que es como Aliclik calcula lo que cobra. */
export function linesTotal(lines: readonly PricedLine[]): number {
  return round2(lines.reduce((s, l) => s + l.price * l.quantity, 0));
}

/**
 * Reparte `orderTotal` entre las líneas, proporcionalmente a lo que pesa cada
 * una en el subtotal sin descuento.
 *
 * El reparto es proporcional y no a partes iguales para que un pedido con dos
 * productos de precios distintos no acabe con el barato costando lo mismo que
 * el caro — cosa que la clienta ve en la boleta y que descuadra la contabilidad
 * por producto.
 *
 * El céntimo que sobra tras redondear se le echa a la línea más cara, que es
 * donde menos se nota en porcentaje.
 *
 * Devuelve `null` si no hay nada que repartir (total desconocido o no positivo,
 * o líneas sin cantidad). Quien llama DEBE bloquear en ese caso: mandar el
 * precio de Shopify tal cual es exactamente el fallo que esto arregla.
 */
export function reconcileToOrderTotal<T extends PricedLine>(
  lines: readonly T[],
  orderTotal: number | null | undefined,
): ReconcileResult<T> | null {
  if (orderTotal == null || !Number.isFinite(orderTotal) || orderTotal <= 0) return null;
  if (!lines.length) return null;
  const units = lines.reduce((s, l) => s + l.quantity, 0);
  if (units <= 0) return null;

  const subtotal = linesTotal(lines);
  // Sin subtotal utilizable no hay proporción posible: se reparte por unidades.
  const weight = (l: PricedLine) => (subtotal > 0 ? (l.price * l.quantity) / subtotal : l.quantity / units);

  // Un céntimo es el precio mínimo: un producto a 0 en la boleta de la clienta
  // parece un regalo y descuadra la devolución si hay que reembolsar.
  const MIN = 0.01;
  if (round2(units * MIN) > orderTotal) return null;

  // Se trunca hacia abajo, no se redondea al más cercano. El redondeo normal
  // puede pasarse del total (66,6667 → 66,67 × 3 = 200,01) y COBRAR DE MÁS, que
  // es exactamente el fallo que este archivo existe para impedir. Truncando, el
  // error solo puede ir a favor de la clienta.
  const floor2 = (n: number) => Math.floor(round2(n * 100)) / 100;
  const items = lines.map((l) => ({
    ...l,
    price: l.quantity > 0 ? Math.max(MIN, floor2((orderTotal * weight(l)) / l.quantity)) : 0,
  }));

  // Truncar deja céntimos sin repartir. Se devuelven de la línea más cara hacia
  // abajo, y solo mientras quepan: subir un céntimo el precio unitario cuesta
  // `quantity` céntimos en el total, así que una línea de 3 unidades no puede
  // absorber un resto de 1 o 2. Lo que no quepa se queda como `drift`, a la
  // baja, y la interfaz lo enseña antes de crear la guía.
  const order = items.map((_, i) => i).sort((a, b) => items[b]!.price - items[a]!.price);
  for (const i of order) {
    const line = items[i]!;
    if (line.quantity <= 0) continue;
    while (round2(linesTotal(items) + line.quantity * 0.01) <= orderTotal) {
      items[i] = { ...items[i]!, price: round2(items[i]!.price + 0.01) };
    }
  }

  const total = linesTotal(items);
  return { items, total, drift: round2(total - orderTotal) };
}
