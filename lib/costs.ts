// Resolución de costos logísticos, de producto y adicionales. Puro + testeado.
//
// Dos ideas gobiernan este módulo:
//
//   1. VIGENCIA. Una tarifa es un número CON fecha. Al resolver el costo de un
//      pedido se pregunta siempre "¿qué tarifa regía el día que ocurrió?", nunca
//      "¿cuál rige hoy?". Así, subir el precio de reparto mañana no reescribe lo
//      que costaron los pedidos de la semana pasada.
//
//   2. ESPECIFICIDAD. La tarifa más concreta gana: distrito > provincia >
//      región > courier > tienda > general. Permite tener una tarifa base de la
//      organización y ajustar solo las excepciones, sin duplicar el resto.

export type CostConcept =
  | "primer_intento"
  | "intento_adicional"
  | "envio_agencia"
  | "devolucion"
  | "especial"
  // Pago AL motorizado (0054). Son costos como cualquier otro — llevan vigencia
  // y ámbito — así que se resuelven con este mismo motor en vez de duplicarlo.
  // Los consume lib/settlements.ts al liquidar; `computeLogisticsCost` no los
  // toca, porque el costo del envío y lo que se le paga al repartidor son cosas
  // distintas y sumarlas contaría el reparto dos veces.
  | "motorizado_entrega"
  | "motorizado_visita"
  | "motorizado_devolucion";

export const COST_CONCEPTS: { code: CostConcept; label: string }[] = [
  { code: "primer_intento", label: "Primer intento" },
  { code: "intento_adicional", label: "Intento adicional" },
  { code: "envio_agencia", label: "Envío por agencia" },
  { code: "devolucion", label: "Devolución" },
  { code: "especial", label: "Costo especial" },
  { code: "motorizado_entrega", label: "Motorizado · entrega" },
  { code: "motorizado_visita", label: "Motorizado · visita sin entrega" },
  { code: "motorizado_devolucion", label: "Motorizado · devolución" },
];

export interface CostTariff {
  id: string;
  /** Se usa al resolver coberturas entre varias organizaciones. */
  org_id?: string;
  store_id: string | null;
  courier: string | null;
  region: string | null;
  province: string | null;
  district: string | null;
  concept: string;
  amount: number;
  effective_from: string; // YYYY-MM-DD
  effective_to: string | null;
}

/** El pedido para el que se resuelve el costo. */
export interface CostContext {
  storeId: string;
  courier: string | null;
  region: string | null;
  province: string | null;
  district: string | null;
}

/** Comparación insensible a mayúsculas y acentos: los reportes escriben distinto. */
function sameLabel(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (v: string) =>
    v
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  return norm(a) === norm(b);
}

/** ¿La tarifa estaba vigente en esa fecha? Extremos inclusive. */
export function isEffectiveOn(tariff: { effective_from: string; effective_to: string | null }, day: string): boolean {
  if (day < tariff.effective_from) return false;
  return tariff.effective_to === null || day <= tariff.effective_to;
}

/**
 * Cuán específica es una tarifa para este pedido. `null` = no aplica (algún
 * campo del ámbito contradice al pedido). Números mayores ganan.
 *
 * Los pesos son potencias separadas para que un criterio más fino nunca pueda
 * ser superado por la suma de otros más gruesos: un acuerdo por distrito manda
 * sobre cualquier combinación de región y courier.
 */
export function specificity(tariff: CostTariff, ctx: CostContext): number | null {
  let score = 0;

  if (tariff.store_id) {
    if (tariff.store_id !== ctx.storeId) return null;
    score += 1;
  }
  if (tariff.courier) {
    if (!sameLabel(tariff.courier, ctx.courier)) return null;
    score += 2;
  }
  if (tariff.region) {
    if (!sameLabel(tariff.region, ctx.region)) return null;
    score += 4;
  }
  if (tariff.province) {
    if (!sameLabel(tariff.province, ctx.province)) return null;
    score += 8;
  }
  if (tariff.district) {
    if (!sameLabel(tariff.district, ctx.district)) return null;
    score += 16;
  }
  return score;
}

/**
 * Tarifa aplicable a un pedido para un concepto y una fecha. Entre dos igual de
 * específicas gana la que empezó a regir más tarde: es la corrección más
 * reciente de ese mismo ámbito.
 */
export function resolveTariff(
  tariffs: readonly CostTariff[],
  concept: CostConcept,
  ctx: CostContext,
  day: string,
): CostTariff | null {
  let best: { tariff: CostTariff; score: number } | null = null;
  for (const tariff of tariffs) {
    if (tariff.concept !== concept) continue;
    if (!isEffectiveOn(tariff, day)) continue;
    const score = specificity(tariff, ctx);
    if (score === null) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && tariff.effective_from > best.tariff.effective_from)
    ) {
      best = { tariff, score };
    }
  }
  return best?.tariff ?? null;
}

export interface LogisticsCostInput {
  ctx: CostContext;
  /** Intentos de entrega realizados (el primero se cobra distinto). */
  attempts: number;
  /** Estado general resuelto del pedido. */
  generalStatus: string;
  /** ¿Fue un envío por agencia? */
  agency: boolean;
  /** Día al que se imputa el costo (YYYY-MM-DD): el del último movimiento. */
  day: string;
  /**
   * Lo que el courier cobró DE VERDAD por este envío concreto, cuando lo sabemos.
   *
   * Las tarifas de `cost_tariffs` son una aproximación por ámbito geográfico:
   * existen porque históricamente el courier no nos decía el precio de cada
   * guía. Aliclik sí lo dice al cotizar, y ese número se guarda en la guía. Un
   * precio exacto siempre le gana a una tarifa por distrito — y además hace que
   * el margen del pedido deje de depender de que alguien mantenga la tabla al
   * día.
   *
   * Solo sustituye los conceptos que el courier cotiza: la entrega y la
   * devolución. Los intentos adicionales siguen saliendo de la tarifa, porque
   * la cotización es del envío, no de cuántas veces se tocó la puerta.
   */
  actual?: { delivery?: number | null; return?: number | null };
}

