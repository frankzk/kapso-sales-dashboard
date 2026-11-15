// La lista del día de una asesora (owner, 13-11-2026): «una persona puede
// atender unos 250 leads al día; que se le asignen 250, 90 % Aurela y 10 %
// Kenku, dando prioridad a los más prioritarios», porque «a Daphne aún le
// muestra los más de 1000 pendientes».
//
// QUÉ ES. Solo para quien tiene «Leads por día» puesto en Equipo
// (`lead_routing_assignments.daily_capacity`). De su «Por llamar», ya ordenado
// por prioridad (citas vencidas, hora dorada, el puntaje de siempre), se toman
// los primeros de cada tienda según sus porcentajes: con 250 y 90/10, 225 de
// Aurela y 25 de Kenku. Lo que una tienda no alcanza a llenar se completa con
// los siguientes más prioritarios de las otras (owner: «completar con Kenku»).
// Sin porcentajes, los `capacity` más prioritarios.
//
// ES UNA VISTA, NO UNA RESERVA (owner: «compartida»): otra asesora puede tomar
// el mismo lead. Se recalcula sola: lo gestionado sale de «Por llamar» y entra
// el siguiente; un lead nuevo y caliente entra arriba. «En seguimiento» no se
// toca. Pura.

import type { StoreWeights } from "@/lib/lead-store-distribution";

export interface DailyListPlan {
  /** Leads por día (1–1000). */
  capacity: number;
  /** Porcentajes por tienda (suman 100), o null: los más prioritarios sin mezcla. */
  weights: StoreWeights | null;
}

/** Cuántos de cada tienda: la parte entera y, lo que sobra, por resto mayor. */
export function dailyQuotas(capacity: number, weights: StoreWeights): Record<string, number> {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (!total) return {};
  const raw = entries.map(([id, w]) => ({ id, exact: (capacity * w) / total }));
  const quotas: Record<string, number> = Object.fromEntries(raw.map((r) => [r.id, Math.floor(r.exact)]));
  let left = capacity - Object.values(quotas).reduce((s, n) => s + n, 0);
  for (const r of [...raw].sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)))) {
    if (left <= 0) break;
    quotas[r.id] = (quotas[r.id] ?? 0) + 1;
    left -= 1;
  }
  return quotas;
}

/**
 * Los ids de la lista del día, de `ranked` (la cola «Por llamar» YA ordenada
 * por prioridad). Cada tienda llena su cupo con sus primeros; lo que falte se
 * completa, en orden de prioridad, con lo que quedó de cualquier tienda.
 */
export function dailyLeadList<T extends { id: string; store_id: string }>(ranked: readonly T[], plan: DailyListPlan): Set<string> {
  const capacity = Math.max(0, Math.floor(plan.capacity));
  const chosen = new Set<string>();
  if (!capacity) return chosen;
  if (!plan.weights) {
    for (const row of ranked) {
      if (chosen.size >= capacity) break;
      chosen.add(row.id);
    }
    return chosen;
  }
  const quotas = dailyQuotas(capacity, plan.weights);
  const taken: Record<string, number> = {};
  for (const row of ranked) {
    const quota = quotas[row.store_id] ?? 0;
    if ((taken[row.store_id] ?? 0) >= quota) continue;
    chosen.add(row.id);
    taken[row.store_id] = (taken[row.store_id] ?? 0) + 1;
  }
  for (const row of ranked) {
    if (chosen.size >= capacity) break;
    chosen.add(row.id);
  }
  return chosen;
}

/** Lo que dice la cabecera: «Tu lista del día: 250 · 225 Aurela · 25 Kenku Peru». */
export function dailyListSummary(
  rows: readonly { store_id: string }[],
  storeNames: ReadonlyMap<string, string>,
): string {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.store_id, (by.get(r.store_id) ?? 0) + 1);
  const parts = [...by.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${n.toLocaleString("es-PE")} ${storeNames.get(id) ?? "otra tienda"}`);
  return [`Tu lista del día: ${rows.length.toLocaleString("es-PE")}`, ...parts].join(" · ");
}
