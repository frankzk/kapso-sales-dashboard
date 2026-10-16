// La ventana de «Resultados de Urpi» y lo que queda fuera de ella (MOM §30.11).
//
// La pantalla lee los intentos de los últimos 60 días. El botón «Pasar a salida
// de Urpi entregada» no mira la fecha, pero solo puede pulsarse sobre lo que la
// pantalla enseña: un pedido que Urpi entregó hace más de 60 días y cuya caja
// sigue «por definir» desaparecía del aviso, y con él la única forma de
// rellenarla. Quedaba en «Por cerrar · Salida adicional activa» para siempre
// (15 pedidos, entregados del 10 al 15 de agosto, el 16-10-2026).
//
// Así que esos pedidos, y solo esos, se leen enteros aunque sean viejos. Lo
// demás de antes de la ventana —ya al día, cancelado, reprogramado— sigue fuera:
// no hay nada que hacer con ello aquí y cargaría la página de historia.

import type { UrpiResultCode } from "./urpi-report";

export interface UrpiAttemptRef {
  order_id: string | null;
  urpi_row: number;
  result_code: UrpiResultCode;
}

/**
 * Los pedidos de antes de la ventana cuyo ÚLTIMO intento es «Entregado» y que no
 * tienen ningún intento dentro de ella. Son los únicos que pueden tener la
 * salida por rellenar sin aparecer en pantalla: con un intento en la ventana ya
 * se ven, y con un último intento que no es entrega el botón no los toca (decide
 * con el último, igual que la carga). PURA.
 */
export function olderDeliveredOrderIds(
  olderAttempts: readonly UrpiAttemptRef[],
  inWindow: ReadonlySet<string>,
): string[] {
  const latest = new Map<string, UrpiAttemptRef>();
  for (const attempt of olderAttempts) {
    if (!attempt.order_id || inWindow.has(attempt.order_id)) continue;
    if ((latest.get(attempt.order_id)?.urpi_row ?? 0) < attempt.urpi_row) latest.set(attempt.order_id, attempt);
  }
  return [...latest.values()].filter((attempt) => attempt.result_code === "entregado").map((attempt) => attempt.order_id!);
}
