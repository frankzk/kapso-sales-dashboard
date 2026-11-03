// Escanear un paquete que sigue en la caja de un día anterior (29-09-2026)
// o de hoy con la parada ya reportada (26-10-2026).
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
// EL MISMO DÍA (26-10-2026). #KP142954 salió en la caja de Yhoni del 26/10,
// Yhoni lo reportó «No entregado» y volvió a la oficina ese mismo día. Al
// escanearlo para la caja de Alexis del 26/10 la respuesta era «Está en la caja
// de Yhoni» y «Mover» fallaba («Esa parada ya fue reportada»): no había camino.
// Ahora la caja de HOY con la parada reportada «No entregado» se trata igual
// que la de un día anterior: el escaneo la recibe y la asigna a la otra caja.
// La parada de Yhoni queda como está (su reporte, su liquidación) y su caja
// registra que salió; la ruta de Alexis suma una parada nueva.
//
// Salvo que la caja que se arma sea del MISMO motorizado: la ruta del día
// tiene una sola parada por pedido (`delivery_stops`, único por ruta y
// pedido), así que una segunda vuelta con él es el reintento del mismo día con
// la misma salida (MOM §9.3): sigue en su caja y lo reporta otra vez en su
// parada. No se recibe ni se asigna.
//
// Del mismo día, lo entregado lo dice, y lo que no tiene reporte sigue la
// regla de siempre: «Ya estaba» o «En la caja de otro» con «Mover» (una
// parada pendiente sí se recupera en oficina, 0230).
//
// LA CAJA REEMPLAZADA (12-10-2026, «Sacar con salida nueva», 0248). Si el
// pedido ya salió con otra salida, el escaneo de la anterior —sea de la caja
// que sea— solo la recibe en oficina para devolverla a stock: no se asigna ni
// se toma, porque el pedido ya va con la nueva.

export type PastBoxDecision =
  /** La caja es posterior, o de hoy sin reporte: la regla de siempre. */
  | "misma_caja"
  /** «No entregado» en una caja anterior o de hoy de otro motorizado —rechazo incluido—: se recibe y se asigna. */
  | "recibir_y_asignar"
  /** Entregado según su motorizado: no hay nada que asignar. */
  | "entregado"
  /** Sin reporte del motorizado: no se toca. */
  | "sin_reporte"
  /** La salida ya se reemplazó por otra: se recibe y vuelve a stock, no se asigna. */
  | "recibir_a_stock"
  /** «No entregado» hoy en la caja del MISMO motorizado: reintento del mismo día (§9.3); no se toca. */
  | "reintento_mismo_dia";

export function pastBoxDecision(input: {
  /** `route_date` de la caja donde está el paquete. */
  boxRouteDate: string;
  /** Día de la caja que se está armando. */
  targetDay: string;
  /** Último reporte de la parada del paquete en ESA caja. */
  stopStatus: string | null;
  /** El motivo ya no decide (v1.23): todo «No entregado» se recibe y se asigna. */
  outcomeReason: string | null;
  /** La salida está en devolución porque el pedido salió con otra (`isReturningOwnOutput`). */
  replaced?: boolean;
  /** La caja donde está es del mismo motorizado que la que se arma. */
  sameRider?: boolean;
}): PastBoxDecision {
  // Antes que el día: también una caja de hoy, si ya salió con otra.
  if (input.replaced && input.stopStatus === "no_entregado") return "recibir_a_stock";
  if (input.boxRouteDate > input.targetDay) return "misma_caja";
  if (input.boxRouteDate === input.targetDay) {
    // Hoy: solo lo reportado cambia la regla de siempre (26-10-2026).
    if (input.stopStatus === "entregado") return "entregado";
    if (input.stopStatus !== "no_entregado") return "misma_caja";
    return input.sameRider ? "reintento_mismo_dia" : "recibir_y_asignar";
  }
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
    case "recibir_a_stock":
      return replacedReceivedMessage(null, riderName, boxRouteDate);
    case "entregado":
      return `${riderName} lo reportó entregado (${where}).`;
    case "sin_reporte":
      return `Sigue en ${where} sin reporte: pide a ${riderName} que reporte esa parada y vuelve a escanear.`;
    case "reintento_mismo_dia":
      return `${riderName} lo reportó «No entregado» y sigue en ${where}: si vuelve a salir hoy con él, es el reintento del mismo día y lo reporta otra vez en su misma parada. No se recibe ni se asigna; para otro motorizado, escanéalo en su caja.`;
  }
}

/** De dónde volvió, para la chapa del asignado: «volvió del 26/09». */
export function receivedFromLabel(riderName: string, boxRouteDate: string): string {
  return `${riderName} del ${boxDayShort(boxRouteDate)}`;
}

/**
 * Lo que se dice al recibir la caja reemplazada (0248): vuelve a stock y el
 * pedido sigue con su salida nueva. `outputCode` es la reemplazada.
 */
export function replacedReceivedMessage(outputCode: string | null | undefined, riderName: string, boxRouteDate: string, newCode?: string | null): string {
  const which = outputCode ?? "Era la caja reemplazada";
  const lead = outputCode ? `${which} era la caja reemplazada` : which;
  return `${lead} (${riderName} del ${boxDayShort(boxRouteDate)}): recibida en oficina; desármala y regístrala como reingreso a stock.${newCode ? ` El pedido sale con ${newCode}.` : ""}`;
}

/**
 * «Mover» sobre una parada que ya se reportó (0230 lo niega): pasa cuando el
 * motorizado reporta después del escaneo. Se vuelve a escanear y la regla de
 * arriba decide (un «No entregado» se recibe y entra en esta caja).
 */
export const REPORTED_STOP_MOVE_ERROR =
  "Esa parada ya se reportó y no se mueve. Vuelve a escanearlo: si es «No entregado», el escaneo lo recibe en oficina y lo pone en esta caja.";

/**
 * La línea del escaneo ofrece «Mover a esta caja»: está en la caja de otro
 * motorizado (sin reporte, o una caja que todavía no sale) y se sabe cuál.
 */
export function scanLineCanMove(line: { status: string; manifestId: string | null; shipmentId: string | null }): boolean {
  return line.status === "en_otra_caja" && !!line.manifestId && !!line.shipmentId;
}
