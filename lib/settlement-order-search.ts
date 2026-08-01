/**
 * Reglas puras del buscador manual de pedidos dentro de Liquidaciones.
 *
 * Las pistas de tienda, nombre, distrito y fecha ayudan a proponer candidatos,
 * pero no son identidades. Un código Shopify exacto sí lo es y nunca debe quedar
 * oculto por una pista equivocada del reporte del courier.
 */

export function settlementMatchKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function directOrderSearchTerm(query: string): string | null {
  const cleaned = query
    .trim()
    .replace(/^#+/, "")
    .replace(/[%_*,]/g, "")
    .trim();
  return settlementMatchKey(cleaned).length >= 3 ? cleaned : null;
}

export function settlementStoreMatchesHint(storeName: string, storeHint: string): boolean {
  const store = settlementMatchKey(storeName);
  const hint = settlementMatchKey(storeHint);
  if (!hint) return true;
  return store === hint || store.startsWith(hint) || (store.length > 0 && hint.startsWith(store));
}

export function evaluateSettlementCandidateScope(input: {
  orderName: string | null;
  storeName: string;
  storeHint: string;
  query: string;
}): {
  exactOrderCode: boolean;
  storeMatches: boolean;
  allowed: boolean;
  warning: string | null;
} {
  const query = settlementMatchKey(input.query);
  const exactOrderCode = Boolean(query && settlementMatchKey(input.orderName) === query);
  const storeMatches = settlementStoreMatchesHint(input.storeName, input.storeHint);

  return {
    exactOrderCode,
    storeMatches,
    allowed: storeMatches || exactOrderCode,
    warning:
      exactOrderCode && !storeMatches
        ? `La liquidación indica ${input.storeHint}, pero el pedido pertenece a ${input.storeName}.`
        : null,
  };
}
