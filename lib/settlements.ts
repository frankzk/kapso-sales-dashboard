// Cuadre de la liquidación del motorizado y cálculo de lo que se le paga.
// Puro + testeado: sin base de datos, sin red. La escritura vive en
// lib/settlement-ingest.ts y las lecturas en lib/settlements-access.ts.
//
// Dos ideas gobiernan este módulo:
//
//   1. LO DECLARADO NUNCA PISA LO REAL. La hoja del motorizado dice qué entregó
//      y cuánto cobró; el Master dice qué pasó de verdad con esa guía. Aquí solo
//      se COMPARAN y se nombra la diferencia. Ninguna función de este archivo
//      corrige el Master: un descuadre es información para una persona, no una
//      corrección automática. Adivinar aquí es inventar plata.
//
//   2. SON DOS CUADRES, NO UNO. Se responden por separado dos preguntas que
//      suelen confundirse:
//        a) ¿lo que declaró coincide con lo que dice el Master?  → `difference`
//        b) ¿depositó lo que él mismo declaró haber cobrado?     → `depositDifference`
//      Un motorizado puede declarar honestamente y depositar de menos, o
//      depositar exacto lo que declaró habiendo declarado mal. Son problemas
//      distintos y se persiguen distinto.

import { resolveTariff, type CostContext, type CostTariff } from "@/lib/costs";

/** Céntimos: por debajo de esto dos montos son el mismo. Evita que el ruido de
 *  coma flotante convierta un cuadre exacto en un descuadre de S/ 0.0000001. */
const EPSILON = 0.005;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Veredicto de una línea de la liquidación. */
export type SettlementVerdict =
  /** Lo declarado coincide con el Master. */
  | "conforme"
  /** Declaró MÁS plata de la que vale el pedido. */
  | "cobro_de_mas"
  /** Declaró MENOS plata de la que vale el pedido (faltante parcial). */
  | "cobro_de_menos"
  /** El Master lo da por entregado y la hoja no declara ni un sol. */
  | "entregado_sin_cobro"
  /** Declara plata de una guía que el Master NO da por entregada. */
  | "cobro_sin_entrega"
  /** La línea no está vinculada a ningún pedido: no se puede cuadrar. */
  | "sin_pedido";

export const VERDICT_LABELS: Record<SettlementVerdict, string> = {
  conforme: "Conforme",
  cobro_de_mas: "Cobró de más",
  cobro_de_menos: "Cobró de menos",
  entregado_sin_cobro: "Entregado sin cobro",
  cobro_sin_entrega: "Cobro sin entrega",
  sin_pedido: "Sin pedido",
};

/** Un veredicto que exige que alguien lo mire antes de cerrar. */
export function isMismatch(verdict: SettlementVerdict): boolean {
  return verdict !== "conforme";
}

/** Una línea tal como está guardada, antes de cuadrarse. */
export interface SettlementLineInput {
  id: string;
  order_id: string | null;
  guide_code: string | null;
  order_name: string | null;
  declared_status: string | null;
  declared_amount: number | null;
  match_status: string;
}

/** Lo que el Master sabe de ese pedido. Subconjunto de OrderMasterRow, para que
 *  este módulo se pueda probar sin construir una fila entera. */
export interface SettlementMasterFacts {
  order_id: string;
  general_status: string;
  order_total: number | null;
  current_courier: string | null;
  region: string | null;
  province: string | null;
  district: string | null;
  store_id: string;
}

export interface ReconciledLine {
  line: SettlementLineInput;
  facts: SettlementMasterFacts | null;
  verdict: SettlementVerdict;
  /** Lo que el motorizado declaró haber cobrado. */
  declared: number;
  /** Lo que debía traer según el Master: el total del pedido si está entregado. */
  expected: number;
  /** declarado − esperado. Positivo = trae de más; negativo = falta. */
  difference: number;
  /** ¿El Master da esta guía por entregada? */
  delivered: boolean;
}

/** RAÍCES con las que un motorizado escribe "entregado" en una hoja. Raíces y no
 *  palabras completas porque en un cuaderno aparece "entregado", "entregada",
 *  "entregué", "entrego" y "entrega" indistintamente, y todas quieren decir lo
 *  mismo. Las negaciones se descartan antes de llegar aquí. */
const DELIVERED_STEMS = ["entreg", "cobrad", "cobre", "pagad", "ok", "conforme"];

function normalize(value: string | null): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

