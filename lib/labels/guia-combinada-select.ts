// Qué salida de cada pedido se imprime como guía combinada, cuando se pide en
// lote desde el Master (30-09-2026).
//
// EL CASO. La guía combinada —el rótulo de Tanders arriba y el interno abajo—
// solo se podía bajar desde el drawer, pedido por pedido. «Descargar rótulos»
// de la barra en lote baja el rótulo INTERNO, así que para imprimir la tanda de
// 15 pedidos Tanders del día había que abrir 15 drawers.
//
// LA REGLA. Por pedido, la salida de Tanders vigente: la que no está anulada
// (una anulada no sale a la calle) y, si hubiera dos, la de consecutivo más
// alto. Solo LEE: a diferencia de «Descargar rótulos», no crea salidas — un
// pedido sin guía de Tanders se cuenta aparte y se dice, porque la combinada no
// existe sin la mitad del courier.
//
// Puro y probado en test/guia-combinada-select.test.ts.

export interface CombinadaCandidate {
  id: string;
  order_id: string | null;
  courier: string;
  delivery_status: string;
  output_number: number | null;
}

export interface CombinadaSelection {
  /** Salidas a imprimir, en el orden de los pedidos pedidos. */
  shipmentIds: string[];
  /** Pedidos sin una salida de Tanders viva: no tienen combinada. */
  missingOrderIds: string[];
}

export function pickCombinadaOutputs(
  orderIds: readonly string[],
  rows: readonly CombinadaCandidate[],
): CombinadaSelection {
  const best = new Map<string, CombinadaCandidate>();
  for (const row of rows) {
    if (!row.order_id || row.courier !== "tanders" || row.delivery_status === "anulado") continue;
    const current = best.get(row.order_id);
    if (!current || (row.output_number ?? 0) > (current.output_number ?? 0)) best.set(row.order_id, row);
  }
  const shipmentIds: string[] = [];
  const missingOrderIds: string[] = [];
  for (const orderId of new Set(orderIds)) {
    const pick = best.get(orderId);
    if (pick) shipmentIds.push(pick.id);
    else missingOrderIds.push(orderId);
  }
  return { shipmentIds, missingOrderIds };
}
