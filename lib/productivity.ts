// Per-advisor (vendedora) productivity for a date range. Activity comes from
// `lead_calls`; a won lead is credited to the advisor who registered the LAST
// call on it within the period (last-touch attribution). Pure aggregation is
// split from the fetch so it can be unit-tested.

import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { tzParts } from "@/lib/metrics";
import { chunk, previousRange, type DateRange } from "@/lib/access";
import { onlineVendedoraIds } from "@/lib/presence";
import { leadSegment, type LeadSegment } from "@/lib/leads";

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

/** The acquisition-source buckets a won order can be attributed to. `meta_ad` =
 *  provable Click-to-WhatsApp ad click (has ad_id); `fb_web` = reached WhatsApp
 *  via a Facebook/IG web link (paid or organic, no ad_id). */
export type SourceBucket = "meta_ad" | "fb_web" | "cod_cart" | "abandoned_browse" | "organic";
export const SOURCE_BUCKETS: SourceBucket[] = ["meta_ad", "fb_web", "cod_cart", "abandoned_browse", "organic"];

/** One advisor×source cell: how many orders closed and their net revenue. */
export interface SourceCell {
  cerrados: number;
  ingresos: number;
}

/** A zeroed per-source breakdown (all four buckets present, so the matrix table
 *  can render every column without null checks). */
export function emptyPorFuente(): Record<SourceBucket, SourceCell> {
  return {
    meta_ad: { cerrados: 0, ingresos: 0 },
    fb_web: { cerrados: 0, ingresos: 0 },
    cod_cart: { cerrados: 0, ingresos: 0 },
    abandoned_browse: { cerrados: 0, ingresos: 0 },
    organic: { cerrados: 0, ingresos: 0 },
  };
}

