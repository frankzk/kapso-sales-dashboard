// La guarda de las observaciones de cuadre en el cambio de estado EN LOTE del
// Master (MOM §30.8). Puro, probado en test/pedidos-bulk-status-guard.test.ts.
//
// «Aplicar al Master» desde una hoja (app/dashboard/liquidaciones-2/actions.ts,
// `applyCuadernoRowsToMaster`) no deja pasar a entregado una fila con una
// observación abierta: el motivo lo escribe quien repartió y lo acepta quien
// liquida antes de que el pedido cruce. El lote del Master llegaba a entregado
// por otro camino (`setOrderStatus` pedido a pedido) sin mirarla. Es la misma
// regla —cualquier observación abierta del pedido, de monto o de estado—, y
// aplica solo cuando el lote marca entregado: es la única puerta que §30.8
// cierra.

/**
 * Donde se acepta el motivo de una observación (`resolveObservation`,
 * components/sheets-board.tsx). Desde el 22-09-2026 no está en el menú, a
 * pedido de operación (components/sidebar.tsx), y ninguna otra pantalla la
 * enlaza: por eso los avisos dicen cómo se llega.
 */
export const OBSERVATIONS_SCREEN_HREF = "/dashboard/liquidaciones-2";
export const OBSERVATIONS_SCREEN_LABEL = `Liquidaciones 2 (${OBSERVATIONS_SCREEN_HREF}; no está en el menú)`;

export const OPEN_OBSERVATION_SKIP_REASON =
  `Saltado: tiene una observación de cuadre abierta en ${OBSERVATIONS_SCREEN_LABEL}. Quien liquida debe aceptar el motivo antes de marcarlo entregado.`;

export interface BulkDeliveredSkip {
  orderId: string;
  error: string;
}

/**
 * Qué pedidos del lote NO se tocan porque tienen una observación abierta.
 * Conserva el orden de la selección; con otro estado destino no salta ninguno.
 */
export function bulkDeliveredSkips(
  target: string,
  orderIds: readonly string[],
  withOpenObservation: ReadonlySet<string>,
): BulkDeliveredSkip[] {
  if (target !== "entregado") return [];
  return orderIds
    .filter((orderId) => withOpenObservation.has(orderId))
    .map((orderId) => ({ orderId, error: OPEN_OBSERVATION_SKIP_REASON }));
}

/** El aviso del lote: cuántos cambiaron, cuántos se saltaron y por qué, y cuántos fallaron. */
export function bulkStatusNotice(counts: { applied: number; skipped: number; failed: number }): string | undefined {
  const parts: string[] = [];
  if (counts.applied) {
    parts.push(`${counts.applied} pedido${counts.applied === 1 ? "" : "s"} actualizado${counts.applied === 1 ? "" : "s"}.`);
  }
  if (counts.skipped) {
    parts.push(
      `${counts.skipped} saltado${counts.skipped === 1 ? "" : "s"} por una observación de cuadre abierta en ${OBSERVATIONS_SCREEN_LABEL}.`,
    );
  }
  if (counts.failed) parts.push(`${counts.failed} con problemas.`);
  return parts.length ? parts.join(" ") : undefined;
}

/** El error del lote cuando TODOS los que se iban a tocar se saltaron. */
export function bulkAllSkippedError(skipped: number): string {
  return `Ningún pedido se marcó entregado: ${skipped === 1 ? "tiene" : `los ${skipped} tienen`} una observación de cuadre abierta en ${OBSERVATIONS_SCREEN_LABEL}. Quien liquida debe aceptar el motivo primero.`;
}
