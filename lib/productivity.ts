// Per-advisor (vendedora) productivity for a date range. Activity comes from
// `lead_calls`; a won lead is credited to the advisor who registered the LAST
// call on it within the period (last-touch attribution). Pure aggregation is
// split from the fetch so it can be unit-tested.

import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { tzParts } from "@/lib/metrics";
import { previousRange, type DateRange } from "@/lib/access";

/** Minutes to ADD to UTC to reach local time in `tz` at `date` (Lima → −300). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) m[p.type] = p.value;
  const asUtc = Date.UTC(+m.year!, +m.month! - 1, +m.day!, +(m.hour === "24" ? "0" : m.hour!), +m.minute!, +m.second!);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** UTC ISO bounds of the local-day range [from..to] (YYYY-MM-DD) in `tz`. "Today"
 *  must mean the STORE's local day, not a UTC day — otherwise the prior evening's
 *  activity (e.g. Lima 19:00–23:59 = UTC 00:00–04:59) leaks into it. */
export function localRangeBoundsIso(from: string, to: string, tz: string): { startIso: string; endIso: string } {
  const offFrom = tzOffsetMinutes(new Date(`${from}T12:00:00Z`), tz);
  const offTo = tzOffsetMinutes(new Date(`${to}T12:00:00Z`), tz);
  const startMs = new Date(`${from}T00:00:00Z`).getTime() - offFrom * 60_000;
  const endMs = new Date(`${to}T00:00:00Z`).getTime() - offTo * 60_000 + 86_400_000 - 1;
  return { startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() };
}

/** One attributed win, for drill-down UIs (tooltip "qué pedidos generó"). */
export interface WonOrderRef {
  name: string | null; // order code, e.g. "#AUR1091" (null = order not ingested/linked yet)
  at: string | null; // order created_at ISO
}

export interface AdvisorStat {
  userId: string;
  email: string;
  llamadas: number; // calls of kind="call"
  leadsTrabajados: number; // distinct leads touched
  cerrados: number; // touched leads now won, attributed by last touch
  cerradosDetalle: WonOrderRef[]; // the orders behind `cerrados`, oldest first
  ingresos: number; // net revenue (total - refunded) of those orders
  conversion: number; // cerrados / leadsTrabajados, 0..1
  horas: number; // active hours inferred from action timestamps (idle-gap-split)
  dias: number; // distinct days with logged activity
}

/** A touched lead counts as a close only if its OWN disposition is `won` —
 *  `has_order` alone is not enough: it can be `true` from an unrelated order
 *  linked by phone (e.g. a past purchase) while the advisor dispositioned THIS
 *  lead as lost ("ya compró en otro lado"). Crediting on `has_order` would count
 *  a lost call as a sale. */
export function isWonLead(category: string | null | undefined): boolean {
  return category === "won";
}

/** Canonical acquisition-source bucket for a lead's `source`. */
function sourceKey(s: string | null | undefined): "meta_ad" | "cod_cart" | "abandoned_browse" | "organic" {
  return s === "meta_ad"
    ? "meta_ad"
    : s === "cod_cart"
      ? "cod_cart"
      : s === "abandoned_browse"
        ? "abandoned_browse"
        : "organic";
}

export interface AdvisorCall {
  vendedora: string;
  lead_id: string;
  kind: string;
  occurred_at: string;
}

export interface ProductivityInput {
  calls: AdvisorCall[];
  /** Outcome of every touched lead: won? + net order revenue (+ the linked
   *  order's code/date, when known, for the per-advisor detail). */
  leadOutcome: Map<string, { won: boolean; net: number; orderName?: string | null; orderAt?: string | null }>;
  emailById: Map<string, string>;
}

const ACTIVE_GAP_MS = 45 * 60 * 1000; // a gap >45 min splits work blocks (lunch/break)

/** Active hours from sorted action timestamps (ms), summing blocks split on idle
 *  gaps. A lone action contributes ~0 (can't infer a span from one point). */
function activeHoursFromTimes(sorted: number[]): number {
  if (sorted.length < 2) return 0;
  let total = 0;
  let blockStart = sorted[0]!;
  let prev = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i]!;
    if (t - prev > ACTIVE_GAP_MS) {
      total += prev - blockStart;
      blockStart = t;
    }
    prev = t;
  }
  total += prev - blockStart;
  return total / 3_600_000;
}

/** Aggregate advisor activity + last-touch-attributed wins + inferred active
 *  hours (from the spread of their action timestamps, by local day). Pure. */