export interface AdvisorStat {
  userId: string;
  email: string;
  llamadas: number; // calls of kind="call"
  leadsTrabajados: number; // distinct leads touched
  cerrados: number; // touched leads now won, attributed by last touch
  cerradosDetalle: WonOrderRef[]; // the orders behind `cerrados`, oldest first
  ingresos: number; // net revenue (total - refunded) of those orders
  porFuente: Record<SourceBucket, SourceCell>; // cerrados+ingresos split by acquisition source
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
function sourceKey(s: string | null | undefined): SourceBucket {
  return s === "meta_ad"
    ? "meta_ad"
    : s === "fb_web"
      ? "fb_web"
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

/** Advisor lead_calls in [startIso..endIso], PAGED past PostgREST's silent
 *  max-rows cap. A bare `.select()` tops out at ~1000 rows, so a busy store's
 *  30d window lost most of its calls — and the follow-up `.in("id", leadIds)`
 *  lookup then failed outright on the oversized URL, which is how the board
 *  once showed 830 llamadas · 0 cerrados · S/ 0. Stable (occurred_at, id)
 *  ordering keeps pages from overlapping or skipping. Best-effort: stops at
 *  the first page error, returning what it has. */
async function fetchAdvisorLeadCallsPaged(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  storeIds: string[],
  startIso: string,
  endIso: string,
  vendedoraId?: string,
): Promise<AdvisorCall[]> {
  const PAGE = 1000;
  const CAP = 40000; // safety bound: ~40 pages even on a runaway store
  const calls: AdvisorCall[] = [];
  for (let from = 0; from < CAP; from += PAGE) {
    const base = sb
      .from("lead_calls")
      .select("vendedora, lead_id, kind, occurred_at")
      .in("store_id", storeIds)
      .gte("occurred_at", startIso)
      .lte("occurred_at", endIso);
    const { data, error } = await (vendedoraId ? base.eq("vendedora", vendedoraId) : base.not("vendedora", "is", null))
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) break;
    const batch = (data as AdvisorCall[]) ?? [];
    calls.push(...batch);
    if (batch.length < PAGE) break;
  }
  return calls;
}

// ── Presets de rango en día LOCAL de la tienda ────────────────────────────────
// Un preset con fecha UTC se corre de día a las 19:00 de Lima (UTC−5): "Hoy"
// apuntaba al día local siguiente y el tablero salía vacío por la noche.

/** Single-day range `offset` days back, in the STORE's local calendar (0 = hoy). */
export function localDayPreset(offset: number, tz: string, nowIso = new Date().toISOString()): DateRange {
  const d = tzParts(new Date(Date.parse(nowIso) - offset * 86_400_000).toISOString(), tz).date;
  return { from: d, to: d };
}

/** Last `days` local days ending today (inclusive), in the store's tz. */
export function localPresetRange(days: number, tz: string, nowIso = new Date().toISOString()): DateRange {
  const nowMs = Date.parse(nowIso);
  return {
    from: tzParts(new Date(nowMs - (days - 1) * 86_400_000).toISOString(), tz).date,
    to: tzParts(new Date(nowMs).toISOString(), tz).date,
  };
}

// ── Actividad por hora (heatmap "¿está conectada trabajando?") ────────────────

export const HEAT_START = 8; // business shift, aligned with the leads burndown
export const HEAT_END = 20; // inclusive → 13 cells

export interface HourlyActivity {
  /** userId → 13 celdas (horas locales 08..20) con LEADS/ENVÍOS DISTINTOS gestionados. */
  byAgent: Record<string, number[]>;
  /** Máximo global (≥ 1) para que todas las filas compartan la escala de color. */
  max: number;
  /** "day" = distintos de un solo día; "avg" = promedio de distintos/día (multi-día). */
  mode: "day" | "avg";
}

/** Hourly DISTINCT leads (or shipments) each advisor worked, from any registered
 *  human event (calls, sales, WhatsApp messages, shipment gestiones). `ref` is
 *  the unit of gestión (lead_id / shipment_id): 3 messages to the same lead in
 *  one hour count as 1 — raw action counts reward busywork, distinct leads
 *  don't. Dedupe is per (hour, LOCAL DAY), so in avg mode the same lead worked
 *  at 10h on 7 different days contributes 1 per day (avg 1), not 1/7. Hours
 *  outside the 08–20 shift are DROPPED — folding them to the edges would
 *  fabricate fake 08h/20h peaks. Pure. */
export function computeHourlyActivity(opts: {
  events: { agent: string | null; occurred_at: string | null; ref: string }[];
  tz: string;
  rangeDays: number;
}): HourlyActivity {
  const cells = HEAT_END - HEAT_START + 1;
  const setsByAgent: Record<string, Set<string>[]> = {};
  for (const e of opts.events) {
    if (!e.agent || !e.occurred_at) continue;
    const p = tzParts(e.occurred_at, opts.tz);
    if (p.hour < HEAT_START || p.hour > HEAT_END) continue;
    const sets = (setsByAgent[e.agent] ??= Array.from({ length: cells }, () => new Set<string>()));
    sets[p.hour - HEAT_START]!.add(`${p.date}|${e.ref}`);
  }
  const mode: HourlyActivity["mode"] = opts.rangeDays > 1 ? "avg" : "day";
  const div = mode === "avg" ? Math.max(1, opts.rangeDays) : 1;
  const byAgent: Record<string, number[]> = {};
  let max = 1;
  for (const [agent, sets] of Object.entries(setsByAgent)) {
    const arr = sets.map((s) => (mode === "avg" ? Math.round((s.size / div) * 10) / 10 : s.size));
    byAgent[agent] = arr;
    for (const v of arr) if (v > max) max = v;
  }
  return { byAgent, max, mode };
}

// ── Tendencia diaria por asesora (sparkline de % cierre) ──────────────────────

export interface TrendCell {
  date: string; // YYYY-MM-DD local
  label: string; // "Lun"… / "Hoy"
  contactos: number; // kind="call" de la asesora ese día
  pedidos: number; // leads ganados acreditados a la asesora ese día
}

/** Daily contactos/pedidos series PER ADVISOR. Same attribution as
 *  computeAdvisorStats so the sparkline reconciles with "Cerrados": the win goes
 *  to the advisor of the lead's LAST touch (any kind), on that touch's local day;
 *  contactos count only the advisor's own kind="call". Pure. */
export function computeAdvisorConversionByDay(opts: {
  calls: AdvisorCall[];
  wonLeadIds: Set<string>;
  days: { date: string; label: string }[];
  tz: string;
}): Record<string, TrendCell[]> {
  const idx = new Map(opts.days.map((d, i) => [d.date, i]));
  const series: Record<string, TrendCell[]> = {};
  const rowOf = (agent: string) =>
    (series[agent] ??= opts.days.map((d) => ({ date: d.date, label: d.label, contactos: 0, pedidos: 0 })));
  const lastTouch = new Map<string, { vendedora: string; at: string }>();
  for (const c of opts.calls) {
    if (!c.vendedora || !c.occurred_at) continue;
    if (c.kind === "call") {
      const i = idx.get(tzParts(c.occurred_at, opts.tz).date);
      if (i != null) rowOf(c.vendedora)[i]!.contactos += 1;
    }
    const prev = lastTouch.get(c.lead_id);
    if (!prev || c.occurred_at > prev.at) lastTouch.set(c.lead_id, { vendedora: c.vendedora, at: c.occurred_at });
  }
  for (const [leadId, t] of lastTouch) {
    if (!opts.wonLeadIds.has(leadId)) continue;
    const i = idx.get(tzParts(t.at, opts.tz).date);
    if (i != null) rowOf(t.vendedora)[i]!.pedidos += 1;
  }
  return series;
}

export interface ProductivityInput {
  calls: AdvisorCall[];
  /** Outcome of every touched lead: won? + net order revenue + acquisition
   *  source bucket (+ the linked order's code/date, when known, for detail). */
  leadOutcome: Map<
    string,
    { won: boolean; net: number; source?: SourceBucket; orderName?: string | null; orderAt?: string | null }
  >;
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

