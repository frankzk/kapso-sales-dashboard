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
export function confirmationRisk(counts: OutcomeCounts): ConfirmationRisk {
  const antecedents = counts.anulado + counts.devuelto;
  const reasons: string[] = [];

  if (counts.anulado > 0) {
    reasons.push(`${counts.anulado} pedido${counts.anulado === 1 ? "" : "s"} anulado${counts.anulado === 1 ? "" : "s"}.`);
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
