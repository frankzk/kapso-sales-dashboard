// La etiqueta «¿tuvo pedidos antes?» de las listas (owner, 13-11-2026:
// «agrega también la etiqueta en el panel»). La misma identidad que «Historial
// del cliente» en la ficha (MOM §8.1): el teléfono. Pura: recibe las filas ya
// leídas y devuelve, por pedido, cuántos otros tiene ese teléfono y en qué
// terminaron. Quien lee es `loadPriorOrderCounts` (Repro Lima).

import { priorOutcome, type PriorOrderSnapshot } from "@/lib/order-confirmation-brief";

export interface PriorCounts {
  /** Otros pedidos del mismo teléfono (anteriores o posteriores). */
  others: number;
  delivered: number;
  /** Devueltos y anulados: los antecedentes del §8. */
  failed: number;
}

/** Cuántos pedidos se piden de una vez: lo visible de una lista. */
export const PRIOR_COUNTS_MAX_ORDERS = 200;

/** El teléfono como se compara: solo dígitos, los últimos 9 (sin el 51). */
export function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : null;
}

/**
 * Por pedido pedido, sus conteos. `targets` son los pedidos de la lista con su
 * teléfono; `history`, todos los pedidos de esos teléfonos (incluidos ellos
 * mismos, que no se cuentan). Un pedido sin teléfono no aparece: «sin dato» no
 * es «primer pedido».
 */
export function priorCountsByOrder(
  targets: readonly { order_id: string; customer_phone: string | null }[],
  history: readonly (Pick<PriorOrderSnapshot, "order_id" | "general_status" | "macro_stage"> & { customer_phone: string | null })[],
): Map<string, PriorCounts> {
  const byPhone = new Map<string, typeof history[number][]>();
  const seen = new Set<string>();
  for (const row of history) {
    const key = phoneKey(row.customer_phone);
    if (!key || seen.has(row.order_id)) continue;
    seen.add(row.order_id);
    const list = byPhone.get(key) ?? [];
    list.push(row);
    byPhone.set(key, list);
  }
  const out = new Map<string, PriorCounts>();
  for (const target of targets) {
    const key = phoneKey(target.customer_phone);
    if (!key) continue;
    const counts: PriorCounts = { others: 0, delivered: 0, failed: 0 };
    for (const row of byPhone.get(key) ?? []) {
      if (row.order_id === target.order_id) continue;
      counts.others += 1;
      // `priorOutcome` solo lee el estado general y la macroetapa.
      const outcome = priorOutcome({ order_name: null, order_created_at: null, order_total: null, ...row });
      if (outcome === "entregado") counts.delivered += 1;
      else if (outcome === "devuelto" || outcome === "anulado") counts.failed += 1;
    }
    out.set(target.order_id, counts);
  }
  return out;
}

/** El texto y el tono de la etiqueta. Corto: va debajo del nombre, en una línea. */
export function priorCountsLabel(c: PriorCounts): { text: string; tone: "info" | "ok" | "crit" | "neutral"; title: string } {
  if (c.others === 0) {
    return { text: "Primer pedido", tone: "info", title: "No hay otros pedidos con este teléfono." };
  }
  const parts = [`${c.others} ${c.others === 1 ? "pedido más" : "pedidos más"}`];
  if (c.delivered > 0) parts.push(`${c.delivered} ${c.delivered === 1 ? "recibido" : "recibidos"}`);
  else if (c.failed > 0) parts.push("ninguno recibido");
  return {
    text: parts.join(" · "),
    // Recibió alguna vez: verde. Nunca recibió y tiene devueltos o anulados: rojo.
    tone: c.delivered > 0 ? "ok" : c.failed > 0 ? "crit" : "neutral",
    title: `Otros pedidos con este teléfono: ${c.others}. Entregados: ${c.delivered}. Devueltos o anulados: ${c.failed}.`,
  };
}