  type WonAgg = { cerrados: number; ingresos: number; detalle: WonOrderRef[]; porFuente: Record<SourceBucket, SourceCell> };
  const won = new Map<string, WonAgg>();
  for (const [leadId, lc] of lastCaller) {
    const o = leadOutcome.get(leadId);
    if (!o?.won) continue;
    const w = won.get(lc.vendedora) ?? { cerrados: 0, ingresos: 0, detalle: [], porFuente: emptyPorFuente() };
    w.cerrados += 1;
    w.ingresos += o.net;
    const bucket = o.source ?? "organic";
    w.porFuente[bucket].cerrados += 1;
    w.porFuente[bucket].ingresos += o.net;
    w.detalle.push({ name: o.orderName ?? null, at: o.orderAt ?? null });
    won.set(lc.vendedora, w);
  }

  const rows: AdvisorStat[] = [];
  for (const [userId, a] of agg) {
    const w = won.get(userId) ?? { cerrados: 0, ingresos: 0, detalle: [], porFuente: emptyPorFuente() };
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
      porFuente: w.porFuente,
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

/** From the range's advisor calls, resolve the touched leads' outcome (won? +
 *  linked order + source) and apply the optional source lens. Shared by
 *  getAdvisorProductivity and getProductivityBoard so the board reuses the same
 *  (already paged) calls for metrics AND heatmap without a second fetch. */
async function buildAdvisorInputs(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  calls: AdvisorCall[],
  source: SourceBucket | null,
): Promise<{ scopedCalls: AdvisorCall[]; leadOutcome: ProductivityInput["leadOutcome"] }> {
  // Outcome of the touched leads, in chunks of 300 — hundreds of ids in one
  // `.in()` overflow the GET URL. `source` is selected with a fallback so a
  // pending 0008 migration can't break the page; it degrades ONCE and stays
  // degraded for the remaining chunks.
  const leadIds = [...new Set(calls.map((c) => c.lead_id))];
  type TouchedLead = {
    id: string;
    category: string | null;
    has_order: boolean;
    order_id: string | null;
    source?: string | null;
  };
  let leadsTouched: TouchedLead[] = [];
  let sourceMissing = false;
  for (const part of chunk(leadIds, 300)) {
    if (!sourceMissing) {
      const withSource = await sb.from("leads").select("id, category, has_order, order_id, source").in("id", part);
      if (!withSource.error) {
        leadsTouched.push(...((withSource.data as unknown as TouchedLead[]) ?? []));
        continue;
      }
      sourceMissing = true; // source column not present yet (migration 0008 pending) — degrade.
    }
    const base = await sb.from("leads").select("id, category, has_order, order_id").in("id", part);
    leadsTouched.push(...((base.data as unknown as TouchedLead[]) ?? []));
  }

  // Optional source lens: keep only calls/leads of the chosen acquisition source.
  let scopedCalls = calls;
  if (source) {
    const allowed = new Set(leadsTouched.filter((l) => sourceKey(l.source) === source).map((l) => l.id));
    scopedCalls = calls.filter((c) => allowed.has(c.lead_id));
    leadsTouched = leadsTouched.filter((l) => allowed.has(l.id));
  }

  // Net revenue + code/date per linked order (code/date feed cerradosDetalle).
  // Chunked like the leads lookup.
  const orderIds = leadsTouched.filter((l) => l.has_order && l.order_id).map((l) => l.order_id as string);
  type OrderInfo = { net: number; name: string | null; created_at: string | null };
  const infoByOrder = new Map<string, OrderInfo>();
  for (const part of chunk(orderIds, 300)) {
    const { data: ordersRaw } = await sb
      .from("orders")
      .select("id, name, created_at, total_amount, total_refunded")
      .in("id", part);
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
      source: sourceKey(l.source),
      orderName: info?.name ?? null,
      orderAt: info?.created_at ?? null,
    });
  }
  return { scopedCalls, leadOutcome };
}

/** Fetch + aggregate per-advisor productivity for the stores/range (RLS-scoped).
 *  `source` optionally restricts to one acquisition source (campaña vs orgánico). */
export async function getAdvisorProductivity(
  storeIds: string[],
  range: DateRange,
  source: SourceBucket | null = null,
  tz = "America/Lima",
): Promise<AdvisorStat[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const { startIso, endIso } = localRangeBoundsIso(range.from, range.to, tz);

  // 1) Advisor calls in range (vendedora not null = a human touch), paged past
  //    PostgREST's max-rows cap.
  const calls = await fetchAdvisorLeadCallsPaged(sb, storeIds, startIso, endIso);
  if (!calls.length) return [];

  // 2+3) Touched-lead outcomes + linked orders + source lens (shared helper).
  const { scopedCalls, leadOutcome } = await buildAdvisorInputs(sb, calls, source);
  if (!scopedCalls.length) return [];

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
  source: SourceBucket | null = null,
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

// ───────────────────────── Tablero de una pantalla ────────────────────────────

const WEEKDAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

export interface AdvisorBoardRow extends AdvisorStatWithDelta {
  heat: number[]; // 13 celdas, horas locales 08..20 (actividad, SIN lente de fuente)
  trend: TrendCell[]; // 7 días terminando en range.to (CON lente de fuente)
  online: boolean; // presencia al momento del render
}

export interface ProductivityBoardData {
  rows: AdvisorBoardRow[];
  prevTotals: ProductivityTotals;
  prevRange: DateRange;
  hasPrev: boolean;
  heatMax: number; // máximo global de la escala del heatmap
  heatMode: "day" | "avg";
  /** En línea AHORA pero sin actividad registrada en el rango — la señal clave
   *  para asesoras remotas ("conectada pero no está registrando nada"). */
  onlineIdle: { userId: string; email: string }[];
}

/** Paged shipment_calls events (agent + occurred_at + shipment ref) for the
 *  heatmap — Envíos gestiones are real work too; each distinct shipment counts
 *  as one gestión. Resilient: an unapplied 0023 migration (or any page error)
 *  just contributes no events. */
async function fetchShipmentEventsPaged(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  storeIds: string[],
  startIso: string,
  endIso: string,
): Promise<{ agent: string | null; occurred_at: string | null; ref: string }[]> {
  const PAGE = 1000;
  const CAP = 20000;
  const out: { agent: string | null; occurred_at: string | null; ref: string }[] = [];
  for (let from = 0; from < CAP; from += PAGE) {
    const { data, error } = await sb
      .from("shipment_calls")
      .select("shipment_id, agent, occurred_at")
      .in("store_id", storeIds)
      .not("agent", "is", null)
      .neq("kind", "system")
      .gte("occurred_at", startIso)
      .lte("occurred_at", endIso)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) break;
    const batch = (data as { shipment_id: string; agent: string | null; occurred_at: string | null }[]) ?? [];
    // Prefijo "s:" para que un shipment_id jamás colisione con un lead_id.
    out.push(...batch.map((r) => ({ agent: r.agent, occurred_at: r.occurred_at, ref: `s:${r.shipment_id}` })));
    if (batch.length < PAGE) break;
  }
  return out;
}

/**
 * Everything the one-screen productivity board needs, in one call:
 * per-advisor stats + deltas (like getAdvisorProductivityCompare), PLUS the
 * hourly activity heatmap (all human events, source lens NOT applied — it
 * measures "is she connected working", not efficiency), the 7-day trend series
 * per advisor (source lens applied, consistent with % cierre), and the live
 * presence snapshot. The range's lead_calls are fetched ONCE and feed both
 * metrics and heatmap. All returned structures are JSON-serializable.
 */
export async function getProductivityBoard(
  storeIds: string[],
  range: DateRange,
  source: SourceBucket | null = null,
  tz = "America/Lima",
): Promise<ProductivityBoardData> {
  const prevRange = previousRange(range);
  const empty: ProductivityBoardData = {
    rows: [],
    prevTotals: { llamadas: 0, leadsTrabajados: 0, cerrados: 0, ingresos: 0 },
    prevRange,
    hasPrev: false,
    heatMax: 1,
    heatMode: "day",
    onlineIdle: [],
  };
  if (!storeIds.length) return empty;
  const sb = await createServerSupabase();
  const { startIso, endIso } = localRangeBoundsIso(range.from, range.to, tz);
  const rangeDays = Math.max(1, Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1);
  const nowMs = Date.now();

  // Trend window: the 7 calendar days ending at range.to (labels "Lun"…/"Hoy").
  const todayLocal = tzParts(new Date(nowMs).toISOString(), tz).date;
  const toMs = Date.parse(`${range.to}T12:00:00Z`); // noon anchor → date math is DST-proof
  const trendDays: { date: string; label: string }[] = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(toMs - i * 86_400_000).toISOString().slice(0, 10);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    trendDays.push({ date, label: date === todayLocal ? "Hoy" : (WEEKDAYS[weekday] ?? date.slice(5)) });
  }
  const { startIso: trendStartIso } = localRangeBoundsIso(trendDays[0]!.date, range.to, tz);
  const needPrefix = trendStartIso < startIso; // rango corto (Hoy/Ayer) → faltan días previos
  const prefixEndIso = new Date(Date.parse(startIso) - 1).toISOString();

