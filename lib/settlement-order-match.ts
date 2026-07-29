export interface SettlementOrderMatchInput {
  orderName: string | null;
  storeName: string;
  customerName: string | null;
  district: string | null;
  total: number | null;
}

export interface SettlementOrderMatchContext {
  storeHint: string | null;
  customerName: string | null;
  district: string | null;
  declaredAmount: number | null;
  query: string;
}

export interface SettlementOrderMatchScore {
  score: number;
  reasons: string[];
  storeMatchesHint: boolean | null;
}

export function settlementMatchKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function matchesStoreHint(storeName: string, storeHint: string): boolean {
  return (
    storeName === storeHint ||
    storeName.startsWith(storeHint) ||
    (storeName.length > 0 && storeHint.startsWith(storeName))
  );
}

/**
 * Puntúa un pedido sin excluirlo por la tienda declarada por el courier.
 * Esa tienda puede estar equivocada; sirve para ordenar, no para impedir un
 * cotejo manual con otra tienda autorizada.
 */
export function scoreSettlementOrderMatch(
  candidate: SettlementOrderMatchInput,
  context: SettlementOrderMatchContext,
): SettlementOrderMatchScore | null {
  const store = settlementMatchKey(candidate.storeName);
  const storeHint = settlementMatchKey(context.storeHint);
  const name = settlementMatchKey(candidate.customerName);
  const wantedName = settlementMatchKey(context.customerName);
  const district = settlementMatchKey(candidate.district);
  const wantedDistrict = settlementMatchKey(context.district);
  const orderName = settlementMatchKey(candidate.orderName);
  const wantedQuery = settlementMatchKey(context.query);
  const reasons: string[] = [];
  let score = 0;
  let storeMatchesHint: boolean | null = null;

  if (storeHint) {
    storeMatchesHint = matchesStoreHint(store, storeHint);
    if (storeMatchesHint) {
      score += 35;
      reasons.push(`tienda ${candidate.storeName}`);
    } else {
      reasons.push(`tienda distinta a ${context.storeHint}`);
    }
  }

  if (wantedName && name === wantedName) {
    score += 45;
    reasons.push("nombre exacto");
  } else if (wantedName && (name.startsWith(wantedName) || wantedName.startsWith(name))) {
    score += 32;
    reasons.push("nombre similar");
  }

  if (wantedDistrict && district === wantedDistrict) {
    score += 15;
    reasons.push("mismo distrito");
  }

  if (
    context.declaredAmount !== null &&
    candidate.total !== null &&
    Math.abs(Number(context.declaredAmount) - Number(candidate.total)) < 0.01
  ) {
    score += 15;
    reasons.push("mismo monto");
  }

  if (wantedQuery) {
    if (orderName === wantedQuery) {
      score += 60;
      reasons.push("código exacto");
    } else if (orderName.includes(wantedQuery)) {
      score += 45;
      reasons.push("código coincidente");
    } else if (name === wantedQuery) {
      score += 40;
      reasons.push("búsqueda por nombre exacto");
    } else if (!name.includes(wantedQuery) && !district.includes(wantedQuery)) {
      return null;
    }
  }

  return {
    score: Math.min(100, score),
    reasons,
    storeMatchesHint,
  };
}