/** ¿La hoja declara esta guía como entregada? Se exporta para poder probar la
 *  tolerancia a cómo escribe cada motorizado. */
export function declaresDelivered(declaredStatus: string | null): boolean {
  const s = normalize(declaredStatus);
  if (!s) return false;
  // "no entregado" / "no entrega" niegan explícitamente: se miran antes.
  if (/^(no|sin)\b/.test(s)) return false;
  if (s.includes("rechaz") || s.includes("devolu") || s.includes("anul")) return false;
  return DELIVERED_STEMS.some((w) => s.includes(w));
}

/**
 * Cuadra UNA línea contra lo que sabe el Master.
 *
 * El estado escrito en la hoja es una pista secundaria: lo que manda para
 * decidir si hubo entrega es el Master, porque es lo que alimentan los reportes
 * del courier y las acciones del equipo. La hoja aporta el DINERO, que es lo que
 * el Master no sabe.
 */
export function reconcileLine(
  line: SettlementLineInput,
  facts: SettlementMasterFacts | null,
): ReconciledLine {
  const declared = round2(Math.max(0, line.declared_amount ?? 0));

  // Sin vínculo no hay nada contra qué cuadrar. No se inventa un veredicto.
  if (!facts || line.match_status !== "ok" || !line.order_id) {
    return {
      line,
      facts,
      verdict: "sin_pedido",
      declared,
      expected: 0,
      difference: 0,
      delivered: false,
    };
  }

  const delivered = facts.general_status === "entregado";
  const expected = delivered ? round2(facts.order_total ?? 0) : 0;
  const difference = round2(declared - expected);

  let verdict: SettlementVerdict;
  if (!delivered) {
    // El Master no lo da por entregado. Si aun así trae plata, hay que mirarlo:
    // o el reporte del courier va atrasado, o esa plata no es de esta guía.
    verdict = declared > EPSILON ? "cobro_sin_entrega" : "conforme";
  } else if (declared <= EPSILON && expected > EPSILON) {
    verdict = "entregado_sin_cobro";
  } else if (difference > EPSILON) {
    verdict = "cobro_de_mas";
  } else if (difference < -EPSILON) {
    verdict = "cobro_de_menos";
  } else {
    verdict = "conforme";
  }

  return { line, facts, verdict, declared, expected, difference, delivered };
}

export interface SettlementTotals {
  /** Suma de lo declarado línea a línea. */
  declaredTotal: number;
  /** Suma de lo que debía traer según el Master. */
  expectedTotal: number;
  /** declarado − esperado. Negativo = falta plata. */
  difference: number;
  /** Lo que dice haber depositado (efectivo + Yape). */
  depositTotal: number;
  /** depositado − declarado. Negativo = declaró más de lo que entregó. */
  depositDifference: number;
  deliveredCount: number;
  mismatchCount: number;
  reviewCount: number;
  /** Cuadra del todo: sin descuadres de monto, sin líneas sin vincular y con el
   *  depósito igual a lo declarado. Es la condición para poder cerrarla. */
  balanced: boolean;
}

export interface ReconciledSettlement {
  lines: ReconciledLine[];
  totals: SettlementTotals;
}

/**
 * Cuadra la liquidación entera. `facts` se indexa por `order_id`; una línea sin
 * su entrada queda como "sin pedido" en vez de asumir que no se entregó.
 */
export function reconcileSettlement(
  lines: readonly SettlementLineInput[],
  facts: ReadonlyMap<string, SettlementMasterFacts>,
  deposit: { cash?: number | null; yape?: number | null } = {},
): ReconciledSettlement {
  const reconciled = lines.map((l) =>
    reconcileLine(l, l.order_id ? (facts.get(l.order_id) ?? null) : null),
  );

  const declaredTotal = round2(reconciled.reduce((s, r) => s + r.declared, 0));
  const expectedTotal = round2(reconciled.reduce((s, r) => s + r.expected, 0));
  const depositTotal = round2(Math.max(0, deposit.cash ?? 0) + Math.max(0, deposit.yape ?? 0));
  const mismatchCount = reconciled.filter((r) => isMismatch(r.verdict)).length;
  const reviewCount = reconciled.filter((r) => r.verdict === "sin_pedido").length;
  const depositDifference = round2(depositTotal - declaredTotal);

  return {
    lines: reconciled,
    totals: {
      declaredTotal,
      expectedTotal,
      difference: round2(declaredTotal - expectedTotal),
      depositTotal,
      depositDifference,
      deliveredCount: reconciled.filter((r) => r.delivered).length,
      mismatchCount,
      reviewCount,
      balanced: mismatchCount === 0 && Math.abs(depositDifference) <= EPSILON,
    },
  };
}