  const [calls, prevRows, shipEvents, onlineIds, prefixCalls] = await Promise.all([
    fetchAdvisorLeadCallsPaged(sb, storeIds, startIso, endIso),
    getAdvisorProductivity(storeIds, prevRange, source, tz),
    fetchShipmentEventsPaged(sb, storeIds, startIso, endIso),
    (async () => {
      try {
        return await onlineVendedoraIds(createAdminSupabase(), storeIds, nowMs);
      } catch {
        return new Set<string>(); // best-effort: sin presencia el tablero igual carga
      }
    })(),
    needPrefix
      ? fetchAdvisorLeadCallsPaged(sb, storeIds, trendStartIso, prefixEndIso)
      : Promise.resolve([] as AdvisorCall[]),
  ]);

  // Metrics from the SAME calls (source lens inside), same as getAdvisorProductivity.
  const { scopedCalls, leadOutcome } = await buildAdvisorInputs(sb, calls, source);
  const emailById = await resolveEmails([...new Set(scopedCalls.map((c) => c.vendedora))]);
  const cur = scopedCalls.length ? computeAdvisorStats({ calls: scopedCalls, leadOutcome, emailById }, tz) : [];
  const { rows: withDeltas, prevTotals } = attachDeltas(cur, prevRows);

  // Trend series: window calls (range slice + prefix) with the SAME source lens.
  let trendCalls = scopedCalls.filter((c) => c.occurred_at >= trendStartIso);
  const trendWon = new Set<string>();
  for (const [id, o] of leadOutcome) if (o.won) trendWon.add(id);
  if (prefixCalls.length) {
    const prefix = await buildAdvisorInputs(sb, prefixCalls, source);
    trendCalls = trendCalls.concat(prefix.scopedCalls);
    for (const [id, o] of prefix.leadOutcome) if (o.won) trendWon.add(id);
  }
  const trendSeries = computeAdvisorConversionByDay({ calls: trendCalls, wonLeadIds: trendWon, days: trendDays, tz });

