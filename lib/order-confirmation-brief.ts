// La ficha que se mira ANTES de llamar (MOM §8).
//
// «Antes de llamar se revisan duplicados, conversación, cobertura Aliclik e
// historial del cliente». Eso hoy vive en una columna del Excel —«Métricas»—
// que alguien resume a mano: «Entregados: 2 · En Reparto: 1 · Anulados: 5». Es
// la columna que de verdad decide la llamada, porque de ella sale si hay que
// pedir adelanto, y sin ella Kapta no puede reemplazar la hoja por más que
// registre los intentos.
//
// Todo lo de aquí es puro: recibe filas ya leídas y devuelve el resumen. Quien
// las lee es `getOrderConfirmationBrief`.

/** En qué terminó un pedido anterior del mismo cliente. */
export type PriorOutcome =
  | "entregado"
  | "en_curso"
  | "anulado"
  | "devuelto"
  | "sin_confirmar";

export const PRIOR_OUTCOME_LABEL: Record<PriorOutcome, string> = {
  entregado: "Entregados",
  en_curso: "En curso",
  anulado: "Anulados",
  devuelto: "Devueltos",
  sin_confirmar: "Sin confirmar",
};

export interface PriorOrderSnapshot {
  order_id: string;
  order_name: string | null;
  order_created_at: string | null;
  general_status: string | null;
  macro_stage: string | null;
  order_total: number | null;
  /** El estado granular de Kapta: `sin_confirmar`, `en_ruta`, `anulado`… */
  operational_status?: string | null;
  guide_code?: string | null;
  current_courier?: string | null;
  last_courier?: string | null;
  delivered_courier?: string | null;
  attempt_count?: number | null;
  /** Resumen legible de las líneas del pedido: «Nattokinase ×3». */
  products?: string | null;
}

/**
 * El desenlace de un pedido anterior.
 *
 * `general_status` manda porque es el estado consolidado; la macroetapa solo
 * desempata lo que sigue abierto: un pedido en «Por confirmar» que nadie cerró
 * no es lo mismo que uno en reparto, y el Excel los distingue («Sin
 * Confirmación/Pago» frente a «En Reparto»).
 */
export function priorOutcome(row: PriorOrderSnapshot): PriorOutcome {
  const status = (row.general_status ?? "").trim().toLowerCase();
  if (status === "entregado") return "entregado";
  if (status === "anulado") return "anulado";
  if (status === "devuelto") return "devuelto";
  return row.macro_stage === "por_confirmar" ? "sin_confirmar" : "en_curso";
}

export type OutcomeCounts = Record<PriorOutcome, number>;

export function emptyOutcomeCounts(): OutcomeCounts {
  return { entregado: 0, en_curso: 0, anulado: 0, devuelto: 0, sin_confirmar: 0 };
}

