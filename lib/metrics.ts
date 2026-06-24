// The 4 families of metrics. Pure functions over already-fetched rows so they
// are trivially unit-testable and reusable from server components, the cron
// rollup path and the seed script.
//
//   1. Ventas        — orders, revenue, AOV, daily series, by store, deltas
//   2. Embudo        — conversations → orders conversion + fine link
//   3. Negocio       — promo %, stock-por-validar, COD vs agencia, top products,
//                      date/hour pattern
//   4. Operativo     — Kapso health / api_logs errors+latency / 24h activity

import type {
  ConversationRow,
  DailyRollupRow,
  LeadRow,
  OrderRow,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Timezone-aware bucketing
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Date (YYYY-MM-DD), hour (0-23) and weekday (0=Sun) of an instant in a tz. */
export function tzParts(
  iso: string,
  timeZone: string,
): { date: string; hour: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = dtf.formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = parseInt(get("hour"), 10);
  if (!Number.isFinite(hour) || hour === 24) hour = 0;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour,
    weekday: Math.max(0, WEEKDAYS.indexOf(get("weekday"))),
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function pctDelta(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null; // null = "new / n/a"
  return round2(((current - previous) / previous) * 100);
}

/** Orders excluding cancelled ones — the basis for sales + breakdown metrics. */
export function activeOrders(orders: OrderRow[]): OrderRow[] {
  return orders.filter((o) => !o.cancelled_at);
}

/** Net value of an order: gross total minus refunds. */
function netAmount(o: OrderRow): number {
  return (o.total_amount ?? 0) - (o.total_refunded ?? 0);
}

// ===========================================================================
// Family 1 — Ventas
// ===========================================================================

export interface SalesSummary {
  ordersCount: number;
  revenue: number;
  aov: number;
}

export function salesSummary(orders: OrderRow[]): SalesSummary {
  const active = activeOrders(orders);
  const ordersCount = active.length;
  const revenue = round2(active.reduce((s, o) => s + netAmount(o), 0));
  return { ordersCount, revenue, aov: ordersCount ? round2(revenue / ordersCount) : 0 };
}

export interface DaySalesPoint {
  date: string;
  orders: number;
  revenue: number;
}

export function salesSeriesByDay(
  orders: OrderRow[],
  timeZone: string,
): DaySalesPoint[] {
  const byDay = new Map<string, DaySalesPoint>();
  for (const o of orders) {
    if (o.cancelled_at || !o.created_at) continue;
    const { date } = tzParts(o.created_at, timeZone);
    const pt = byDay.get(date) ?? { date, orders: 0, revenue: 0 };
    pt.orders += 1;
    pt.revenue = round2(pt.revenue + netAmount(o));
    byDay.set(date, pt);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface StoreSalesPoint extends SalesSummary {
  storeId: string;
  name: string;
}

export function salesByStore(
  orders: OrderRow[],
  storeNames: Record<string, string>,
): StoreSalesPoint[] {
  const byStore = new Map<string, OrderRow[]>();
  for (const o of orders) {
    const arr = byStore.get(o.store_id) ?? [];
    arr.push(o);
    byStore.set(o.store_id, arr);
  }
  return [...byStore.entries()]
    .map(([storeId, rows]) => ({
      storeId,
      name: storeNames[storeId] ?? storeId,
      ...salesSummary(rows),
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

export interface PeriodComparison {
  current: SalesSummary;
  previous: SalesSummary;
  ordersDeltaPct: number | null;
  revenueDeltaPct: number | null;
  aovDeltaPct: number | null;
}

export function comparePeriods(
  current: SalesSummary,
  previous: SalesSummary,
): PeriodComparison {
  return {
    current,
    previous,
    ordersDeltaPct: pctDelta(current.ordersCount, previous.ordersCount),
    revenueDeltaPct: pctDelta(current.revenue, previous.revenue),
    aovDeltaPct: pctDelta(current.aov, previous.aov),
  };
}

// --- rollup-based aggregation (what the dashboard reads for speed) ---------

export interface RollupTotals {
  ordersCount: number;
  revenue: number;
  aov: number;
  conversationsCount: number;
  conversionRate: number; // orders / conversations
  promoOrders: number;
  stockValidarOrders: number;
  codOrders: number;
  agencyOrders: number;
  cancelledOrders: number;
  refundedAmount: number;
  inboundMessages: number;
  avgFirstResponseSeconds: number | null;
}

export function aggregateRollups(rows: DailyRollupRow[]): RollupTotals {
  const t = rows.reduce(
    (acc, r) => {
      acc.ordersCount += r.orders_count;
      acc.revenue += Number(r.revenue);
      acc.conversationsCount += r.conversations_count;
      acc.promoOrders += r.promo_orders;
      acc.stockValidarOrders += r.stock_validar_orders;
      acc.codOrders += r.cod_orders;
      acc.agencyOrders += r.agency_orders;
      acc.cancelledOrders += r.cancelled_orders;
      acc.refundedAmount += Number(r.refunded_amount);
      acc.inboundMessages += r.inbound_messages ?? 0;
      acc.responseSecondsSum += Number(r.response_seconds_sum ?? 0);
      acc.responseSamples += r.response_samples ?? 0;
      return acc;
    },
    {
      ordersCount: 0,
      revenue: 0,
      conversationsCount: 0,
      promoOrders: 0,
      stockValidarOrders: 0,
      codOrders: 0,
      agencyOrders: 0,
      cancelledOrders: 0,
      refundedAmount: 0,
      inboundMessages: 0,
      responseSecondsSum: 0,
      responseSamples: 0,
    },
  );
  return {
    ordersCount: t.ordersCount,
    revenue: round2(t.revenue),
    aov: t.ordersCount ? round2(t.revenue / t.ordersCount) : 0,
    conversationsCount: t.conversationsCount,
    conversionRate: t.conversationsCount
      ? round2((t.ordersCount / t.conversationsCount) * 100) / 100
      : 0,
    promoOrders: t.promoOrders,
    stockValidarOrders: t.stockValidarOrders,
    codOrders: t.codOrders,
    agencyOrders: t.agencyOrders,
    cancelledOrders: t.cancelledOrders,
    refundedAmount: round2(t.refundedAmount),
    inboundMessages: t.inboundMessages,
    avgFirstResponseSeconds: t.responseSamples
      ? round2(t.responseSecondsSum / t.responseSamples)
      : null,
  };
}

export interface RollupSeriesPoint {
  date: string;
  orders: number;
  revenue: number;
  conversations: number;
  conversionRate: number;
}

/** Merge rollups across stores into one series by date (for the consolidated view). */
export function rollupSeries(rows: DailyRollupRow[]): RollupSeriesPoint[] {
  const byDate = new Map<string, RollupSeriesPoint>();
  for (const r of rows) {
    const pt =
      byDate.get(r.date) ??
      { date: r.date, orders: 0, revenue: 0, conversations: 0, conversionRate: 0 };
    pt.orders += r.orders_count;
    pt.revenue = round2(pt.revenue + Number(r.revenue));
    pt.conversations += r.conversations_count;
    byDate.set(r.date, pt);
  }
  for (const pt of byDate.values()) {
    pt.conversionRate = pt.conversations
      ? round2((pt.orders / pt.conversations) * 100) / 100
      : 0;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ===========================================================================
// Family 2 — Embudo / conversión
// ===========================================================================

export interface Funnel {
  conversations: number;
  orders: number;
  conversionRate: number; // 0..1
}

export function funnel(
  orders: OrderRow[],
  conversations: ConversationRow[],
): Funnel {
  const conv = conversations.length;
  const ord = activeOrders(orders).length;
  return {
    conversations: conv,
    orders: ord,
    conversionRate: conv ? round2((ord / conv) * 10000) / 10000 : 0,
  };
}

export interface FunnelFineLink {
  ordersWithConversationId: number;
  matchedOrders: number; // order.kapso_conversation_id ∈ conversations
  matchedConversations: number; // distinct conversations that produced an order
  unmatchedOrders: number; // have a conv id but no conversation row
  orphanOrders: number; // no conversation id at all
}

/** Fine-grained join orders ↔ conversations on kapso_conversation_id. */
export function funnelFineLink(
  orders: OrderRow[],
  conversations: ConversationRow[],
): FunnelFineLink {
  const convIds = new Set(conversations.map((c) => c.kapso_conversation_id));
  const matchedConvSet = new Set<string>();
  let ordersWithConversationId = 0;
  let matchedOrders = 0;
  let unmatchedOrders = 0;
  let orphanOrders = 0;

  for (const o of orders) {
    const id = o.kapso_conversation_id;
    if (!id) {
      orphanOrders += 1;
      continue;
    }
    ordersWithConversationId += 1;
    if (convIds.has(id)) {
      matchedOrders += 1;
      matchedConvSet.add(id);
    } else {
      unmatchedOrders += 1;
    }
  }
  return {
    ordersWithConversationId,
    matchedOrders,
    matchedConversations: matchedConvSet.size,
    unmatchedOrders,
    orphanOrders,
  };
}

// ===========================================================================
// Family 3 — Desglose de negocio
// ===========================================================================

export interface BusinessBreakdown {
  total: number;
  promoOrders: number;
  promoPct: number;
  stockValidarOrders: number;
  codOrders: number;
  agencyOrders: number;
  otherShippingOrders: number;
  cancelledOrders: number;
  refundedAmount: number;
}

export function businessBreakdown(orders: OrderRow[]): BusinessBreakdown {
  const active = activeOrders(orders);
  const total = active.length;
  let promoOrders = 0;
  let stockValidarOrders = 0;
  let codOrders = 0;
  let agencyOrders = 0;
  let refundedAmount = 0;
  for (const o of active) {
    if (o.promo_applied) promoOrders += 1;
    if (o.stock_por_validar) stockValidarOrders += 1;
    if (o.shipping_mode === "cod") codOrders += 1;
    else if (o.shipping_mode === "agency") agencyOrders += 1;
    refundedAmount += o.total_refunded ?? 0;
  }
  return {
    total,
    promoOrders,
    promoPct: total ? round2((promoOrders / total) * 100) : 0,
    stockValidarOrders,
    codOrders,
    agencyOrders,
    otherShippingOrders: total - codOrders - agencyOrders,
    cancelledOrders: orders.length - total,
    refundedAmount: round2(refundedAmount),
  };
}

export interface TopProduct {
  key: string;
  title: string;
  quantity: number;
  revenue: number;
  orders: number;
}

/** Aggregate line_items across orders. Groups by SKU when present, else title. */
export function topProducts(orders: OrderRow[], limit = 10): TopProduct[] {
  const acc = new Map<string, TopProduct>();
  for (const o of activeOrders(orders)) {
    const seen = new Set<string>();
    for (const li of o.line_items ?? []) {
      const key = (li.sku && li.sku.trim()) || li.title || "—";
      const entry =
        acc.get(key) ?? { key, title: li.title || key, quantity: 0, revenue: 0, orders: 0 };
      entry.quantity += li.quantity ?? 0;
      entry.revenue = round2(entry.revenue + (li.price ?? 0) * (li.quantity ?? 0));
      if (!seen.has(key)) {
        entry.orders += 1;
        seen.add(key);
      }
      acc.set(key, entry);
    }
  }
  return [...acc.values()]
    .sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue)
    .slice(0, limit);
}

export interface DateHourPattern {
  /** matrix[weekday][hour] = order count (weekday 0=Sun, hour 0-23) */
  matrix: number[][];
  byHour: number[]; // length 24
  byWeekday: number[]; // length 7
  peak: { weekday: number; hour: number; count: number } | null;
}

export function dateHourPattern(
  orders: OrderRow[],
  timeZone: string,
): DateHourPattern {
  const matrix: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const byHour = new Array(24).fill(0);
  const byWeekday = new Array(7).fill(0);
  let peak: DateHourPattern["peak"] = null;

  for (const o of orders) {
    if (o.cancelled_at || !o.created_at) continue;
    const { hour, weekday } = tzParts(o.created_at, timeZone);
    const row = matrix[weekday]!;
    row[hour] = (row[hour] ?? 0) + 1;
    byHour[hour] += 1;
    byWeekday[weekday] += 1;
    const count = row[hour]!;
    if (!peak || count > peak.count) peak = { weekday, hour, count };
  }
  return { matrix, byHour, byWeekday, peak };
}

// ===========================================================================
// Family 4 — Operativo Kapso (best-effort)
// ===========================================================================

export interface ApiLogsSummary {
  total: number;
  errors: number;
  errorRate: number; // 0..1
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Latency in ms, tolerant of the many field names a log might use. */
function latencyOf(log: Record<string, unknown>): number | null {
  const direct =
    num(log.duration_ms) ??
    num(log.latency_ms) ??
    num(log.response_time_ms) ??
    num(log.elapsed_ms) ??
    num(log.duration) ??
    num(log.latency);
  if (direct !== null) return direct;
  const timing = log.timing as Record<string, unknown> | undefined;
  if (timing) return num(timing.duration_ms) ?? num(timing.latency_ms) ?? null;
  return null;
}

/** HTTP status, tolerant of field-name variants. */
function statusOf(log: Record<string, unknown>): number | null {
  return num(log.status_code) ?? num(log.status) ?? num(log.response_status) ?? num(log.code);
}

/** Nearest-rank percentile (p in 0..1) over a pre-sorted ascending array. */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

export function summarizeApiLogs(
  logs: ReadonlyArray<Record<string, unknown>>,
): ApiLogsSummary {
  const total = logs.length;
  let errors = 0;
  const latencies: number[] = [];
  for (const l of logs) {
    const st = statusOf(l);
    if (st !== null && st >= 400) errors += 1;
    const lat = latencyOf(l);
    if (lat !== null) latencies.push(lat);
  }
  latencies.sort((a, b) => a - b);
  const avg = latencies.length
    ? round2(latencies.reduce((s, n) => s + n, 0) / latencies.length)
    : null;
  return {
    total,
    errors,
    errorRate: total ? round2((errors / total) * 10000) / 10000 : 0,
    avgLatencyMs: avg,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
  };
}

export interface OpsSnapshotPayload {
  capturedAt: string;
  health: { status: string; error?: string | null; checks?: Record<string, unknown> | null } | null;
  apiLogs: ApiLogsSummary | null;
  activity24h: {
    conversations: number;
    activeConversations: number;
    messages?: number | null;
  } | null;
  bestEffort: true;
}

/** Assemble the JSON stored in ops_snapshots.payload. */
export function buildOpsSnapshotPayload(input: {
  health?: { status: string; error?: string | null; checks?: Record<string, unknown> | null } | null;
  apiLogs?: ApiLogsSummary | null;
  activity24h?: OpsSnapshotPayload["activity24h"];
  capturedAt?: string;
}): OpsSnapshotPayload {
  return {
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    health: input.health ?? null,
    apiLogs: input.apiLogs ?? null,
    activity24h: input.activity24h ?? null,
    bestEffort: true,
  };
}

// ===========================================================================
// Rollup builder (shared by cron + seed; mirrors recompute_daily_rollups SQL)
// ===========================================================================

/** Build daily_rollups rows for a store from raw orders + conversations. */
export function computeDailyRollups(
  storeId: string,
  orders: OrderRow[],
  conversations: ConversationRow[],
  timeZone: string,
): DailyRollupRow[] {
  type Acc = Omit<DailyRollupRow, "store_id" | "date" | "aov" | "conversion_rate">;
  const byDate = new Map<string, Acc>();
  const ensure = (date: string): Acc => {
    let a = byDate.get(date);
    if (!a) {
      a = {
        orders_count: 0,
        revenue: 0,
        conversations_count: 0,
        promo_orders: 0,
        stock_validar_orders: 0,
        cod_orders: 0,
        agency_orders: 0,
        cancelled_orders: 0,
        refunded_amount: 0,
        inbound_messages: 0,
        response_seconds_sum: 0,
        response_samples: 0,
      };
      byDate.set(date, a);
    }
    return a;
  };

  for (const o of orders) {
    if (!o.created_at) continue;
    const { date } = tzParts(o.created_at, timeZone);
    const a = ensure(date);
    if (o.cancelled_at) {
      a.cancelled_orders += 1;
      continue;
    }
    a.orders_count += 1;
    a.revenue = round2(a.revenue + netAmount(o));
    a.refunded_amount = round2(a.refunded_amount + (o.total_refunded ?? 0));
    if (o.promo_applied) a.promo_orders += 1;
    if (o.stock_por_validar) a.stock_validar_orders += 1;
    if (o.shipping_mode === "cod") a.cod_orders += 1;
    else if (o.shipping_mode === "agency") a.agency_orders += 1;
  }
  for (const c of conversations) {
    if (!c.started_at) continue;
    const { date } = tzParts(c.started_at, timeZone);
    const a = ensure(date);
    a.conversations_count += 1;
    a.inbound_messages += c.inbound_count ?? 0;
    if (c.first_response_seconds != null) {
      a.response_seconds_sum += c.first_response_seconds;
      a.response_samples += 1;
    }
  }

  return [...byDate.entries()]
    .map(([date, a]) => ({
      store_id: storeId,
      date,
      ...a,
      aov: a.orders_count ? round2(a.revenue / a.orders_count) : 0,
      conversion_rate: a.conversations_count
        ? Math.round((a.orders_count / a.conversations_count) * 10000) / 10000
        : 0,
    }))
    .sort((x, y) => x.date.localeCompare(y.date));
}

// ===========================================================================
// Family 5 — Leads-derived (loss reasons, channels, conversational funnel)
//
// These read the `leads` table (phone-based CRM rows the bot/agents maintain).
// The status taxonomy lives in lib/leads.ts; the bucket mappings below are the
// product-tunable part — adjust as the CRM grows new statuses.
// ===========================================================================

/** A lead status code → "why didn't they buy" bucket. */
const LOSS_BUCKET_BY_STATUS: Record<string, string> = {
  // not reached / no firm answer / not worked yet
  nuevo: "no_respondio",
  no_responde: "no_respondio",
  cuelga: "no_respondio",
  buzon: "no_respondio",
  nr_no_existe: "no_respondio",
  nr_extranjero: "no_respondio",
  contactado_dejo_wsp: "no_respondio",
  // bought elsewhere
  ya_compro_otro_lado: "compro_otro_lado",
  // only wanted info / asked other products
  solo_informacion: "solo_info",
  otros_productos: "solo_info",
  // out of stock
  sin_stock: "sin_stock",
  // cancelled
  cancelado: "cancelado",
  cancelado_cliente: "cancelado",
  // everything else
  lista_negra: "otros",
  duplicado: "otros",
};

const LOSS_BUCKET_LABEL: Record<string, string> = {
  no_respondio: "No respondió / sin contactar",
  compro_otro_lado: "Compró en otro lado",
  solo_info: "Solo información",
  sin_stock: "Sin stock",
  cancelado: "Cancelado",
  otros: "Otros",
};

const LOSS_BUCKET_ORDER = [
  "no_respondio",
  "compro_otro_lado",
  "solo_info",
  "sin_stock",
  "cancelado",
  "otros",
];

export interface LossReason {
  bucket: string;
  label: string;
  count: number;
  pct: number; // 0..100 share of non-buyers
}

export interface LossReasonsResult {
  total: number;
  reasons: LossReason[];
}

export interface SourceStat {
  key: string; // 'meta_ad' | 'organic'
  label: string;
  leads: number;
  pedidos: number; // leads that converted (has_order)
  conversion: number; // pedidos / leads, 0..1
  ingresos: number; // net revenue of those orders
}

/**
 * Conversion + revenue per acquisition source, so campaign performance can be
 * read independently and against organic without removing anything from the
 * shared WhatsApp flow. Leads whose `source` is 'meta_ad' (Click-to-WhatsApp ad)
 * bucket separately; revenue joins orders by customer phone (the same key the
 * lead sync links on). Returns [] when no lead carries a source yet, so the
 * dashboard module stays hidden until campaign data exists.
 */
export function sourceBreakdown(leads: LeadRow[], orders: OrderRow[]): SourceStat[] {
  if (!leads.some((l) => l.source)) return [];
  const netByPhone = new Map<string, number>();
  for (const o of activeOrders(orders)) {
    if (!o.customer_phone) continue;
    const net = Number(o.total_amount ?? 0) - Number(o.total_refunded ?? 0);
    netByPhone.set(o.customer_phone, (netByPhone.get(o.customer_phone) ?? 0) + net);
  }
  const buckets = new Map<string, { leads: number; pedidos: number; ingresos: number }>();
  for (const l of leads) {
    const key = l.source === "meta_ad" ? "meta_ad" : "organic";
    const b = buckets.get(key) ?? { leads: 0, pedidos: 0, ingresos: 0 };
    b.leads += 1;
    if (l.has_order) {
      b.pedidos += 1;
      b.ingresos += netByPhone.get(l.phone) ?? 0;
    }
    buckets.set(key, b);
  }
  const labels: Record<string, string> = { meta_ad: "Meta Ads (campañas)", organic: "Orgánico" };
  return [...buckets.entries()]
    .map(([key, b]) => ({
      key,
      label: labels[key] ?? key,
      leads: b.leads,
      pedidos: b.pedidos,
      conversion: b.leads ? b.pedidos / b.leads : 0,
      ingresos: round2(b.ingresos),
    }))
    .sort((a, b) => b.ingresos - a.ingresos || b.leads - a.leads);
}

export interface CampaignStat {
  adId: string;
  label: string; // ad headline if captured, else the ad id
  leads: number;
  pedidos: number;
  conversion: number; // 0..1
  ingresos: number; // net revenue attributed to this ad's leads
}

/**
 * Revenue + conversion per Meta ad — the revenue half of ROAS. Groups the
 * `meta_ad` leads by `ad_id` (label = captured ad headline) and joins orders by
 * phone. Ad spend (Meta Ads API) is layered on later to produce ROAS = ingresos
 * / spend. Returns [] when there are no attributed campaign leads yet.
 */
export function campaignBreakdown(leads: LeadRow[], orders: OrderRow[]): CampaignStat[] {
  const adLeads = leads.filter((l) => l.source === "meta_ad" && (l.ad_id || l.ad_headline));
  if (!adLeads.length) return [];
  const netByPhone = new Map<string, number>();
  for (const o of activeOrders(orders)) {
    if (!o.customer_phone) continue;
    const net = Number(o.total_amount ?? 0) - Number(o.total_refunded ?? 0);
    netByPhone.set(o.customer_phone, (netByPhone.get(o.customer_phone) ?? 0) + net);
  }
  const m = new Map<string, { label: string; leads: number; pedidos: number; ingresos: number }>();
  for (const l of adLeads) {
    const key = l.ad_id || l.ad_headline!;
    const b = m.get(key) ?? { label: l.ad_headline || l.ad_id || key, leads: 0, pedidos: 0, ingresos: 0 };
    if (l.ad_headline) b.label = l.ad_headline; // prefer a human headline
    b.leads += 1;
    if (l.has_order) {
      b.pedidos += 1;
      b.ingresos += netByPhone.get(l.phone) ?? 0;
    }
    m.set(key, b);
  }
  return [...m.entries()]
    .map(([adId, b]) => ({
      adId,
      label: b.label,
      leads: b.leads,
      pedidos: b.pedidos,
      conversion: b.leads ? b.pedidos / b.leads : 0,
      ingresos: round2(b.ingresos),
    }))
    .sort((a, b) => b.ingresos - a.ingresos || b.leads - a.leads);
}

/**
 * "¿Por qué NO compraron?" — bucket the non-buying leads by status. The universe
 * is leads with no order that aren't actively hot (in-progress) or won.
 */
export function lossReasons(leads: LeadRow[]): LossReasonsResult {
  const counts = new Map<string, number>();
  for (const l of leads) {
    if (l.has_order) continue;
    if (l.category === "won" || l.category === "hot") continue;
    if (l.status === "sin_stock") continue; // recuperable (vuelve a la cola), no cuenta como pérdida
    const bucket = LOSS_BUCKET_BY_STATUS[l.status] ?? "otros";
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((s, n) => s + n, 0);
  const reasons = LOSS_BUCKET_ORDER.map((bucket) => {
    const count = counts.get(bucket) ?? 0;
    return {
      bucket,
      label: LOSS_BUCKET_LABEL[bucket]!,
      count,
      pct: total ? round2((count / total) * 100) : 0,
    };
  })
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  return { total, reasons };
}

export interface LostRevenue {
  bucket: string;
  label: string;
  lostCount: number;
  estRevenue: number;
}

/**
 * Estimated lost revenue per reason = lost-lead count × period AOV. A coarse but
 * defensible "if these had converted at the average ticket" estimate.
 */
export function lostRevenueByReason(
  loss: LossReasonsResult,
  aov: number,
): { items: LostRevenue[]; total: number } {
  const items = loss.reasons.map((r) => ({
    bucket: r.bucket,
    label: r.label,
    lostCount: r.count,
    estRevenue: round2(r.count * aov),
  }));
  return { items, total: round2(items.reduce((s, i) => s + i.estRevenue, 0)) };
}

export interface ChannelFunnel {
  leads: number;
  orders: number;
  conversionRate: number; // 0..1
}

export interface BotVsAdvisor {
  bot: ChannelFunnel;
  advisor: ChannelFunnel;
}

/**
 * Bot-handled vs advisor-handled performance. v1 attributes a lead to the
 * advisor channel when the bot escalated it (handoff_at set); everything the
 * bot handled end-to-end is the bot channel. Refine later with vendedora-tagged
 * orders once the leads "generate order" flow tags them.
 */
export function botVsAdvisor(leads: LeadRow[]): BotVsAdvisor {
  const mk = (subset: LeadRow[]): ChannelFunnel => {
    const n = subset.length;
    const orders = subset.filter((l) => l.has_order).length;
    return { leads: n, orders, conversionRate: n ? round2((orders / n) * 10000) / 10000 : 0 };
  };
  return {
    bot: mk(leads.filter((l) => l.handoff_at == null)),
    advisor: mk(leads.filter((l) => l.handoff_at != null)),
  };
}

export interface FunnelStage {
  key: string;
  label: string;
  value: number;
  stepPct: number | null; // 0..1 conversion vs. the previous stage (null for the first)
}

// Lead statuses that signal genuine engagement / data capture / commitment.
const INTERESADOS_STATUSES = new Set([
  "casi_cierra",
  "yape_por_verificar",
  "otros_productos",
  "contactado_dejo_wsp",
]);
const DATOS_STATUSES = new Set(["casi_cierra", "yape_por_verificar"]);

/**
 * The 6-stage conversational funnel. Top two stages come from messages/
 * conversations; the middle three from lead engagement signals; the last from
 * actual orders. `inboundMessages` (Phase C) overrides the message proxy.
 */
export function conversationalFunnel(input: {
  conversations: ConversationRow[];
  leads: LeadRow[];
  orders: OrderRow[];
  inboundMessages?: number | null;
}): FunnelStage[] {
  const { conversations, leads, orders } = input;
  const isWon = (l: LeadRow) => l.category === "won" || l.has_order;
  const inbound =
    input.inboundMessages ?? conversations.reduce((s, c) => s + (c.message_count ?? 0), 0);
  const raw = [
    { key: "mensajes", label: "Mensajes entrantes", value: inbound },
    { key: "conversaciones", label: "Conversaciones iniciadas", value: conversations.length },
    {
      key: "interesados",
      label: "Interesados reales",
      value: leads.filter((l) => isWon(l) || INTERESADOS_STATUSES.has(l.status)).length,
    },
    {
      key: "datos",
      label: "Datos capturados",
      value: leads.filter((l) => isWon(l) || DATOS_STATUSES.has(l.status)).length,
    },
    {
      key: "compromiso",
      label: "Compromiso de compra",
      value: leads.filter((l) => isWon(l) || l.status === "yape_por_verificar").length,
    },
    { key: "pedidos", label: "Pedidos creados", value: activeOrders(orders).length },
  ];
  return raw.map((s, i) => {
    const prev = i === 0 ? null : raw[i - 1]!.value;
    return {
      ...s,
      stepPct: prev ? round2((s.value / prev) * 10000) / 10000 : i === 0 ? null : null,
    };
  });
}

export type HealthStatus = "green" | "amber" | "red";

export interface StageHealth {
  key: string;
  label: string;
  stepPct: number | null;
  status: HealthStatus;
}

export interface FunnelHealthResult {
  stages: StageHealth[];
  critical: StageHealth | null;
}

/**
 * Heuristic health per funnel step: green if the step conversion clears the
 * green threshold, amber above the amber threshold, else red. The critical
 * point is the worst step. Thresholds are tunable to the business benchmarks.
 */
export function funnelHealth(
  stages: FunnelStage[],
  thresholds: { green: number; amber: number } = { green: 0.6, amber: 0.3 },
): FunnelHealthResult {
  const out: StageHealth[] = stages.map((s) => {
    let status: HealthStatus = "green";
    if (s.stepPct != null) {
      if (s.stepPct >= thresholds.green) status = "green";
      else if (s.stepPct >= thresholds.amber) status = "amber";
      else status = "red";
    }
    return { key: s.key, label: s.label, stepPct: s.stepPct, status };
  });
  let critical: StageHealth | null = null;
  for (const s of out) {
    if (s.stepPct == null) continue;
    if (!critical || (critical.stepPct ?? 1) > s.stepPct) critical = s;
  }
  return { stages: out, critical };
}

// ===========================================================================
// Formatting helpers (used by the UI)
// ===========================================================================

export function formatCurrency(amount: number, currency = "PEN", locale = "es-PE"): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export function formatPct(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Human duration from seconds: "45s", "1m 12s", "2h 5m". null → "—". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = s % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