  // Heatmap: ALL human events in range (no source lens) + Envíos gestiones,
  // counted as DISTINCT leads/shipments per hour.
  const heat = computeHourlyActivity({
    events: [
      ...calls.map((c) => ({ agent: c.vendedora, occurred_at: c.occurred_at, ref: c.lead_id })),
      ...shipEvents,
    ],
    tz,
    rangeDays,
  });

  const zeroHeat = () => new Array<number>(HEAT_END - HEAT_START + 1).fill(0);
  const emptyTrend = () => trendDays.map((d) => ({ date: d.date, label: d.label, contactos: 0, pedidos: 0 }));
  const rows: AdvisorBoardRow[] = withDeltas.map((r) => ({
    ...r,
    heat: heat.byAgent[r.userId] ?? zeroHeat(),
    trend: trendSeries[r.userId] ?? emptyTrend(),
    online: onlineIds.has(r.userId),
  }));

  // Online RIGHT NOW but absent from the board (no registered activity in range).
  const activeIds = new Set(rows.map((r) => r.userId));
  const idleIds = [...onlineIds].filter((id) => !activeIds.has(id));
  const idleEmails = idleIds.length ? await resolveEmails(idleIds) : new Map<string, string>();
  const onlineIdle = idleIds.map((id) => ({ userId: id, email: idleEmails.get(id) ?? id }));

