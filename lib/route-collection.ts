import { isWebPrepaid, type OrderPaymentFacts } from "@/lib/order-paid";

export interface CollectionBalance {
  remaining: number | null;
  validated: number;
  pending: number;
}

/** Courier remittances are not another customer advance. Never subtract twice. */
export function collectionBalance(total: number | null, facts: OrderPaymentFacts,
  payments: readonly { kind: string; amount: number | null; validation_status: string }[],
): CollectionBalance {
  const cents = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0
    ? Math.round(value * 100) : 0;
  const customer = payments.filter((p) => p.kind !== "cobro_courier" && p.validation_status !== "rechazado");
  const validated = customer.filter((p) => p.validation_status === "validado").reduce((sum, p) => sum + cents(p.amount), 0);
  const pending = customer.filter((p) => p.validation_status !== "validado").reduce((sum, p) => sum + cents(p.amount), 0);
  const prepaid = isWebPrepaid(facts);
  return {
    remaining: total === null || !Number.isFinite(total) || total < 0 ? null : prepaid ? 0 : Math.max(0, cents(total) - validated) / 100,
    validated: prepaid ? cents(total) / 100 : validated / 100,
    pending: pending / 100,
  };
}

export function reportedCollection(method: string | null, amount: number | null): number | null {
  return method === "sin_cobro" ? 0 : amount;
}