export function summarizeOutcomes(rows: readonly PriorOrderSnapshot[]): OutcomeCounts {
  const counts = emptyOutcomeCounts();
  for (const row of rows) counts[priorOutcome(row)] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// ¿Llegó a salir? (MOM §8.1)
// ---------------------------------------------------------------------------

/**
 * Si el pedido llegó a costar flete, que es lo que separa dos anulados que la
 * ficha hoy cuenta igual.
 *
 * Nueve de cada diez anulados se anulan ANTES de despacharse: no salió ningún
 * paquete y no se perdió flete. El resto se despachó y se cayó en la calle. Para
 * la llamada son casos opuestos —a uno le sobra con confirmar mejor, al otro hay
 * que exigirle plata— y hasta ahora se veían idénticos.
 *
 * La guía es la prueba: sin `guide_code` nadie recogió nada.
 */
export type DispatchState = "entregado" | "despachado" | "nunca_despachado";

export const DISPATCH_STATE_LABEL: Record<DispatchState, string> = {
  entregado: "entregado",
  despachado: "se despachó",
  nunca_despachado: "nunca se despachó",
};

export function dispatchState(row: PriorOrderSnapshot): DispatchState {
  if (priorOutcome(row) === "entregado") return "entregado";
  return (row.guide_code ?? "").trim() ? "despachado" : "nunca_despachado";
}

/**
 * El courier que de verdad tocó el pedido.
 *
 * Se prefiere el que entregó, luego el que lo tiene ahora, y al final el último
 * que lo tuvo: un pedido que pasó de Aliclik a agencia tiene los tres, y el que
 * importa es el que cerró la historia.
 */
export function priorCourier(row: PriorOrderSnapshot): string | null {
  for (const value of [row.delivered_courier, row.current_courier, row.last_courier]) {
    const text = (value ?? "").trim();
    if (text) return text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Antes o después (MOM §8.1)
// ---------------------------------------------------------------------------

/**
 * Si el pedido del historial es anterior o POSTERIOR al que se está mirando.
 *
 * La ficha los llamaba a todos «anteriores» y no siempre lo son: un pedido viejo
 * que nadie confirmó acumula por debajo los intentos nuevos del mismo cliente.
 * Visto como «3 pedidos anteriores anulados» parece un cliente con mal
 * historial; visto en orden real es un pedido de hace cinco semanas que el
 * cliente ya volvió a pedir tres veces. Se decide distinto.
 */
export type PriorTiming = "anterior" | "posterior";

export function priorTiming(
  row: PriorOrderSnapshot,
  referenceCreatedAt: string | null,
): PriorTiming {
  const own = Date.parse(row.order_created_at ?? "");
  const reference = Date.parse(referenceCreatedAt ?? "");
  if (!Number.isFinite(own) || !Number.isFinite(reference)) return "anterior";
  return own > reference ? "posterior" : "anterior";
}

export function countLaterOrders(
  rows: readonly PriorOrderSnapshot[],
  referenceCreatedAt: string | null,
): number {
  return rows.filter((row) => priorTiming(row, referenceCreatedAt) === "posterior").length;
}

// ---------------------------------------------------------------------------
// Qué pidió (MOM §8.1)
// ---------------------------------------------------------------------------

/**
 * Las líneas del pedido en una sola línea de texto: «Nattokinase ×3 · Omega ×1».
 *
 * Sirve para ver de un vistazo que los cuatro pedidos del cliente son el mismo
 * producto y la misma cantidad — o sea, el mismo pedido repetido, no un
 * historial de compras variado.
 */
export function summarizeProducts(
  items: readonly { quantity: number; name: string }[],
  maxLines = 3,
): string | null {
  if (items.length === 0) return null;
  const shown = items
    .slice(0, maxLines)
    .map((item) => (item.quantity > 1 ? `${item.name} ×${item.quantity}` : item.name))
    .join(" · ");
  const rest = items.length - maxLines;
  return rest > 0 ? `${shown} +${rest}` : shown;
}

/** Si dos pedidos llevan exactamente lo mismo. */
export function sameProducts(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = (a ?? "").trim().toLowerCase();
  const right = (b ?? "").trim().toLowerCase();
  return left !== "" && left === right;
}

// ---------------------------------------------------------------------------
// Riesgo (MOM §8)
// ---------------------------------------------------------------------------

/** Qué hay que exigirle a este cliente antes de despachar. */
export type PaymentRequirement = "ninguno" | "sugerir_adelanto" | "exigir_adelanto" | "pago_completo";

export const PAYMENT_REQUIREMENT_LABEL: Record<PaymentRequirement, string> = {
  ninguno: "Sin adelanto requerido",
  sugerir_adelanto: "Sugerir adelanto de S/ 30",
  exigir_adelanto: "Exigir adelanto de S/ 30",
  pago_completo: "Exigir pago completo",
};

export interface ConfirmationRisk {
  /** Antecedentes de rechazo o devolución: lo que cuenta la tabla del §8. */
  antecedents: number;
  requirement: PaymentRequirement;
  /** Motivos legibles: quien decide tiene que ver POR QUÉ está marcado. */
  reasons: string[];
}

/**
 * La tabla de riesgo del MOM §8, tal cual está escrita:
 *
 * | Antecedentes | Regla                    |
 * | 1            | Sugerir adelanto de S/30 |
 * | 2            | Exigir adelanto de S/30  |
 * | 3 o más      | Exigir pago completo     |
 *
 * «Antecedentes» son los de RECHAZO o DEVOLUCIÓN —anulados y devueltos—, que es
 * lo que la regla nombra. Un pedido que sigue abierto o sin confirmar todavía no
 * es un rechazo, así que no suma; se muestra aparte como contexto.
 *
 * La tabla se aplica plana, sin ablandarla porque el cliente haya recibido
 * alguna vez. El MOM contempla la excepción COD «con justificación corta, actor
 * y fecha», o sea una decisión humana registrada — no un descuento automático
 * que la herramienta se invente. Por eso los entregados se enseñan bien
 * visibles: son el argumento de quien decide saltarse la regla, no un motivo
 * para que la regla no se aplique.
 */
export function confirmationRisk(
  counts: OutcomeCounts,
  priors: readonly PriorOrderSnapshot[] = [],
): ConfirmationRisk {
  const antecedents = counts.anulado + counts.devuelto;
  const reasons: string[] = [];

  if (counts.anulado > 0) {
    // Cuántos de esos anulados costaron flete. El número de antecedentes no
    // cambia —la tabla del §8 los cuenta a todos igual— pero quien llama tiene
    // que ver la diferencia: exigir pago completo a alguien que nunca hizo
    // salir un paquete no es lo mismo que exigírselo a quien lo rechazó en la
    // puerta tres veces.
    const dispatched = priors.filter(
      (row) => priorOutcome(row) === "anulado" && dispatchState(row) === "despachado",
    ).length;
    const detail =
      priors.length === 0
        ? ""
        : dispatched === 0
          ? ", ninguno llegó a despacharse"
          : dispatched === counts.anulado
            ? ", todos ya despachados"
            : `, ${dispatched} ya despachado${dispatched === 1 ? "" : "s"}`;
    reasons.push(
      `${counts.anulado} pedido${counts.anulado === 1 ? "" : "s"} anulado${counts.anulado === 1 ? "" : "s"}${detail}.`,
    );
  }
  if (counts.devuelto > 0) {
    reasons.push(`${counts.devuelto} devuelto${counts.devuelto === 1 ? "" : "s"}.`);
  }
  if (counts.entregado > 0) {
    reasons.push(`Este cliente sí recibe: ${counts.entregado} entregado${counts.entregado === 1 ? "" : "s"}.`);
  }
  if (counts.sin_confirmar > 0) {
    reasons.push(`${counts.sin_confirmar} sin confirmar todavía.`);
  }

  const requirement: PaymentRequirement =
    antecedents >= 3
      ? "pago_completo"
      : antecedents === 2
        ? "exigir_adelanto"
        : antecedents === 1
          ? "sugerir_adelanto"
          : "ninguno";

  return { antecedents, requirement, reasons };
}

export interface AliclikRiskGate {
  allowed: boolean;
  requiresException: boolean;
  message: string | null;
}

/**
 * La regla financiera se hace exigible al CREAR Aliclik, porque es la única
 * ruta que cobra el intento fallido. En Swayp, Lima y motorizados propios sigue
 * siendo información para decidir, no una barrera del sistema.
 */
export function aliclikRiskGate(
  requirement: PaymentRequirement,
  paymentState: string | null | undefined,
  exceptionReason?: string | null,
): AliclikRiskGate {
  const state = paymentState ?? "sin_pago";
  const advanceValidated = ["adelanto_validado", "diferencia_cargada", "pago_completo"].includes(
    state,
  );
  const fullValidated = state === "pago_completo";
  const unmet =
    (requirement === "exigir_adelanto" && !advanceValidated) ||
    (requirement === "pago_completo" && !fullValidated);
  if (!unmet) return { allowed: true, requiresException: false, message: null };

  const reason = exceptionReason?.trim() ?? "";
  if (reason.length >= 8) return { allowed: true, requiresException: true, message: null };
  return {
    allowed: false,
    requiresException: true,
    message:
      requirement === "pago_completo"
        ? "Aliclik exige el pago completo validado por los antecedentes del cliente. Para exceptuarlo, escribe una justificación corta."
        : "Aliclik exige un adelanto validado de S/ 30 por los antecedentes del cliente. Para exceptuarlo, escribe una justificación corta.",
  };
}

/**
 * ¿Hace falta cargar la ficha del §8 para este pedido?
 *
 * La ficha recorre el historial del teléfono y la matriz de tarifas, así que no
 * se pide en cada apertura del cajón: sobre un pedido ya entregado no cambia
 * ninguna decisión.
 *
 * PERO NO BASTA CON LA CONFIRMACIÓN, y esa fue la trampa. La exigencia de abono
 * la calcula la ficha, y quien la APLICA es la creación de la guía —que ocurre
 * en Preparación, cuando el pedido ya está confirmado—. Pidiéndola solo en
 * confirmación, el panel de Aliclik recibía «ninguno» y no dibujaba el campo de
 * justificación, mientras el servidor rechazaba la creación pidiendo justo esa
 * justificación. La regla se aplicaba donde su salida no existía y el pedido se
 * quedaba sin forma de avanzar (#KP128958, 17-08-2026).
 *
 * La regla queda aquí, y no dentro de un efecto de React, para poder afirmarla:
 * lo que hay que sostener es que la ficha esté disponible en TODO sitio donde su
 * resultado pueda frenar una acción.
 */
export function needsConfirmationBrief(
  macroStage: string | null | undefined,
  aliclikOffered: boolean,
): boolean {
  return macroStage === "por_confirmar" || aliclikOffered;
}

// ---------------------------------------------------------------------------
// Duplicados (MOM §8)
// ---------------------------------------------------------------------------

/**
 * Los pedidos del mismo teléfono que podrían ser ESTE pedido otra vez.
 *
 * Un duplicado es un pedido del mismo cliente que sigue ABIERTO: dos veces el
 * mismo formulario, o un pedido que se rehízo sin cerrar el anterior. Llamar sin
 * verlo termina en dos paquetes al mismo destino, y el flete de uno se pierde.
 *
 * Cerrados no cuentan: un cliente que ya recibió y vuelve a comprar no es un
 * duplicado, es un cliente recurrente — eso lo dicen los antecedentes, no esto.
 */
export function duplicateCandidates(
  priors: readonly PriorOrderSnapshot[],
): PriorOrderSnapshot[] {
  return priors.filter((row) => {
    const outcome = priorOutcome(row);
    return outcome === "en_curso" || outcome === "sin_confirmar";
  });
}