export function computeAdvisorStats(
  { calls, leadOutcome, emailById }: ProductivityInput,
  tz = "America/Lima",
): AdvisorStat[] {
  const agg = new Map<string, { llamadas: number; leads: Set<string> }>();
  const lastCaller = new Map<string, { vendedora: string; at: string }>();
  const timesByAgentDay = new Map<string, number[]>(); // `${agent}|${localDate}` → ms[]

  for (const c of calls) {
    if (!c.vendedora) continue;
    const a = agg.get(c.vendedora) ?? { llamadas: 0, leads: new Set<string>() };
    if (c.kind === "call") a.llamadas += 1;
    a.leads.add(c.lead_id);
    agg.set(c.vendedora, a);

    const prev = lastCaller.get(c.lead_id);
    if (!prev || c.occurred_at > prev.at) lastCaller.set(c.lead_id, { vendedora: c.vendedora, at: c.occurred_at });

    const ms = new Date(c.occurred_at).getTime();
    if (Number.isFinite(ms)) {
      const k = `${c.vendedora}|${tzParts(c.occurred_at, tz).date}`;
      const arr = timesByAgentDay.get(k) ?? [];
      arr.push(ms);
      timesByAgentDay.set(k, arr);
    }
  }

  const hoursByAgent = new Map<string, { horas: number; dias: Set<string> }>();
  for (const [k, times] of timesByAgentDay) {
    const sep = k.indexOf("|");
    const agent = k.slice(0, sep);
    const day = k.slice(sep + 1);
    times.sort((x, y) => x - y);
    const e = hoursByAgent.get(agent) ?? { horas: 0, dias: new Set<string>() };
    e.horas += activeHoursFromTimes(times);
    e.dias.add(day);
    hoursByAgent.set(agent, e);
  }

  const won = new Map<string, { cerrados: number; ingresos: number; detalle: WonOrderRef[] }>();
  for (const [leadId, lc] of lastCaller) {
    const o = leadOutcome.get(leadId);
    if (!o?.won) continue;
    const w = won.get(lc.vendedora) ?? { cerrados: 0, ingresos: 0, detalle: [] };
    w.cerrados += 1;
    w.ingresos += o.net;
    w.detalle.push({ name: o.orderName ?? null, at: o.orderAt ?? null });
    won.set(lc.vendedora, w);
  }

  const rows: AdvisorStat[] = [];
  for (const [userId, a] of agg) {
    const w = won.get(userId) ?? { cerrados: 0, ingresos: 0, detalle: [] };
    const h = hoursByAgent.get(userId);
    const leadsTrabajados = a.leads.size;
    // Oldest first; wins without an ingested order (no date yet) go last.
    w.detalle.sort((x, y) => ((x.at ?? "9999") < (y.at ?? "9999") ? -1 : 1));
    rows.push({
      userId,
      email: emailById.get(userId) ?? userId,
      llamadas: a.llamadas,
      leadsTrabajados,
      cerrados: w.cerrados,
      cerradosDetalle: w.detalle,
      ingresos: w.ingresos,
      conversion: leadsTrabajados ? w.cerrados / leadsTrabajados : 0,
      horas: Math.round((h?.horas ?? 0) * 10) / 10,
      dias: h?.dias.size ?? 0,
    });
  }
  rows.sort((x, y) => y.ingresos - x.ingresos || y.cerrados - x.cerrados || y.llamadas - x.llamadas);
  return rows;
}

// Process-level cache of user_id → email. Emails essentially never change, so a
// warm instance reuses it across requests (cold start just repopulates).
const emailCache = new Map<string, string>();

/** Resolve advisor user_ids → emails. One getUserById per *uncached* id, in
 *  parallel — far cheaper than paging the whole user list on every load. */
export async function resolveEmails(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!userIds.length) return map;
  const missing = userIds.filter((id) => !emailCache.has(id));
  if (missing.length) {
    const admin = createAdminSupabase();
    await Promise.all(
      missing.map(async (id) => {
        try {
          const { data } = await admin.auth.admin.getUserById(id);
          emailCache.set(id, data?.user?.email ?? id);
        } catch {
          emailCache.set(id, id);
        }
      }),
    );
  }
  for (const id of userIds) map.set(id, emailCache.get(id) ?? id);
  return map;
}

/** Fetch + aggregate per-advisor productivity for the stores/range (RLS-scoped).
 *  `source` optionally restricts to one acquisition source (campaña vs orgánico). */
