// Escanear un paquete que sigue en la caja de un día anterior (29-09-2026).
//
// EL CASO. #KP136779 y #KP136896 salieron el 26/09 con Yhoni, que los reportó
// «No entregado · reprogramado por el cliente». La ruta se cerró el 28/09, pero
// nadie los «recibió en oficina», así que seguían dentro de esa caja. El 29/09,
// con los paquetes en la mano, el escaneo de Despacho del día respondía «Ya
// estaba» —la caja activa era de Yhoni— y no los metía en la ruta de hoy. Así
// había 78 «No entregado» atrapados en cajas del 16 al 28/09.
//
// LA REGLA. Escanear en oficina un paquete de una caja ANTERIOR al día de la
// caja que se arma prueba que volvió: es lo mismo que «Recibir devoluciones».
// Si el motorizado lo reportó «No entregado», el mismo escaneo lo recibe
// (`gf_return_to_office`, 0188/0206) y lo asigna. Un rechazo también, desde la
// v1.23: solo la anulación en Shopify termina la venta (owner, 30-09-2026). Sin
// reporte no se toca: la parada es de la liquidación de ese motorizado y la
// tiene que cerrar él.
//
// Lo del MISMO día no cambia: «Ya estaba» o «En la caja de otro».

export type PastBoxDecision =
  /** La caja es del mismo día (o posterior): la regla de siempre. */
  | "misma_caja"
  /** «No entregado» en una caja anterior —rechazo incluido—: se recibe y se asigna. */
  | "recibir_y_asignar"
  /** Entregado según su motorizado: no hay nada que asignar. */
  | "entregado"
  /** Sin reporte del motorizado: no se toca. */
  | "sin_reporte";

export function pastBoxDecision(input: {
  /** `route_date` de la caja donde está el paquete. */
  boxRouteDate: string;
  /** Día de la caja que se está armando. */
  targetDay: string;
  /** Último reporte de la parada del paquete en ESA caja. */
  stopStatus: string | null;
  /** El motivo ya no decide (v1.23): todo «No entregado» se recibe y se asigna. */
  outcomeReason: string | null;
}): PastBoxDecision {
  if (input.boxRouteDate >= input.targetDay) return "misma_caja";
  if (input.stopStatus === "entregado") return "entregado";
  if (input.stopStatus !== "no_entregado") return "sin_reporte";
  return "recibir_y_asignar";
}

/** `2026-09-26` → `26/09`. */
export function boxDayShort(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(day);
  return m ? `${m[2]}/${m[1]}` : day;
}

/** Lo que dice la línea del escaneo en cada caso que no asigna. */
export function pastBoxMessage(
  decision: Exclude<PastBoxDecision, "misma_caja" | "recibir_y_asignar">,
  riderName: string,
  boxRouteDate: string,
): string {
  const where = `la caja de ${riderName} del ${boxDayShort(boxRouteDate)}`;
  switch (decision) {
    case "entregado":
      return `${riderName} lo reportó entregado (${where}).`;
    case "sin_reporte":
      return `Sigue en ${where} sin reporte: pide a ${riderName} que reporte esa parada y vuelve a escanear.`;
  }
}

/** De dónde volvió, para la chapa del asignado: «volvió del 26/09». */
export function receivedFromLabel(riderName: string, boxRouteDate: string): string {
  return `${riderName} del ${boxDayShort(boxRouteDate)}`;
}
