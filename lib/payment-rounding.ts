// El redondeo del cliente: cuándo lo pagado ya cubre el total. Puro.
//
// Decisión del owner (01-11-2026, MOM §6.5): un pedido al que le faltan MENOS
// de S/ 1 está pagado completo. El precio con descuento deja céntimos
// (S/ 134,10) y la clienta yapea redondo (S/ 30 + S/ 104): sin esto el pedido
// quedaba en «Recogido sin pago completo» para siempre, sin boleta y con un
// saldo de S/ 0,10 que nadie va a cobrar. La boleta sale por el total del
// pedido: la diferencia es redondeo, no un descuento.

/** Lo que puede faltar, en céntimos, y aun así está pagado: menos de S/ 1. */
export const PAYMENT_ROUNDING_TOLERANCE_CENTS = 99;

/**
 * ¿Lo pagado cubre el total? Exige que se haya pagado algo y que falten como
 * mucho `PAYMENT_ROUNDING_TOLERANCE_CENTS`. Total inválido o cero: no.
 */
export function paidCoversTotal(paidCents: number, totalCents: number | null): boolean {
  if (totalCents === null || !(totalCents > 0) || !(paidCents > 0)) return false;
  return totalCents - paidCents <= PAYMENT_ROUNDING_TOLERANCE_CENTS;
}

/** Lo que falta en céntimos, con el redondeo ya perdonado (0 si lo cubre). */
export function remainingCents(paidCents: number, totalCents: number): number {
  return paidCoversTotal(paidCents, totalCents) ? 0 : Math.max(0, totalCents - paidCents);
}