export interface LogisticsCostBreakdown {
  total: number;
  lines: {
    concept: CostConcept;
    amount: number;
    quantity: number;
    /** De dónde salió el importe: la tarifa configurada o el courier. */
    source?: "tarifa" | "courier";
  }[];
  /** Conceptos que no tienen tarifa configurada para este pedido. */
  missing: CostConcept[];
}

/**
 * Costo logístico de un pedido. Suma el primer intento, los adicionales, el
 * envío por agencia cuando corresponde y la devolución cuando la hubo.
 *
 * Un pedido ANULADO en Lima no genera costo de devolución (§9: allí no hay
 * retorno físico); uno DEVUELTO sí, y por eso el estado importa aquí.
 *
 * Los conceptos sin tarifa configurada se devuelven en `missing` en vez de
 * contarse como cero: un costo ausente y un costo de cero no son lo mismo, y el
 * equipo tiene que poder ver cuál le falta configurar.
 */
export function computeLogisticsCost(
  tariffs: readonly CostTariff[],
  input: LogisticsCostInput,
): LogisticsCostBreakdown {
  const lines: LogisticsCostBreakdown["lines"] = [];
  const missing: CostConcept[] = [];

  const real = (v: number | null | undefined): number | null =>
    v != null && Number.isFinite(v) && v >= 0 ? v : null;

  const add = (concept: CostConcept, quantity: number, actual?: number | null) => {
    if (quantity <= 0) return;
    // El precio real del courier gana. Y cuando lo hay, el concepto NO puede
    // figurar en `missing`: no falta configurar nada, se sabe lo que costó.
    const exact = real(actual);
    if (exact !== null) {
      lines.push({ concept, amount: round2(exact * quantity), quantity, source: "courier" });
      return;
    }
    const tariff = resolveTariff(tariffs, concept, input.ctx, input.day);
    if (!tariff) {
      missing.push(concept);
      return;
    }
    lines.push({ concept, amount: tariff.amount * quantity, quantity, source: "tarifa" });
  };

  if (input.agency) {
    add("envio_agencia", 1);
  } else {
    // Sin intentos reportados se asume uno: el pedido salió a reparto.
    const attempts = Math.max(1, input.attempts);
    add("primer_intento", 1, input.actual?.delivery);
    add("intento_adicional", attempts - 1);
  }

  if (input.generalStatus === "devuelto") add("devolucion", 1, input.actual?.return);

  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  return { total: round2(total), lines, missing };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Costos de producto y adicionales
// ---------------------------------------------------------------------------

export interface ProductCost {
  id: string;
  store_id: string | null;
  sku: string;
  unit_cost: number;
  effective_from: string;
  effective_to: string | null;
}

/** Costo unitario vigente de un SKU. La tarifa por tienda gana a la general. */
export function resolveProductCost(
  costs: readonly ProductCost[],
  sku: string,
  storeId: string,
  day: string,
): ProductCost | null {
  let best: ProductCost | null = null;
  for (const cost of costs) {
    if (!sameLabel(cost.sku, sku)) continue;
    if (!isEffectiveOn(cost, day)) continue;
    if (cost.store_id && cost.store_id !== storeId) continue;
    if (
      !best ||
      // Más específica (por tienda) primero; a igualdad, la más reciente.
      (cost.store_id && !best.store_id) ||
      (Boolean(cost.store_id) === Boolean(best.store_id) && cost.effective_from > best.effective_from)
    ) {
      best = cost;
    }
  }
  return best;
}

export interface AdditionalCost {
  id: string;
  store_id: string | null;
  concept: string;
  amount: number;
  basis: string; // pedido | porcentaje
  effective_from: string;
  effective_to: string | null;
}

/**
 * Costos adicionales de un pedido (empaque, materiales, preparación,
 * comisiones). Los porcentuales se calculan sobre el total del pedido.
 */
export function computeAdditionalCosts(
  costs: readonly AdditionalCost[],
  input: { storeId: string; orderTotal: number | null; day: string },
): { total: number; lines: { concept: string; amount: number }[] } {
  const lines: { concept: string; amount: number }[] = [];
  for (const cost of costs) {
    if (!isEffectiveOn(cost, input.day)) continue;
    if (cost.store_id && cost.store_id !== input.storeId) continue;
    const amount =
      cost.basis === "porcentaje"
        ? ((input.orderTotal ?? 0) * cost.amount) / 100
        : cost.amount;
    lines.push({ concept: cost.concept, amount: round2(amount) });
  }
  return { total: round2(lines.reduce((sum, l) => sum + l.amount, 0)), lines };
}

/** Día (YYYY-MM-DD) al que se imputa el costo de un pedido. */
export function costDay(
  row: { last_movement_at: string | null; order_created_at: string | null },
  fallback: string = new Date().toISOString(),
): string {
  return (row.last_movement_at ?? row.order_created_at ?? fallback).slice(0, 10);
}
