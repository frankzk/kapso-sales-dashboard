// El envío que la clienta pagó en la agencia. Puro.
//
// Decisión del owner (01-11-2026, MOM §6.5). En Agencia la clienta recoge en
// Shalom u Olva y ahí le cobran el envío; la vendedora se lo descuenta de la
// diferencia, así que el Yape nunca llega al total: S/ 141 por Yape + S/ 8 que
// pagó en el mostrador = S/ 149. Ese dinero no deja comprobante en ninguna
// cuenta de la empresa, y el pedido quedaba para siempre en «Recogido sin pago
// completo» y sin boleta (21 pedidos al decidirlo, casi todos con S/ 8 o
// S/ 10 de diferencia).
//
// Ahora, con el paquete ya recogido, lo que falta hasta S/ 15 —el mismo tope
// de la excepción por descuento de la clave, `DISCOUNT_EXCEPTION_MAX`— es el
// envío pagado en la agencia y el pedido está pagado completo. Es automático:
// la excepción de la clave pedía un botón y se usó en 3 de esos 21 casos. La
// boleta sale por el total: el precio no cambió, la clienta pagó el envío por
// cuenta de la tienda.
//
// Las rejas son las de esa excepción, más el recojo:
//   - Agencia y el paquete ya recogido: antes de eso, falta cobrar el saldo;
//   - al menos dos comprobantes VALIDADOS, el adelanto entre ellos;
//   - ningún comprobante vivo sin validar (en revisión, observado, posible
//     duplicado): si hay uno, lo que falta puede ser justo ése;
//   - lo que falta con lo validado, entre S/ 1 y S/ 15. Menos de S/ 1 ya es el
//     redondeo de lib/payment-rounding.ts.

import { DISCOUNT_EXCEPTION_MAX, type PaymentSnapshot } from "@/lib/pickup-key";
import { PAYMENT_ROUNDING_TOLERANCE_CENTS } from "@/lib/payment-rounding";

/** Lo más que se acepta como envío pagado en la agencia (S/). */
export const AGENCY_SHIPPING_MAX = DISCOUNT_EXCEPTION_MAX;

export interface AgencyShippingInput {
  /** `macro_operation` del pedido. */
  operation: string | null | undefined;
  /** El paquete ya se recogió en la agencia. */
  pickedUp: boolean;
  payments: readonly Pick<PaymentSnapshot, "kind" | "validation_status" | "amount">[];
  orderTotal: number | null | undefined;
}

function cents(value: number | null | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/**
 * Lo que la clienta pagó de envío en la agencia (S/), o null si no aplica.
 * Cuando devuelve un monto, el pedido está pagado completo.
 */
export function agencyShippingPaid(input: AgencyShippingInput): number | null {
  if (input.operation !== "agencia" || !input.pickedUp) return null;
  const total = cents(input.orderTotal);
  if (total === null || total <= 0) return null;

  const live = input.payments.filter((p) => p.validation_status !== "rechazado");
  if (live.some((p) => p.validation_status !== "validado")) return null;
  if (live.length < 2 || !live.some((p) => p.kind === "adelanto")) return null;

  const paid = live.reduce((sum, p) => sum + (cents(p.amount) ?? 0), 0);
  const shortfall = total - paid;
  if (shortfall <= PAYMENT_ROUNDING_TOLERANCE_CENTS) return null;
  if (shortfall > AGENCY_SHIPPING_MAX * 100) return null;
  return shortfall / 100;
}
