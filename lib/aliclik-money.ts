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
// LAS DOS REGLAS DE ALICLIK:
//   1. El precio unitario admite céntimos.
//   2. El TOTAL a cobrar tiene que ser un número ENTERO de soles. Es una
//      restricción de caja: el motorizado cobra en efectivo y no lleva monedas.
//
// La segunda regla es más dura de lo que parece. Con una línea de 3 unidades y
// precios de 2 decimales, los totales alcanzables son múltiplos de 0,03 — y
// ningún múltiplo de 0,03 con parte decimal cero existe salvo cuando el precio
// unitario es entero. Es decir: con 3 unidades, el total solo puede ser múltiplo
// de 3. Para un pedido de S/298 lo más cerca sin pasarse es S/297.
//
// La verdad de cuánto se cobra es `orders.total_amount` (el Total de Shopify,
// ya con descuentos e impuestos). Aquí se busca el ENTERO más alto que no lo
// supere y que sea representable con las cantidades del pedido.

/** Lo mínimo que hace falta de cada línea para repartir el dinero. */
export interface PricedLine {
  quantity: number;
  price: number;
}

export interface ReconcileResult<T> {
  /** Las líneas con el precio unitario ajustado. */
  items: T[];
  /** Lo que Aliclik va a cobrar. SIEMPRE un entero de soles. */
  total: number;
  /**
   * Diferencia contra el total del pedido, en soles. Nunca positiva: jamás se
   * cobra de más. Puede llegar a un par de soles cuando las cantidades no
   * permiten representar el total exacto. No se oculta: se enseña antes de
   * crear la guía.
   */
  drift: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Suma de `precio × cantidad`, que es como Aliclik calcula lo que cobra. */
export function linesTotal(lines: readonly PricedLine[]): number {
  return round2(lines.reduce((s, l) => s + l.price * l.quantity, 0));
}

/**
 * Lo máximo que el negocio acepta dejar de cobrar por un pedido, en soles.
 *
 * Decisión del dueño, no técnica. Medido sobre los 6.541 pedidos pendientes:
 * el 70 % no pierde nada, el 99 % pierde S/1,20 o menos, y el 1 % restante
 * llega hasta S/2,40 — casi todos cantidad 3 con un total dos soles por encima
 * de un múltiplo de 3. Esos NO se crean: es preferible que una persona los mire
 * a que el sistema regale dos soles en silencio.
 */
export const MAX_ACCEPTABLE_LOSS = 1.2;

/** Cuántos soles enteros por debajo del total se permite bajar buscando uno representable. */
const MAX_STEPS_DOWN = 30;

/**
 * Reparte el total del pedido entre las líneas cumpliendo las dos reglas de
 * Aliclik: precios unitarios con céntimos, total entero.
 *
 * ESTRATEGIA. Se prueban totales enteros desde `floor(orderTotal)` hacia abajo.
 * Para cada candidato se reparte proporcionalmente —para que un producto caro y
 * uno barato no acaben costando lo mismo, cosa que la clienta ve en la boleta—
 * y se deja que UNA línea absorba el resto exacto. Se prueba cada línea como
 * absorbente porque el resto tiene que ser divisible entre su cantidad. El
 * primer candidato que cuadra gana, así que la pérdida es siempre la mínima.
 *
 * Devuelve `null` si no hay nada que repartir (total desconocido o no positivo,
 * líneas sin cantidad, o ningún entero representable). Quien llama DEBE
 * bloquear: mandar el precio de Shopify tal cual es el fallo que esto arregla.
 */
export function reconcileToOrderTotal<T extends PricedLine>(
  lines: readonly T[],
  orderTotal: number | null | undefined,
  maxLoss: number = MAX_ACCEPTABLE_LOSS,
): ReconcileResult<T> | null {
  if (orderTotal == null || !Number.isFinite(orderTotal) || orderTotal <= 0) return null;
  if (!lines.length) return null;
  if (lines.some((l) => !Number.isInteger(l.quantity) || l.quantity <= 0)) return null;

  const subtotal = linesTotal(lines);
  const units = lines.reduce((s, l) => s + l.quantity, 0);
  // Peso de cada línea en el reparto. Si no hay subtotal utilizable (todo a
  // cero), se reparte por unidades.
  const weight = (l: PricedLine) =>
    subtotal > 0 ? (l.price * l.quantity) / subtotal : l.quantity / units;

  // Todo en CÉNTIMOS enteros: en soles, 0,1 + 0,2 no da 0,3 y el cuadre se
  // rompería por un error de coma flotante justo en el sitio donde importa.
  const MIN_CENTS = 1;

  for (let step = 0; step <= MAX_STEPS_DOWN; step++) {
    const soles = Math.floor(orderTotal) - step;
    if (soles <= 0) break;
    const target = soles * 100;

    for (let absorber = 0; absorber < lines.length; absorber++) {
      // Precio base de cada línea salvo la absorbente, truncado hacia abajo
      // para que siempre quede resto que la absorbente pueda tragarse.
      const cents = new Array<number>(lines.length).fill(MIN_CENTS);
      let used = 0;
      for (let i = 0; i < lines.length; i++) {
        if (i === absorber) continue;
        const l = lines[i]!;
        cents[i] = Math.max(MIN_CENTS, Math.floor((target * weight(l)) / l.quantity));
        used += cents[i]! * l.quantity;
      }
      const rest = target - used;
      const q = lines[absorber]!.quantity;
      // La línea absorbente tiene que poder tragarse el resto EXACTO.
      if (rest <= 0 || rest % q !== 0) continue;
      const unit = rest / q;
      if (unit < MIN_CENTS) continue;
      cents[absorber] = unit;

      const items = lines.map((l, i) => ({ ...l, price: cents[i]! / 100 }));
      const total = linesTotal(items);
      // Cinturón: si por lo que sea no cuadra exacto o se pasa, se descarta este
      // candidato en vez de crear una guía con el importe mal.
      if (total !== soles || total > orderTotal) continue;
      const drift = round2(total - orderTotal);
      // Se acabó la búsqueda: los candidatos van de mayor a menor, así que si
      // este ya se pasa del margen, ninguno de los siguientes va a caber.
      if (-drift > maxLoss + 1e-9) return null;
      return { items, total, drift };
    }
  }

  return null;
}
