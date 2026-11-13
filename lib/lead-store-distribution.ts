import { pickNextLead, type NextLeadCandidate } from "@/lib/leads";
import { prioritizeDueAppointments } from "@/lib/lead-call-queue";

export type StoreWeights = Record<string, number>;
export interface LeadStoreDistribution {
  weights: StoreWeights | null;
  completed: Record<string, number>;
  /** «Leads por día» (0338): con valor, «Por llamar» muestra solo su lista del día (lib/lead-daily-list.ts). */
  capacity?: number | null;
}
export const PRIORITY_DISTRIBUTION: LeadStoreDistribution = { weights: null, completed: {} };
export function validStoreWeights(value: unknown): value is StoreWeights {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.length <= 100 && entries.every(([id, weight]) =>
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) &&
    Number.isInteger(weight) && weight >= 0 && weight <= 100,
  ) && entries.reduce((sum, [, weight]) => sum + weight, 0) === 100;
}

/** A preference, never an authorization filter. Pace against distinct leads
 * actually managed today; opening/skipping/reserving never advances the mix. */
export function pickDistributedLead<T extends NextLeadCandidate & { store_id: string }>(
  queue: readonly T[], opts: Parameters<typeof pickNextLead>[1], distribution: LeadStoreDistribution,
): T | null {
  const first = pickNextLead(queue, opts);
  if (!first || first.id === opts.current || !distribution.weights) return first;
  const now = opts.now ?? new Date();
  const available = queue.filter(row => pickNextLead([row], { ...opts, current: null }));
  const due = prioritizeDueAppointments(available, now.getTime())[0];
  if (due?.call_queue_ready && due.next_followup_at && Date.parse(due.next_followup_at) <= now.getTime()) return due;
  const weights = distribution.weights;
  const weightTotal = Object.values(weights).reduce((sum, weight) => sum + weight, 0) || 100;
  const total = Object.keys(weights).reduce((sum, id) => sum + Math.max(0, distribution.completed[id] ?? 0), 0);
  let best: T | null = null, deficit = -Infinity;
  for (const row of available) {
    const weight = weights[row.store_id] ?? 0;
    if (weight <= 0) continue;
    const score = weight * (total + 1) / weightTotal - Math.max(0, distribution.completed[row.store_id] ?? 0);
    // Strict > keeps the existing priority order within each store and on ties.
    if (score > deficit) { best = row; deficit = score; }
  }
  return best ?? first; // Empty preferred store must never strand an advisor.
}