// ---------------------------------------------------------------------------
// Pago al motorizado.
// ---------------------------------------------------------------------------

/** Conceptos de `cost_tariffs` (0054) con los que se paga al motorizado. */
export type RiderPayConcept =
  | "motorizado_entrega"
  | "motorizado_visita"
  | "motorizado_devolucion";

export interface RiderPayoutLine {
  lineId: string;
  concept: RiderPayConcept;
  amount: number;
  /** true cuando no había tarifa vigente para ese ámbito y día: se paga 0 y se
   *  avisa, en vez de inventar un número. */
  missingTariff: boolean;
}

export interface RiderPayout {
  lines: RiderPayoutLine[];
  /** Suma de las tarifas: lo que se gana por repartir. */
  gross: number;
  /** Plata que falta respecto de lo que dice el Master, si se descuenta. */
  shortfall: number;
  /** gross − shortfall, nunca por debajo de cero. */
  net: number;
  /** Líneas sin tarifa vigente: hay que definirla antes de cerrar. */
  missingTariffs: number;
}

export interface RiderPayoutOptions {
  /**
   * Descontar del pago lo que falte respecto del Master. Por defecto NO: que un
   * faltante se cobre o se perdone es una decisión de la empresa, no del
   * cálculo. Cuando se activa, el descuento nunca deja el pago en negativo.
   */
  deductShortfall?: boolean;
}

/** El concepto con el que se le paga esa línea. */
function payConcept(r: ReconciledLine): RiderPayConcept {
  if (r.delivered) return "motorizado_entrega";
  if (r.facts?.general_status === "devuelto" || r.facts?.general_status === "anulado") {
    return "motorizado_devolucion";
  }
  // Fue, no entregó y la guía sigue viva: es una visita.
  return "motorizado_visita";
}

/**
 * Lo que se le paga al motorizado por esta liquidación.
 *
 * Reutiliza `resolveTariff` de lib/costs.ts, así que hereda las dos reglas del
 * módulo de Costos: la tarifa se resuelve al DÍA de la liquidación (subir el
 * precio mañana no reescribe lo que se pagó ayer) y gana la más específica
 * (distrito > provincia > región > courier > tienda > general).
 *
 * Las líneas sin vincular no se pagan: pagar una guía que no se sabe de qué
 * pedido es sería pagar por algo que quizá no ocurrió.
 */
export function computeRiderPayout(
  reconciled: readonly ReconciledLine[],
  tariffs: readonly CostTariff[],
  day: string,
  opts: RiderPayoutOptions = {},
): RiderPayout {
  const lines: RiderPayoutLine[] = [];

  for (const r of reconciled) {
    if (!r.facts || r.verdict === "sin_pedido") continue;
    const concept = payConcept(r);
    const ctx: CostContext = {
      storeId: r.facts.store_id,
      courier: r.facts.current_courier,
      region: r.facts.region,
      province: r.facts.province,
      district: r.facts.district,
    };
    const tariff = resolveTariff(tariffs, concept, ctx, day);
    lines.push({
      lineId: r.line.id,
      concept,
      amount: tariff ? round2(tariff.amount) : 0,
      missingTariff: tariff === null,
    });
  }

  const gross = round2(lines.reduce((s, l) => s + l.amount, 0));
  // Solo el faltante cuenta como descuento: que traiga de más no le suma sueldo,
  // se devuelve aparte.
  const shortfall = round2(
    reconciled.reduce((s, r) => s + (r.difference < 0 ? -r.difference : 0), 0),
  );
  const net = opts.deductShortfall ? round2(Math.max(0, gross - shortfall)) : gross;

  return {
    lines,
    gross,
    shortfall,
    net,
    missingTariffs: lines.filter((l) => l.missingTariff).length,
  };
}

/** Estado que le corresponde a la liquidación según su cuadre. No incluye
 *  "cerrada": cerrar es un acto de una persona, no una consecuencia. */
export function settlementStatus(totals: SettlementTotals): "cuadrada" | "con_descuadre" {
  return totals.balanced ? "cuadrada" : "con_descuadre";
}
