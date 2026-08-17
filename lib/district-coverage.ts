// Excepciones de cobertura por distrito (0121). Puro.
//
// Qué cobertura tiene un distrito es una decisión COMERCIAL, no geográfica:
// Pucusana está en la provincia de Lima y el clasificador lo da por reparto
// propio, pero la operación lo atiende por agencia. Esta es la lista de esas
// decisiones, y nace vacía: solo guarda lo que se aparta de la regla general.
//
// QUIÉN MANDA. La definición canónica de la cobertura vive en la BASE
// (`order_coverage_for`), y ahí es donde se consulta esta tabla de verdad. Lo de
// acá es el espejo del respaldo en TypeScript: `classifyOrderCoverage` solo
// corre cuando la base no pudo responder, y si aplicara otra precedencia daría
// una respuesta distinta a la misma pregunta — exactamente el bug que motivó la
// 0104. Por eso el ORDEN es el mismo y está escrito en los dos sitios.

/** Igual que `coverage_norm` en la base: sin tildes, minúsculas, sin puntuación. */
export function normalizeDistrictKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type DistrictCoverageValue = "lima" | "provincia_cod" | "agencia";

export interface DistrictCoverageRule {
  /** `null` = vale para todas las tiendas. */
  store_id: string | null;
  /** Ya normalizado con `normalizeDistrictKey`. */
  district: string;
  coverage: DistrictCoverageValue;
}

/**
 * La excepción que aplica a este destino, o `null` si no hay ninguna.
 *
 * La regla de una TIENDA gana sobre la global: es lo que permite que Kenku y
 * Aurela difieran en un destino sin duplicar el resto de la lista. Es el mismo
 * `order by store_id nulls last` de la base.
 */
export function findDistrictOverride(
  rules: readonly DistrictCoverageRule[],
  storeId: string | null | undefined,
  district: string | null | undefined,
): DistrictCoverageValue | null {
  const key = normalizeDistrictKey(district);
  if (!key) return null;

  let global: DistrictCoverageValue | null = null;
  for (const rule of rules) {
    if (rule.district !== key) continue;
    if (rule.store_id && rule.store_id === storeId) return rule.coverage;
    if (!rule.store_id) global = rule.coverage;
  }
  return global;
}