  return {
    rows,
    prevTotals,
    prevRange,
    hasPrev: prevRows.length > 0,
    heatMax: heat.max,
    heatMode: heat.mode,
    onlineIdle,
  };
}

// ───────────────────────── Drill-down: leads an advisor worked ─────────────────

export interface AgentLeadRow {
  id: string;
  name: string | null;
  phone: string | null;
  status: string;
  category: string | null;
  source: SourceBucket;
  segment: LeadSegment; // calidad del lead (carrito/distrito/conversó/frío)
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
  source: SourceBucket | null = null,
  tz = "America/Lima",
): Promise<AgentLeadRow[]> {
  if (!storeIds.length || !vendedoraId) return [];
  const sb = await createServerSupabase();
  const { startIso, endIso } = localRangeBoundsIso(range.from, range.to, tz);

  // 1) This advisor's calls in range, paged past PostgREST's max-rows cap.
  const calls = await fetchAdvisorLeadCallsPaged(sb, storeIds, startIso, endIso, vendedoraId);
  if (!calls.length) return [];

  const llamadasByLead = new Map<string, number>();
  const lastTouchByLead = new Map<string, string>();
  for (const c of calls) {
    if (c.kind === "call") llamadasByLead.set(c.lead_id, (llamadasByLead.get(c.lead_id) ?? 0) + 1);
    const prev = lastTouchByLead.get(c.lead_id);
    if (!prev || c.occurred_at > prev) lastTouchByLead.set(c.lead_id, c.occurred_at);
  }

  // 2) The touched leads (source + segment signals selected with a degrade
  //    fallback, as elsewhere).
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
    cart_item_count?: number | null;
    district?: string | null;
    inbound_count?: number | null;
    draft_order_gid?: string | null;
  };
  let leads: TouchedLead[] = [];
  {
    const cols =
      "id, name, phone, status, category, has_order, order_id, source, cart_item_count, district, inbound_count, draft_order_gid";
    // Chunked .in() + one-time degrade (missing 0007/0008 columns), same as
    // getAdvisorProductivity.
    let colsMissing = false;
    for (const part of chunk(leadIds, 300)) {
      if (!colsMissing) {
        const withCols = await sb.from("leads").select(cols).in("id", part);
        if (!withCols.error) {
          leads.push(...((withCols.data as unknown as TouchedLead[]) ?? []));
          continue;
        }
        colsMissing = true;
      }
      const base = await sb.from("leads").select("id, name, phone, status, category, has_order, order_id").in("id", part);
      leads.push(...((base.data as unknown as TouchedLead[]) ?? []));
    }
  }
  if (source) leads = leads.filter((l) => sourceKey(l.source) === source);
  if (!leads.length) return [];

  // 3) Net revenue per linked order (chunked).
  const orderIds = leads.filter((l) => l.has_order && l.order_id).map((l) => l.order_id as string);
  const netByOrder = new Map<string, number>();
  for (const part of chunk(orderIds, 300)) {
    const { data: ordersRaw } = await sb
      .from("orders")
      .select("id, total_amount, total_refunded")
      .in("id", part);
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
    segment: leadSegment(l),
    won: isWonLead(l.category),
    net: l.order_id ? (netByOrder.get(l.order_id) ?? 0) : 0,
    llamadas: llamadasByLead.get(l.id) ?? 0,
    lastTouch: lastTouchByLead.get(l.id) ?? startIso,
  }));
  rows.sort((a, b) => (a.lastTouch < b.lastTouch ? 1 : a.lastTouch > b.lastTouch ? -1 : 0));
  return rows;
}