export async function getAdvisorProductivity(
  storeIds: string[],
  range: DateRange,
  source: "meta_ad" | "cod_cart" | "abandoned_browse" | "organic" | null = null,
  tz = "America/Lima",
): Promise<AdvisorStat[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const { startIso, endIso } = localRangeBoundsIso(range.from, range.to, tz);

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

  // 2) Outcome of the touched leads (won? + linked order + source). `source` is
  //    selected with a fallback so a pending 0008 migration can't break the page.
  const leadIds = [...new Set(calls.map((c) => c.lead_id))];
  type TouchedLead = {
    id: string;
    category: string | null;
    has_order: boolean;
    order_id: string | null;
    source?: string | null;
  };
  let leadsTouched: TouchedLead[];
  {
    const withSource = await sb.from("leads").select("id, category, has_order, order_id, source").in("id", leadIds);
    if (withSource.error) {
      // source column not present yet (migration 0008 pending) — degrade.
      const base = await sb.from("leads").select("id, category, has_order, order_id").in("id", leadIds);
      leadsTouched = (base.data as unknown as TouchedLead[]) ?? [];
    } else {
      leadsTouched = (withSource.data as unknown as TouchedLead[]) ?? [];
    }
  }

  // Optional source lens: keep only calls/leads of the chosen acquisition source.
  let scopedCalls = calls;
  if (source) {
    const allowed = new Set(leadsTouched.filter((l) => sourceKey(l.source) === source).map((l) => l.id));
    scopedCalls = calls.filter((c) => allowed.has(c.lead_id));
    leadsTouched = leadsTouched.filter((l) => allowed.has(l.id));
    if (!scopedCalls.length) return [];
  }

  // 3) Net revenue + code/date per linked order (code/date feed cerradosDetalle).
  const orderIds = leadsTouched.filter((l) => l.has_order && l.order_id).map((l) => l.order_id as string);
  type OrderInfo = { net: number; name: string | null; created_at: string | null };
  const infoByOrder = new Map<string, OrderInfo>();
  if (orderIds.length) {
    const { data: ordersRaw } = await sb
      .from("orders")
      .select("id, name, created_at, total_amount, total_refunded")
      .in("id", orderIds);
    type OrderRaw = {
      id: string;
      name: string | null;
      created_at: string | null;
      total_amount: number | null;
      total_refunded: number | null;
    };
    for (const o of (ordersRaw as OrderRaw[]) ?? []) {
      infoByOrder.set(o.id, {
        net: (o.total_amount ?? 0) - (o.total_refunded ?? 0),
        name: o.name,
        created_at: o.created_at,
      });
    }
  }

  const leadOutcome: ProductivityInput["leadOutcome"] = new Map();
  for (const l of leadsTouched) {
    const info = l.order_id ? infoByOrder.get(l.order_id) : undefined;
    leadOutcome.set(l.id, {
      won: isWonLead(l.category),
      net: info?.net ?? 0,
      orderName: info?.name ?? null,
      orderAt: info?.created_at ?? null,
    });
  }

  const emailById = await resolveEmails([...new Set(scopedCalls.map((c) => c.vendedora))]);
  return computeAdvisorStats({ calls: scopedCalls, leadOutcome, emailById }, tz);
}

// ───────────────────────── Comparativo vs período anterior ─────────────────────

export interface ProductivityTotals {
  llamadas: number;
  leadsTrabajados: number;
  cerrados: number;
  ingresos: number;
}

export interface AdvisorDelta {
  llamadas: number; // current − previous (absolute)
  cerrados: number;
  ingresos: number;
  conversionPP: number; // change in % cierre, in percentage POINTS
  isNew: boolean; // no activity in the previous period (no baseline)
}

export interface AdvisorStatWithDelta extends AdvisorStat {
  delta: AdvisorDelta;
}

export interface ProductivityComparison {
  rows: AdvisorStatWithDelta[];
  prevTotals: ProductivityTotals; // team totals of the previous period (for arrows)
  prevRange: DateRange;
  hasPrev: boolean; // the previous period had any advisor activity (a baseline exists)
}

function sumTotals(rows: AdvisorStat[]): ProductivityTotals {
  return rows.reduce(
    (a, r) => ({
      llamadas: a.llamadas + r.llamadas,
      leadsTrabajados: a.leadsTrabajados + r.leadsTrabajados,
      cerrados: a.cerrados + r.cerrados,
      ingresos: Math.round((a.ingresos + r.ingresos) * 100) / 100,
    }),
    { llamadas: 0, leadsTrabajados: 0, cerrados: 0, ingresos: 0 },
  );
}

/** Per-advisor productivity for `range` plus deltas vs the equally-sized period
 *  immediately before it. Only current-active advisors are listed (the board
 *  shows who's working now); `prevTotals` captures team-level movement including
 *  advisors who dropped to zero. */
export async function getAdvisorProductivityCompare(
  storeIds: string[],
  range: DateRange,
  source: "meta_ad" | "cod_cart" | "abandoned_browse" | "organic" | null = null,
  tz = "America/Lima",
): Promise<ProductivityComparison> {
  const prevRange = previousRange(range);
  const [cur, prev] = await Promise.all([
    getAdvisorProductivity(storeIds, range, source, tz),
    getAdvisorProductivity(storeIds, prevRange, source, tz),
  ]);
  const { rows, prevTotals } = attachDeltas(cur, prev);
  return { rows, prevTotals, prevRange, hasPrev: prev.length > 0 };
}

