// Gestión de reintentos: qué vale la pena volver a despachar y qué no.
// Puro + testeado.
//
// Es el módulo que ataca la tasa de entrega, que es lo que de verdad duele. Dos
// preguntas distintas, y confundirlas sale caro:
//
//   1. ¿ESTE PEDIDO merece otra visita? Depende de por qué falló. "No contesta"
//      se reintenta; "dirección errada" NO, hasta que alguien corrija la
//      dirección — mandarlo igual es pagar un flete para volver al mismo sitio
//      equivocado.
//
//   2. ¿ESTE CLIENTE recibe alguna vez? Un cliente con tres pedidos y cero
//      entregas no es mala suerte: es un patrón. Despacharle un cuarto sin
//      mirarlo es regalar el flete. Esto se mide por TELÉFONO y a través de
//      todos sus pedidos, no dentro de uno solo.
//
// Nada de esto decide por su cuenta. Marca, ordena y avisa; despachar o no lo
// decide una persona, porque el coste de equivocarse en cada dirección es muy
// distinto.

/** Motivos por los que NO tiene sentido reintentar tal cual. */
const BLOCKED_REASONS: Record<string, string> = {
  // El cliente lo vio y lo rechazó: no es un reintento, es una venta perdida.
  rechazado: "El cliente lo rechazó.",
  // Volver al mismo sitio equivocado cuesta otro flete y falla igual.
  direccion_errada: "Hay que corregir la dirección antes de volver a despachar.",
};

export interface RetryDecision {
  /** ¿Se puede volver a poner en una ruta tal cual está? */
  retryable: boolean;
  /** Por qué no, cuando no. */
  blockedReason: string | null;
}

export function retryDecision(lastReason: string | null | undefined): RetryDecision {
  const blocked = BLOCKED_REASONS[lastReason ?? ""];
  return { retryable: !blocked, blockedReason: blocked ?? null };
}

/** Lo que se sabe de un pedido y de su cliente al considerar otra visita. */
export interface RetryHistory {
  order_id: string;
  /** Intentos fallidos de ESTE pedido. */
  attempts: number;
  /** Motivo del último intento fallido. */
  lastReason: string | null;
  /** Pedidos de ESTE CLIENTE (mismo teléfono) que nunca llegaron a entregarse. */
  customerFailed: number;
  /** Pedidos de este cliente que sí se entregaron. */
  customerDelivered: number;
}

export type RiskLevel = "ok" | "vigilar" | "alto";

export const RISK_LABELS: Record<RiskLevel, string> = {
  ok: "Normal",
  vigilar: "Vigilar",
  alto: "Riesgo alto",
};

export interface RiskAssessment {
  level: RiskLevel;
  /** Motivos legibles, para que quien decide entienda por qué está marcado. */
  reasons: string[];
  retryable: boolean;
  blockedReason: string | null;
}

/**
 * Cuánto riesgo hay de gastar otro flete en balde.
 *
 * Los umbrales son deliberadamente bajos para AVISAR y altos para BLOQUEAR: la
 * herramienta no impide despachar nada, solo pone delante lo que un humano
 * miraría si tuviera tiempo de mirarlo todo. Un cliente que ya recibió alguna
 * vez nunca sube a riesgo alto por su historial: sabemos que sí recibe, y este
 * pedido puede ser mala suerte.
 */
export function assessRisk(h: RetryHistory): RiskAssessment {
  const reasons: string[] = [];
  const { retryable, blockedReason } = retryDecision(h.lastReason);

  let level: RiskLevel = "ok";

  if (h.attempts >= 3) {
    level = "alto";
    reasons.push(`${h.attempts} intentos fallidos en este pedido.`);
  } else if (h.attempts === 2) {
    level = "vigilar";
    reasons.push("Dos intentos fallidos en este pedido.");
  } else if (h.attempts === 1) {
    reasons.push("Un intento fallido.");
  }

  // El historial del cliente solo agrava si NUNCA recibió: si alguna vez
  // recibió, sabemos que la dirección existe y que abre la puerta.
  if (h.customerDelivered === 0 && h.customerFailed >= 2) {
    level = "alto";
    reasons.push(`Este cliente tiene ${h.customerFailed} pedidos y ninguno llegó a entregarse.`);
  } else if (h.customerDelivered === 0 && h.customerFailed === 1 && level === "ok") {
    level = "vigilar";
    reasons.push("Es el segundo pedido de este cliente y el anterior tampoco se entregó.");
  } else if (h.customerDelivered > 0 && h.customerFailed > 0) {
    reasons.push(`Este cliente sí recibe: ${h.customerDelivered} entregado(s).`);
  }

  if (blockedReason) {
    level = "alto";
    reasons.push(blockedReason);
  }

  return { level, reasons, retryable, blockedReason };
}

/**
 * Ordena los candidatos a reintento por lo que conviene mirar primero: lo
 * bloqueado arriba (necesita una decisión), luego lo de riesgo alto, y dentro de
 * cada grupo lo que más intentos lleva. Lo sano queda al final, que es lo que se
 * puede añadir a la ruta sin pensarlo.
 */
export function sortByAttention<T extends { risk: RiskAssessment; attempts: number }>(
  items: readonly T[],
): T[] {
  const weight = (r: RiskAssessment) => (r.blockedReason ? 0 : r.level === "alto" ? 1 : r.level === "vigilar" ? 2 : 3);
  return [...items].sort((a, b) => {
    const w = weight(a.risk) - weight(b.risk);
    return w !== 0 ? w : b.attempts - a.attempts;
  });
}
