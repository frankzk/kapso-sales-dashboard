// Quién entregó un pedido cuando la fila del Master no lo dice (MOM §14, §17.1).
//
// Las entregas que se registran con `status_override` —el cuaderno, los lotes,
// la ruta de Grupo GF, el reporte de Urpi— no dejan `delivered_courier`, y
// muchas tampoco tienen salida: el courier vigente queda vacío o «por definir».
// Dos sitios necesitan saber quién la llevó y usan la MISMA regla, por eso vive
// aquí y no en cada uno:
//
//   · el plazo de «Liquidación vencida» del tablero del owner
//     (`settlementCourier`, lib/mom-owner-summary.ts);
//   · la tarifa del costo logístico de un pedido entregado (`costCourier`,
//     que usan el recálculo del Master y la Mesa de cierre).
//
// Pura, probada en test/visibilidad-owner-alerts.test.ts y
// test/pedidos-logistics-cost.test.ts.

/** «Por definir» es una caja esperando courier, no un courier (MOM §6). */
const COURIER_TBD = "por_definir";

function code(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

/** ¿Es un courier de verdad? Vacío y «por definir» no lo son. */
export function isKnownCourier(value: string | null | undefined): boolean {
  const key = code(value);
  return Boolean(key) && key !== COURIER_TBD;
}

export interface DeliveryCourierFacts {
  /** `delivered_courier`: el de la guía o el evento de la entrega. */
  deliveredCourier?: string | null;
  /** `current_courier` y `last_courier`. */
  currentCourier?: string | null;
  lastCourier?: string | null;
  /** «Salió con» (`dispatched_with`, 0266): `gf:<Motorizado>`, `gf`, `urpi`… */
  dispatchedWith?: readonly string[] | null;
}

/**
 * Quién entregó, en este orden:
 *
 *   1. El courier de la entrega, si se registró.
 *   2. El courier vigente, y si no el último: la salida que estaba entregando.
 *      «Por definir» no es un courier y se salta.
 *   3. «Salió con»: solo motorizados de Grupo GF es motorizado propio —también
 *      la entrega del cuaderno, que no tiene salida en Kapta—; un único
 *      courier, ese. Varios couriers distintos no dicen cuál entregó.
 *
 * null si nada lo dice.
 */
export function deliveryCourier(facts: DeliveryCourierFacts): string | null {
  if (facts.deliveredCourier) return facts.deliveredCourier;
  for (const courier of [facts.currentCourier, facts.lastCourier]) {
    if (isKnownCourier(courier)) return courier!;
  }
  const codes = facts.dispatchedWith ?? [];
  if (codes.length && codes.every((c) => c === "gf" || c.startsWith("gf:"))) return "propio";
  return codes.length === 1 ? codes[0]! : null;
}

/**
 * El courier con el que se busca la tarifa del costo logístico (MOM §14).
 *
 * El vigente, como siempre. Solo si el pedido está ENTREGADO y el vigente está
 * vacío o «por definir», el de la entrega (`deliveryCourier`): la entrega del
 * cuaderno de Grupo GF no tiene salida y su costo se calculaba con courier
 * vacío, así que ni una tarifa de «propio» le llegaba. Un pedido que no se
 * entregó no infiere nada: un anulado con una salida cancelada no tuvo primer
 * intento de nadie.
 *
 * Si no se sabe quién entregó, devuelve el vigente tal cual (vacío o «por
 * definir»): el aviso de la conciliación dice entonces que no se sabe, en vez
 * de pedir una tarifa.
 */
export function costCourier(facts: DeliveryCourierFacts & { generalStatus: string | null | undefined }): string | null {
  const current = facts.currentCourier ?? null;
  if (isKnownCourier(current) || facts.generalStatus !== "entregado") return current;
  return deliveryCourier(facts) ?? current;
}
