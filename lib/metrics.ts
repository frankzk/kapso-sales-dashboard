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
    ensure(date).conversations_count += 1;
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
