// Per-advisor (vendedora) productivity for a date range. Activity comes from
// `lead_calls`; a won lead is credited to the advisor who registered the LAST
// call on it within the period (last-touch attribution). Pure aggregation is
// split from the fetch so it can be unit-tested.

import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import type { DateRange } from "@/lib/access";

export interface AdvisorStat {
  userId: string;
  email: string;
  llamadas: number; // calls of kind="call"
  leadsTrabajados: number; // distinct leads touched
  cerrados: number; // touched leads now won, attributed by last touch
  ingresos: number; // net revenue (total - refunded) of those orders
  conversion: number; // cerrados / leadsTrabajados, 0..1
}

export interface AdvisorCall {
  vendedora: string;
  lead_id: string;
  kind: string;
  occurred_at: string;
}

export interface ProductivityInput {
  calls: AdvisorCall[];
  /** Outcome of every touched lead: won? + net order revenue. */
  leadOutcome: Map<string, { won: boolean; net: number }>;
  emailById: Map<string, string>;
}

/** Aggregate advisor activity + last-touch-attributed wins. Pure. */
export function computeAdvisorStats({ calls, leadOutcome, emailById }: ProductivityInput): AdvisorStat[] {
  const agg = new Map<string, { llamadas: number; leads: Set<string> }>();
  const lastCaller = new Map<string, { vendedora: string; at: string }>();

  for (const c of calls) {
    if (!c.vendedora) continue;
    const a = agg.get(c.vendedora) ?? { llamadas: 0, leads: new Set<string>() };
    if (c.kind === "call") a.llamadas += 1;
    a.leads.add(c.lead_id);
    agg.set(c.vendedora, a);

    const prev = lastCaller.get(c.lead_id);
    if (!prev || c.occurred_at > prev.at) lastCaller.set(c.lead_id, { vendedora: c.vendedora, at: c.occurred_at });
  }

  const won = new Map<string, { cerrados: number; ingresos: number }>();
  for (const [leadId, lc] of lastCaller) {
    const o = leadOutcome.get(leadId);
    if (!o?.won) continue;
    const w = won.get(lc.vendedora) ?? { cerrados: 0, ingresos: 0 };
    w.cerrados += 1;
    w.ingresos += o.net;
    won.set(lc.vendedora, w);
  }

  const rows: AdvisorStat[] = [];
  for (const [userId, a] of agg) {
    const w = won.get(userId) ?? { cerrados: 0, ingresos: 0 };
    const leadsTrabajados = a.leads.size;
    rows.push({
      userId,
      email: emailById.get(userId) ?? userId,
      llamadas: a.llamadas,
      leadsTrabajados,
      cerrados: w.cerrados,
      ingresos: w.ingresos,
      conversion: leadsTrabajados ? w.cerrados / leadsTrabajados : 0,
    });
  }
  rows.sort((x, y) => y.ingresos - x.ingresos || y.cerrados - x.cerrados || y.llamadas - x.llamadas);
  return rows;
}

/** Resolve advisor user_ids → emails via the auth admin API (team-page pattern). */
async function resolveEmails(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!userIds.length) return map;
  const want = new Set(userIds);
  const admin = createAdminSupabase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data) break;
    for (const u of data.users) if (want.has(u.id)) map.set(u.id, u.email ?? u.id);
    if (data.users.length < 200) break;
  }
  return map;
}

/** Fetch + aggregate per-advisor productivity for the stores/range (RLS-scoped). */
export async function getAdvisorProductivity(storeIds: string[], range: DateRange): Promise<AdvisorStat[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const startIso = `${range.from}T00:00:00Z`;
  const endIso = `${range.to}T23:59:59Z`;

  // 1) Advisor calls in range (vendedora not null = a human touch).
  const { data: callsRaw } = await sb
    .from("lead_calls")
    .select("vendedora, lead_id, kind, occurred_at")
    .in("store_id", storeIds)
    .not("vendedora", "is", null)
    .gte("occurred_at", startIso)
    .lte("occurred_at", endIso);
  const calls = (callsRaw as AdvisorCall[]) ?? [];
  if (!calls.length) return [];

  // 2) Outcome of the touched leads (won? + linked order).
  const leadIds = [...new Set(calls.map((c) => c.lead_id))];
  const { data: leadsRaw } = await sb
    .from("leads")
    .select("id, has_order, order_id")
    .in("id", leadIds);
  const leadsTouched = (leadsRaw as { id: string; has_order: boolean; order_id: string | null }[]) ?? [];

  // 3) Net revenue per linked order.
  const orderIds = leadsTouched.filter((l) => l.has_order && l.order_id).map((l) => l.order_id as string);
  const netByOrder = new Map<string, number>();
  if (orderIds.length) {
    const { data: ordersRaw } = await sb
      .from("orders")
      .select("id, total_amount, total_refunded")
      .in("id", orderIds);
    for (const o of (ordersRaw as { id: string; total_amount: number | null; total_refunded: number | null }[]) ?? []) {
      netByOrder.set(o.id, (o.total_amount ?? 0) - (o.total_refunded ?? 0));
    }
  }

  const leadOutcome = new Map<string, { won: boolean; net: number }>();
  for (const l of leadsTouched) {
    leadOutcome.set(l.id, { won: !!l.has_order, net: l.order_id ? (netByOrder.get(l.order_id) ?? 0) : 0 });
  }

  const emailById = await resolveEmails([...new Set(calls.map((c) => c.vendedora))]);
  return computeAdvisorStats({ calls, leadOutcome, emailById });
}
