// ¿Este pedido ya está cobrado? Una sola definición, dos vías de cobro.
//
// POR QUÉ EXISTE. Hasta ahora «pagado» significaba UNA cosa: comprobantes de
// Yape en `order_payments`. Desde que entran pedidos pagados en el checkout
// (EasySell + pasarela, `financial_status = 'paid'`) esa definición se quedó
// corta, y quedarse corta acá se paga en efectivo:
//
//   `defaultCollectionAmount` pone la guía en 0 solo si el estado de los
//   comprobantes es `pago_completo`. Un pedido pagado con tarjeta no tiene NI
//   UNA fila en `order_payments`, así que salía `sin_pago` y la guía se creaba
//   diciéndole al motorizado que cobrara el total — de un pedido ya pagado.
//
// El comentario de esa función ya lo advertía: «si se manda el total, el
// repartidor le cobra al cliente algo que ya pagó». Lo que le faltaba era saber
// que el dinero puede haber entrado por otro sitio.
//
// LA REGLA ES DURA A PROPÓSITO. Solo `paid` cuenta. En esta operación los
// estados que existen son tres —`pending` (9.132), `voided` (2.733) y `paid`
// (870) en los últimos 60 días, con CERO reembolsos—, así que no hay que
// adivinar qué hacer con `partially_paid`: no aparece. El día que aparezca, no
// contará como pagado, que es el lado seguro del error.

/** Lo que hace falta saber del pedido para decidir si ya está cobrado. */
export interface OrderPaymentFacts {
  /** `orders.financial_status`, tal cual lo manda Shopify. */
  financialStatus?: string | null;
  /** `orders.total_refunded`. Un reembolso deshace el prepago. */
  totalRefunded?: number | null;
  /** El estado de los comprobantes Yape (`paymentState`, lib/pickup-key.ts). */
  paymentState?: string | null;
}

/**
 * ¿Lo cobró Shopify en el checkout?
 *
 * Un reembolso lo deshace: el dinero volvió, así que el pedido vuelve a estar
 * por cobrar. Hoy no hay ninguno en la base, pero la columna existe y la guarda
 * cuesta una línea — mucho menos que descubrirlo con el paquete en la puerta.
 */
export function isWebPrepaid(facts: OrderPaymentFacts): boolean {
  if ((facts.financialStatus ?? "").trim().toLowerCase() !== "paid") return false;
  const refunded = facts.totalRefunded ?? 0;
  if (Number.isFinite(refunded) && refunded > 0) return false;

  // SI HAY COMPROBANTES, EL DINERO ENTRÓ POR YAPE — y entonces mandan las reglas
  // de Yape, no `financial_status`.
  //
  // No es una sutileza: en la operación real casi todo pedido cobrado por Yape
  // acaba también marcado `paid` en Shopify. Sin esta condición, un pedido con
  // el adelanto cargado y la diferencia pendiente contaría como «pagado por
  // web» y abriría la compuerta de la clave de recojo — que es exactamente la
  // pérdida de dinero que esa compuerta existe para evitar.
  //
  // `paid` sin ningún comprobante es lo único que solo puede venir de la
  // pasarela. Lo demás lo decide `paymentState`, que sabe de montos.
  const state = (facts.paymentState ?? "").trim();
  return !state || state === "sin_pago";
}

/**
 * ¿Está cobrado del todo, por la vía que sea?
 *
 * Las dos vías son alternativas, no acumulativas: o lo cobró la pasarela, o los
 * comprobantes cubren el total. No se suman — sumar un prepago web con un Yape
 * sería contar dos veces el mismo dinero.
 */
export function orderFullyPaid(facts: OrderPaymentFacts): boolean {
  return isWebPrepaid(facts) || facts.paymentState === "pago_completo";
}

/**
 * Cuánto tiene que cobrar el courier en la puerta.
 *
 * ES LA ÚNICA RESPUESTA A ESA PREGUNTA, y por eso vive acá y no repartida entre
 * quien crea la guía y quien vigila lo que el courier declara. Que esas dos
 * discrepen es justamente cómo se acaba cobrando dos veces sin que nadie lo vea:
 * una crea la guía con el total y la otra la da por correcta porque compara
 * contra ese mismo total.
 */
export function expectedCollectAmount(
  facts: OrderPaymentFacts,
  orderTotal: number | null | undefined,
): number {
  if (orderFullyPaid(facts)) return 0;
  const total = orderTotal ?? 0;
  return Number.isFinite(total) && total > 0 ? Math.round(total * 100) / 100 : 0;
}