/** Pure: attach per-advisor deltas (current − previous) and roll up the previous
 *  team totals. Advisors absent from `prev` are flagged `isNew` (no baseline). */
export function attachDeltas(
  cur: AdvisorStat[],
  prev: AdvisorStat[],
): { rows: AdvisorStatWithDelta[]; prevTotals: ProductivityTotals } {
  const prevById = new Map(prev.map((r) => [r.userId, r]));
  const rows: AdvisorStatWithDelta[] = cur.map((r) => {
    const p = prevById.get(r.userId);
    return {
      ...r,
      delta: {
        llamadas: r.llamadas - (p?.llamadas ?? 0),
        cerrados: r.cerrados - (p?.cerrados ?? 0),
        ingresos: Math.round((r.ingresos - (p?.ingresos ?? 0)) * 100) / 100,
        conversionPP: Math.round((r.conversion - (p?.conversion ?? 0)) * 1000) / 10,
        isNew: !p,
      },
    };
  });
  return { rows, prevTotals: sumTotals(prev) };
}

// ───────────────────────── Drill-down: leads an advisor worked ─────────────────

export interface AgentLeadRow {
  id: string;
  name: string | null;
  phone: string | null;
  status: string;
  category: string | null;
  source: "meta_ad" | "cod_cart" | "abandoned_browse" | "organic";
  won: boolean;
  net: number; // net revenue if won, else 0
  llamadas: number; // calls this advisor logged on the lead
  lastTouch: string; // ISO of this advisor's last action on the lead
}

/** Leads a single advisor (vendedora) worked in the range, for the drill-down.
 *  Mirrors `getAdvisorProductivity`'s fetch/scoping but keyed to one vendedora,
 *  returning one row per touched lead (newest activity first). RLS-scoped. */
export async function getAgentLeadsWorked(
  storeIds: string[],
  range: DateRange,
  vendedoraId: string,
  source: "meta_ad" | "cod_cart" | "abandoned_browse" | "organic" | null = null,
  tz = "America/Lima",
): Promise<AgentLeadRow[]> {
  if (!storeIds.length || !vendedoraId) return [];
  const sb = await createServerSupabase();
  const { startIso, endIso } = localRangeBoundsIso(range.from, range.to, tz);

  // 1) This advisor's calls in range.
  const { data: callsRaw } = await sb
    .from("lead_calls")
    .select("vendedora, lead_id, kind, occurred_at")
    .in("store_id", storeIds)
    .eq("vendedora", vendedoraId)
    .gte("occurred_at", startIso)
    .lte("occurred_at", endIso);
  const calls = (callsRaw as AdvisorCall[]) ?? [];
  if (!calls.length) return [];

  const llamadasByLead = new Map<string, number>();
  const lastTouchByLead = new Map<string, string>();
  for (const c of calls) {
    if (c.kind === "call") llamadasByLead.set(c.lead_id, (llamadasByLead.get(c.lead_id) ?? 0) + 1);
    const prev = lastTouchByLead.get(c.lead_id);
    if (!prev || c.occurred_at > prev) lastTouchByLead.set(c.lead_id, c.occurred_at);
  }

  // 2) The touched leads (source selected with a degrade fallback, as elsewhere).
  const leadIds = [...lastTouchByLead.keys()];
  type TouchedLead = {
    id: string;
    name: string | null;
    phone: string | null;
    status: string;
    category: string | null;
    has_order: boolean;
    order_id: string | null;
    source?: string | null;
  };
  let leads: TouchedLead[];
  {
    const cols = "id, name, phone, status, category, has_order, order_id, source";
    const withSource = await sb.from("leads").select(cols).in("id", leadIds);
    if (withSource.error) {
      const base = await sb.from("leads").select("id, name, phone, status, category, has_order, order_id").in("id", leadIds);
      leads = (base.data as unknown as TouchedLead[]) ?? [];
    } else {
      leads = (withSource.data as unknown as TouchedLead[]) ?? [];
    }
  }
  if (source) leads = leads.filter((l) => sourceKey(l.source) === source);
  if (!leads.length) return [];

  // 3) Net revenue per linked order.
  const orderIds = leads.filter((l) => l.has_order && l.order_id).map((l) => l.order_id as string);
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

  const rows: AgentLeadRow[] = leads.map((l) => ({
    id: l.id,
    name: l.name,
    phone: l.phone,
    status: l.status,
    category: l.category,
    source: sourceKey(l.source),
    won: isWonLead(l.category),
    net: l.order_id ? (netByOrder.get(l.order_id) ?? 0) : 0,
    llamadas: llamadasByLead.get(l.id) ?? 0,
    lastTouch: lastTouchByLead.get(l.id) ?? startIso,
  }));
  rows.sort((a, b) => (a.lastTouch < b.lastTouch ? 1 : a.lastTouch > b.lastTouch ? -1 : 0));
  return rows;
}
