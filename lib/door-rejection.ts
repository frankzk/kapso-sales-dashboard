// Rechazo en la puerta: cuántas veces y qué se cierra cuando se repite.
//
// EL CASO (25-09-2026). De 14.905 guías, 133 traen `REFUSED` de Aliclik —el
// cliente vio el producto y no lo quiso—. Dos clientes lo hicieron DOS veces, y
// en ambos la segunda guía salió igual:
//
//   * Edwin Paul Condori (51933066595): rechazó el 16-08 (#AUR175450, Aurela) y
//     volvió a rechazar el 31-08 (#KP131487, Kenku Perú, S/ 298).
//   * Hugo Yépez Payva (51951419981): rechazó el 19-08 (#KP128958) y volvió a
//     rechazar el 15-09 (#AUR177007).
//
// La ficha de riesgo del §8 ya existía y ya frenaba la creación de guías
// Aliclik. No los frenó, y el motivo no fue el cruce de tiendas —el historial no
// filtra por tienda y 10 de 12 vendedoras ven las dos—: fue que `confirmationRisk`
// cuenta `anulado + devuelto` leyendo `general_status`, y 92 de esas 133 guías
// están en `en_proceso`. Un rechazo en la puerta no suma antecedente hasta que
// el paquete TERMINA de volver, y eso tarda semanas: el pedido de Edwin sigue en
// `en_proceso` 40 días después. Cuando salió la segunda guía, la tabla de riesgo
// veía cero.
//
// Por eso esta cuenta NO mira `general_status`. Mira la etiqueta del courier, que
// es el hecho: el cliente lo rechazó el día que lo rechazó.

import { etiquetaDiceRechazoEnPuerta } from "@/lib/aliclik-status";

/**
 * Cuántos rechazos en la puerta cierran Aliclik para siempre.
 *
 * Medido sobre los reenvíos que siguieron a un rechazo: 12 en total, 4
 * entregados, 6 caídos por otra causa y 2 rechazados otra vez. Un tercio se
 * recupera, así que el primer rechazo NO cierra la ruta —ahí sigue mandando la
 * escalera de adelanto del §8—. El segundo sí: a esa altura la evidencia es que
 * el cliente tuvo el producto en la mano dos veces y las dos lo devolvió.
 */
export const DOOR_REJECTION_BAN_THRESHOLD = 2;

/**
 * Las rutas que le quedan a un cliente con Aliclik cerrado.
 *
 * Se bloquea SOLO Aliclik porque es la única ruta que cobra el intento fallido:
 * el flete se paga aunque el paquete vuelva. Agencia y Swayp siguen abiertas
 * —el cliente puede comprar, solo no por la ruta que nos cuesta cuando falla—.
 *
 * `fenix` y `swayp` son UNA ruta con dos nombres: las guías Fénix se emiten por
 * la API de Swayp (serie `5000…`, `created_via: 'fenix_directo'`). Se nombran
 * las dos porque las dos aparecen en `shipments.courier`.
 */
export const ROUTES_STILL_ALLOWED = ["shalom", "olva", "swayp", "fenix"] as const;

export const ROUTES_STILL_ALLOWED_LABEL = "Shalom, Olva o Swayp/Fénix";

/** Una guía del historial del cliente, con lo mínimo para contar rechazos. */
export interface DoorRejectionShipment {
  order_id: string | null;
  reported_status: string | null;
}

/**
 * Cuántos PEDIDOS del cliente terminaron en un rechazo en la puerta.
 *
 * Se cuentan pedidos, no guías. Un pedido puede llevar dos guías —se reintentó,
 * se cambió de courier— y las dos pueden traer `REFUSED` de la misma etiqueta
 * arrastrada. Eso es UNA venta rechazada, no dos, y contar guías cerraría la
 * ruta con un solo rechazo real. Ante la duda, la cuenta baja: el bloqueo no
 * tiene excepción, así que equivocarse de más es caro.
 *
 * Las guías sin `order_id` (huérfanas, sin cotejar) no se cuentan: no se sabe de
 * quién son.
 */
export function countDoorRejections(rows: readonly DoorRejectionShipment[]): number {
  const orders = new Set<string>();
  for (const row of rows) {
    if (!row.order_id) continue;
    if (etiquetaDiceRechazoEnPuerta(row.reported_status)) orders.add(row.order_id);
  }
  return orders.size;
}

export interface AliclikDoorBan {
  /** Cuántos pedidos de este cliente terminaron rechazados en la puerta. */
  rejections: number;
  /** `true` = no se puede crear guía Aliclik. Sin excepción. */
  banned: boolean;
  /** Qué se le dice a quien lo intenta. `null` cuando no está bloqueado. */
  message: string | null;
}

/**
 * LA COMPUERTA, Y NO TIENE PUERTA DE ATRÁS.
 *
 * A diferencia de `aliclikRiskGate` —que exige adelanto y se puede exceptuar
 * escribiendo una justificación— este bloqueo es duro: ni vendedora, ni admin,
 * ni owner pueden saltárselo desde la aplicación. Fue la decisión explícita del
 * dueño de la operación el 25-09-2026, sobre la alternativa de dejarlo
 * levantable por owner.
 *
 * Son dos ejes distintos a propósito y no se mezclan: uno pregunta CUÁNTA PLATA
 * hay que exigir por adelantado, el otro POR QUÉ RUTA puede salir. Un cliente
 * con el pago completo validado sigue sin poder ir por Aliclik.
 *
 * Que no haya excepción tiene un costo conocido: si un rechazo se registró mal,
 * el cliente queda cerrado y la corrección hay que hacerla sobre el dato —la
 * etiqueta de la guía—, no sobre el permiso. Es el precio de que la regla no se
 * pueda ablandar a las 7 de la tarde con el pedido esperando.
 */
export function aliclikDoorBan(rejections: number): AliclikDoorBan {
  if (rejections < DOOR_REJECTION_BAN_THRESHOLD) {
    return { rejections, banned: false, message: null };
  }
  return {
    rejections,
    banned: true,
    message:
      `Este cliente rechazó en la puerta ${rejections} pedidos: Aliclik queda cerrado ` +
      `para él de forma permanente y no se puede exceptuar. Despáchalo por ` +
      `${ROUTES_STILL_ALLOWED_LABEL}.`,
  };
}
