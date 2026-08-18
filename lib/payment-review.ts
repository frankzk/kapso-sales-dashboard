export const PAYMENT_PENDING_STATUSES = ["pendiente_revision"] as const;

export const PAYMENT_OBSERVED_STATUSES = [
  "posible_duplicado",
  "info_incompleta",
  "revision_admin",
] as const;

export type PaymentReviewLane = "pending" | "observed" | "validated";

/**
 * La bandeja solo contiene trabajo accionable y las aprobaciones del día.
 * `rechazado` queda en el historial del pedido, no como tarea abierta.
 */
export function paymentReviewLane(
  status: string,
  validatedAt: string | null,
  todayStartIso: string,
): PaymentReviewLane | null {
  if ((PAYMENT_PENDING_STATUSES as readonly string[]).includes(status)) return "pending";
  if ((PAYMENT_OBSERVED_STATUSES as readonly string[]).includes(status)) return "observed";
  if (status === "validado" && validatedAt && validatedAt >= todayStartIso) return "validated";
  return null;
}

export function limaDayBounds(now = new Date()): { startIso: string; endIso: string; date: string } {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const start = new Date(`${date}T05:00:00.000Z`);
  return {
    date,
    startIso: start.toISOString(),
    endIso: new Date(start.getTime() + 86_400_000).toISOString(),
  };
}

export function paymentKindLabel(kind: string): string {
  if (kind === "adelanto") return "Adelanto";
  if (kind === "diferencia") return "Diferencia";
  if (kind === "total") return "Pago total";
  return kind;
}

export function paymentObservationLabel(status: string): string {
  if (status === "posible_duplicado") return "Posible duplicado";
  if (status === "info_incompleta") return "Información incompleta";
  if (status === "revision_admin") return "Revisión solicitada";
  return "Pendiente de revisión";
}
