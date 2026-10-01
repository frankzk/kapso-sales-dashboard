// Qué salida de cada pedido se imprime como guía combinada, cuando se pide en
// lote desde el Master (30-09-2026).
//
// EL CASO. La guía combinada —el rótulo del courier arriba y el interno abajo—
// solo se podía bajar desde el drawer, pedido por pedido. «Descargar rótulos»
// de la barra en lote baja el rótulo INTERNO, así que para imprimir la tanda de
// 15 pedidos Tanders del día había que abrir 15 drawers.
//
// QUIÉN LA TIENE. Dos couriers, con dos papeles distintos:
//   - Tanders: la dibujamos nosotros en A4 (lib/labels/guia-combinada.ts), su
//     API no da PDF.
//   - Shalom: su etiqueta la sirve su API y se EMBEBE sobre nuestra banda, en
//     100×150 mm (lib/labels/agency-rotulo.ts). Solo las guías creadas por API
//     (`shalom_ose_id`): las del Excel no tienen PDF que pedir.
// Olva y los demás no tienen guía combinada. Como el tamaño de papel es
// distinto —láser A4 contra etiqueta—, cada courier sale en su propio PDF.
//
// LA REGLA. Por pedido, la salida vigente de ESE courier: la que no está anulada
// (una anulada no sale a la calle) y, si hubiera dos, la de consecutivo más
// alto. Solo LEE: a diferencia de «Descargar rótulos», no crea salidas — un
// pedido sin esa guía se cuenta aparte y se dice.
//
// Puro y probado en test/guia-combinada-select.test.ts.

export const COMBINED_GUIDE_COURIERS = ["tanders", "shalom"] as const;
export type CombinedGuideCourier = (typeof COMBINED_GUIDE_COURIERS)[number];

export function hasCombinedGuide(courier: string | null | undefined): courier is CombinedGuideCourier {
  return (COMBINED_GUIDE_COURIERS as readonly string[]).includes((courier ?? "").trim().toLowerCase());
}

export interface CombinadaCandidate {
  id: string;
  order_id: string | null;
  courier: string;
  delivery_status: string;
  output_number: number | null;
  /** Shalom: solo las guías creadas por API tienen PDF que embeber. */
  shalom_ose_id?: number | null;
}

export interface CombinadaSelection {
  /** Salidas a imprimir, en el orden de los pedidos pedidos. */
  shipmentIds: string[];
  /** Pedidos sin una salida viva de ese courier con guía combinada. */
  missingOrderIds: string[];
}

export function pickCombinadaOutputs(
  orderIds: readonly string[],
  rows: readonly CombinadaCandidate[],
  courier: CombinedGuideCourier = "tanders",
): CombinadaSelection {
  const best = new Map<string, CombinadaCandidate>();
  for (const row of rows) {
    if (!row.order_id || row.courier !== courier || row.delivery_status === "anulado") continue;
    if (courier === "shalom" && !row.shalom_ose_id) continue;
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
