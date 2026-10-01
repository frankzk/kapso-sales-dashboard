import type { LeadCounts, LeadView } from "./leads-access";
import type { LeadRow } from "./types";

/** Same membership predicates as getStoreLeads / lead_queue_counts (0059).
 * Only used to reconcile a confirmed write; periodic reads remain authoritative. */
export function leadMembership(lead: LeadRow, now = Date.now()): LeadCounts {
  const callable = lead.category === "open" || lead.category === "hot";
  return {
    por_llamar: Number(callable && lead.status != null && lead.status !== "yape_por_verificar"),
    handoff: Number(!!lead.needs_attention && !!lead.handoff_at && Date.parse(lead.handoff_at) >= now - 24 * 3_600_000),
    yape: Number(lead.status === "yape_por_verificar"),
    seguimientos: Number(!!lead.next_followup_at && Date.parse(lead.next_followup_at) <= now),
    ganados: Number(lead.category === "won"),
    perdidos: Number(lead.category === "lost"),
    sin_llamar: Number(callable && lead.status === "nuevo"),
  };
}

export function patchLeadRows(rows: LeadRow[], id: string, patch: Partial<LeadRow>, view?: LeadView, fallback?: LeadRow | null): LeadRow[] {
  const updatedRows = rows.flatMap((row) => {
    if (row.id !== id) return [row];
    const updated = { ...row, ...patch };
    return view && !leadMembership(updated)[view] ? [] : [updated];
  });
  // A lead opened through global search can enter the current view after a
  // disposition (e.g. Yape -> follow-up). It was absent from the loaded list.
  if (view && fallback?.id === id && !rows.some((row) => row.id === id)) {
    const updated = { ...fallback, ...patch };
    if (leadMembership(updated)[view]) updatedRows.unshift(updated);
  }
  return updatedRows;
}

export function patchLeadCounts(counts: LeadCounts, before: LeadRow, patch: Partial<LeadRow>, now = Date.now()): LeadCounts {
  const previous = leadMembership(before, now);
  const next = leadMembership({ ...before, ...patch }, now);
  const result = { ...counts };
  for (const key of Object.keys(result) as (keyof LeadCounts)[]) {
    result[key] = Math.max(0, result[key] + next[key] - previous[key]);
  }
  return result;
}
