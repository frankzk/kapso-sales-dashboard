// ¿La fecha del pago encaja con el pedido? Puro + testeado.
//
// Un comprobante de un pago hecho días ANTES de que existiera el pedido no
// paga este pedido: es un Yape viejo, de otra venta, que alguien reutiliza. El
// nº de operación y la huella del archivo (yape-dedup) solo atrapan lo que ya
// está registrado en el sistema; un Yape viejo que nunca se cargó pasaba.
//
// Hay un margen porque el pedido de Shopify puede crearse después del pago: la
// clienta adelanta por WhatsApp y el pedido se arma más tarde. Dos días cubren
// eso de sobra; más que eso ya no es el mismo trato (decisión del owner,
// 02-10-2026).
//
// No bloquea: manda el pago a revisión administrativa con el motivo, igual que
// un receptor que no cuadra. Sin fecha leída no se juzga — eso ya lo cubre el
// estado «información incompleta».

/** Cuánto antes de crearse el pedido puede ser un pago y seguir siendo suyo. */
export const PAYMENT_BEFORE_ORDER_MAX_DAYS = 2;

const DAY_MS = 86_400_000;

export interface PaymentDateVerdict {
  /** El pago es demasiado anterior al pedido para ser suyo. */
  tooEarly: boolean;
  /** Días enteros entre el pago y la creación del pedido (si es anterior). */
  daysBefore: number | null;
}

export function paymentDateVerdict(
  paidAt: string | null | undefined,
  orderCreatedAt: string | null | undefined,
  maxDays: number = PAYMENT_BEFORE_ORDER_MAX_DAYS,
): PaymentDateVerdict {
  const paid = Date.parse(paidAt ?? "");
  const created = Date.parse(orderCreatedAt ?? "");
  if (!Number.isFinite(paid) || !Number.isFinite(created)) return { tooEarly: false, daysBefore: null };
  const gap = created - paid;
  if (gap <= 0) return { tooEarly: false, daysBefore: null };
  return { tooEarly: gap > maxDays * DAY_MS, daysBefore: Math.floor(gap / DAY_MS) };
}

/** El aviso para quien registra o revisa el pago. */
export function paymentDateNotice(verdict: PaymentDateVerdict): string | null {
  if (!verdict.tooEarly) return null;
  return (
    `El pago es de ${verdict.daysBefore} días antes de que se creara el pedido: puede ser un Yape ` +
    "de otra venta. Quedó en revisión administrativa."
  );
}
