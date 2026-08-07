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
  CampaignDeliveryOutcome,
  ConversationRow,
  DailyRollupRow,
  LeadRow,
  MetaAdPerformance,
  OrderRow,
} from "@/lib/types";
import { prettyAdName, type AdMeta } from "@/lib/meta-ads";

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
  key: string; // 'meta_ad' | 'cod_cart' | 'organic'
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
    const key =
      l.source === "meta_ad"
        ? "meta_ad"
        : l.source === "fb_web"
          ? "fb_web"
          : l.source === "cod_cart"
            ? "cod_cart"
            : l.source === "abandoned_browse"
              ? "abandoned_browse"
              : "organic";
    const b = buckets.get(key) ?? { leads: 0, pedidos: 0, ingresos: 0 };
    b.leads += 1;
    if (l.has_order) {
      b.pedidos += 1;
      b.ingresos += (l.phone ? (netByPhone.get(l.phone) ?? 0) : 0);
    }
    buckets.set(key, b);
  }
  const labels: Record<string, string> = {
    meta_ad: "Meta Ads (campañas)",
    fb_web: "🌐 Meta / Web (FB·IG)",
    cod_cart: "🛒 Carrito abandonado",
    abandoned_browse: "🔎 Búsqueda abandonada",
    organic: "Orgánico",
  };
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

// ---------------------------------------------------------------------------
// Recuperación de carritos abandonados (Shopify draft orders / Releasit COD).
// How many carts came in, how many became real orders (recovery rate), the
// revenue recovered, and the value still on the table. A "cart lead" is one
// backed by a real Shopify draft (draft_order_gid) or born from the COD form
// (source cod_cart) — NOT a chat the bot merely summarized.
// ---------------------------------------------------------------------------

export interface CartRecoveryStats {
  total: number; // abandoned-cart leads in range
  recuperados: number; // became a real order
  pendientes: number; // still open / workable
  perdidos: number; // marked lost (cancelado, ya compró en otro lado, …)
  tasaRecuperacion: number; // recuperados / total, 0..1
  ingresosRecuperados: number; // net revenue of recovered carts
  ticketPromedio: number; // ingresosRecuperados / recuperados (0 if none)
  valorEnRiesgo: number; // Σ cart_value of the pendientes (money still on the table)
}

/** True for a lead backed by a real abandoned cart (Shopify draft or COD form). */
function isCartLead(l: LeadRow): boolean {
  return !!l.draft_order_gid || l.source === "cod_cart";
}

/** Abandoned-cart recovery for the period. Returns null when there are no cart
 *  leads at all, so the dashboard module stays hidden until carts exist. */
export function cartRecovery(leads: LeadRow[], orders: OrderRow[]): CartRecoveryStats | null {
  const carts = leads.filter(isCartLead);
  if (!carts.length) return null;

  const netByPhone = new Map<string, number>();
  for (const o of activeOrders(orders)) {
    if (!o.customer_phone) continue;
    const net = Number(o.total_amount ?? 0) - Number(o.total_refunded ?? 0);
    netByPhone.set(o.customer_phone, (netByPhone.get(o.customer_phone) ?? 0) + net);
  }

  let recuperados = 0;
  let pendientes = 0;
  let perdidos = 0;
  let ingresosRecuperados = 0;
  let valorEnRiesgo = 0;
  for (const l of carts) {
    const recovered = !!l.has_order || l.draft_order_status === "completed";
    if (recovered) {
      recuperados += 1;
      ingresosRecuperados += (l.phone ? (netByPhone.get(l.phone) ?? 0) : 0);
    } else if (l.category === "lost") {
      perdidos += 1;
    } else {
      pendientes += 1;
      valorEnRiesgo += Number(l.cart_value ?? 0);
    }
  }
  const total = carts.length;
  return {
    total,
    recuperados,
    pendientes,
    perdidos,
    tasaRecuperacion: total ? recuperados / total : 0,
    ingresosRecuperados: round2(ingresosRecuperados),
    ticketPromedio: recuperados ? round2(ingresosRecuperados / recuperados) : 0,
    valorEnRiesgo: round2(valorEnRiesgo),
  };
}

export interface CampaignStat {
  rowKey: string;
  adId: string;
  metaAdId: string | null;
  storeIds: string[];
  label: string;
  headline: string | null;
  resolved: boolean;
  meta: AdMeta | null;
  leads: number;
  metaConversations: number;
  conversationCoverageRate: number | null;
  pedidos: number;
  conversion: number;
  ingresos: number;
  promotedProductName: string | null;
  promotedSkus: string[];
  exactOrders: number;
  mixedOrders: number;
  crossSellOrders: number;
  unknownProductOrders: number;
  productMatchRate: number | null;
  deliveredOrders: number;
  cancelledOrders: number;
  inRouteOrders: number;
  shipmentKnown: number;
  logisticsCoverageRate: number | null;
  deliveryRate: number | null;
  deliveredRevenue: number;
  revenuePerLead: number;
  avgTicket: number;
  metaCurrency: string | null;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  inlineLinkClicks: number;
  activeDays: number;
  metaSyncedAt: string | null;
  currencyConflict: boolean;
  cpm: number | null;
  frequency: number | null;
  ctr: number | null;
  cpc: number | null;
  cpl: number | null;
  cpa: number | null;
  deliveredCpa: number | null;
  roas: number | null;
  deliveredRoas: number | null;
  decision: CampaignDecision;
  decisionReason: string;
  productMix: Array<{ title: string; sku: string | null; orders: number; units: number }>;
  orders: CampaignOrderDetail[];
}

/**
 * Clave para agrupar nombres de producto en el filtro del panel de anuncios.
 *
 * NO reusa `normalizeProductName` de `lib/aliclik-catalog`: ese vive en un
 * módulo que importa el cliente admin de Supabase —no puede entrar al bundle
 * del navegador— y además responde otra pregunta, la de emparejar contra el
 * catálogo de Aliclik, con su sufijo de tienda. Atar el filtro a esa función
 * haría que un cambio en el emparejamiento de Aliclik moviera en silencio lo
 * que el panel agrupa.
 *
 * Quita marcas y acentos porque el mismo producto llega escrito de dos formas:
 * el anunciado lo teclea el equipo («Shampoo Biru Anticaspa») y el vendido sale
 * de la línea de pedido de Shopify («Shampoo Biru™ Anticaspa»).
 */
export function campaignProductKey(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[™®©]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface CampaignProductOption {
  /** Clave normalizada; es lo que se guarda como filtro seleccionado. */
  key: string;
  /** La grafía más frecuente entre los anuncios, para mostrar. */
  label: string;
  /** Anuncios que lo promocionan. */
  promotedAds: number;
  /** Anuncios cuyos pedidos lo contienen, lo anuncien o no. */
  soldAds: number;
}

/**
 * El catálogo del desplegable. Con `includeSold` en falso solo entran los
 * productos ANUNCIADOS: si entraran también los vendidos, elegir uno que nadie
 * anuncia devolvería cero filas sin explicar por qué.
 */
export function campaignProductOptions(
  rows: readonly Pick<CampaignStat, "promotedProductName" | "productMix">[],
  includeSold: boolean,
): CampaignProductOption[] {
  const byKey = new Map<
    string,
    { promotedAds: number; soldAds: number; spellings: Map<string, number> }
  >();
  const touch = (raw: string | null | undefined, field: "promotedAds" | "soldAds") => {
    const key = campaignProductKey(raw);
    if (!key) return;
    const entry = byKey.get(key) ?? { promotedAds: 0, soldAds: 0, spellings: new Map() };
    entry[field] += 1;
    const shown = (raw ?? "").trim();
    if (shown) entry.spellings.set(shown, (entry.spellings.get(shown) ?? 0) + 1);
    byKey.set(key, entry);
  };
  for (const row of rows) {
    touch(row.promotedProductName, "promotedAds");
    // Un anuncio cuenta UNA vez por producto vendido aunque tenga varios
    // pedidos de ese producto: el desplegable cuenta anuncios, no pedidos.
    const seen = new Set<string>();
    for (const item of row.productMix) {
      const key = campaignProductKey(item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      touch(item.title, "soldAds");
    }
  }
  return [...byKey.entries()]
    .filter(([, entry]) => includeSold || entry.promotedAds > 0)
    .map(([key, entry]) => ({
      key,
      label:
        [...entry.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "es"))[0]?.[0] ?? key,
      promotedAds: entry.promotedAds,
      soldAds: entry.soldAds,
    }))
    .sort(
      (a, b) =>
        b.promotedAds + b.soldAds - (a.promotedAds + a.soldAds) ||
        a.label.localeCompare(b.label, "es"),
    );
}

/**
 * ¿Esta fila entra con el filtro puesto? Sin clave, entran todas.
 *
 * `includeSold` amplía a lo que los pedidos REALMENTE contienen, que es otra
 * pregunta: «qué anuncios venden este producto» en vez de «qué anuncios lo
 * anuncian». Es la que destapa que un anuncio esté vendiendo otra cosa.
 */
export function campaignMatchesProduct(
  row: Pick<CampaignStat, "promotedProductName" | "productMix">,
  key: string,
  includeSold: boolean,
): boolean {
  if (!key) return true;
  if (campaignProductKey(row.promotedProductName) === key) return true;
  if (!includeSold) return false;
  return row.productMix.some((item) => campaignProductKey(item.title) === key);
}

export type CampaignProductMatch = "exact" | "mixed" | "cross_sell" | "unknown";
export type CampaignDecision =
  | "insufficient"
  | "scale"
  | "promising"
  | "review_close"
  | "misaligned"
  | "operational"
  | "no_attribution"
  | "data_incomplete";

export interface CampaignOrderDetail {
  orderId: string;
  code: string | null;
  createdAt: string | null;
  customerName: string | null;
  total: number;
  products: Array<{ title: string; sku: string | null; quantity: number }>;
  match: CampaignProductMatch;
  deliveryStatus: string | null;
  statusCategory: string | null;
  timeToOrderHours: number | null;
}

function compactCampaignText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function campaignLineMatches(title: string, sku: string | null, product: string | null, skus: string[]): boolean {
  const normalizedSku = (sku ?? "").trim().toUpperCase();
  if (skus.length) return !!normalizedSku && skus.includes(normalizedSku);
  const expected = compactCampaignText(product);
  const actual = compactCampaignText(title);
  if (!expected) return false;
  if (actual.includes(expected) || expected.includes(actual)) return true;
  const tokens = expected.split(" ").filter((token) => token.length >= 4);
  return tokens.length >= 2 && tokens.filter((token) => actual.includes(token)).length / tokens.length >= 0.6;
}

function campaignProductMatch(order: OrderRow, product: string | null, skus: string[]): CampaignProductMatch {
  if (!product && !skus.length) return "unknown";
  const items = order.line_items ?? [];
  if (!items.length) return "unknown";
  const hits = items.filter((item) => campaignLineMatches(item.title, item.sku, product, skus)).length;
  return hits === items.length ? "exact" : hits > 0 ? "mixed" : "cross_sell";
}

function campaignDeliveryBucket(outcome?: CampaignDeliveryOutcome): "delivered" | "cancelled" | "in_route" | "other" {
  const value = compactCampaignText(`${outcome?.statusCategory ?? ""} ${outcome?.deliveryStatus ?? ""}`);
  if (value.includes("entreg") || value.includes("deliver")) return "delivered";
  if (value.includes("anulad") || value.includes("cancel")) return "cancelled";
  if (value.includes("ruta") || value.includes("transit")) return "in_route";
  return "other";
}

export function campaignBreakdown(
  leads: LeadRow[],
  orders: OrderRow[],
  names: Record<string, AdMeta> = {},
  deliveries: CampaignDeliveryOutcome[] = [],
  performance: MetaAdPerformance[] = [],
): CampaignStat[] {
  const adLeads = leads.filter((l) => l.source === "meta_ad" && (l.ad_id || l.ad_headline));
  if (!adLeads.length && !performance.length) return [];
  const ordersById = new Map(orders.filter((o) => o.id).map((o) => [o.id!, o]));
  const deliveryByOrder = new Map(deliveries.map((outcome) => [outcome.orderId, outcome]));
  const performanceByAd = new Map<string, MetaAdPerformance & { currencyConflict?: boolean }>();
  for (const insight of performance) {
    const previous = performanceByAd.get(insight.adId);
    if (!previous) {
      performanceByAd.set(insight.adId, { ...insight });
      continue;
    }
    const currencies = new Set([previous.currency, insight.currency].filter(Boolean));
    performanceByAd.set(insight.adId, {
      ...previous,
      storeId: previous.storeId || insight.storeId,
      accountId: previous.accountId === insight.accountId ? previous.accountId : null,
      currency: currencies.size === 1 ? [...currencies][0]! : null,
      currencyConflict: currencies.size > 1,
      metaConversations: previous.metaConversations + insight.metaConversations,
      spend: round2(previous.spend + insight.spend),
      impressions: previous.impressions + insight.impressions,
      reach: previous.reach + insight.reach,
      clicks: previous.clicks + insight.clicks,
      inlineLinkClicks: previous.inlineLinkClicks + insight.inlineLinkClicks,
      activeDays: previous.activeDays + insight.activeDays,
      firstDate: [previous.firstDate, insight.firstDate].filter(Boolean).sort()[0] ?? null,
      lastDate: [previous.lastDate, insight.lastDate].filter(Boolean).sort().at(-1) ?? null,
      syncedAt: [previous.syncedAt, insight.syncedAt].filter(Boolean).sort().at(-1) ?? null,
    });
  }
  // One Shopify order is credited to one acquired Meta lead. If historical
  // duplication ever links it to multiple leads, use the most recent eligible
  // acquisition before the order instead of double-counting revenue.
  const ownerByOrder = new Map<string, LeadRow>();
  for (const lead of adLeads) {
    if (!lead.order_id) continue;
    const order = ordersById.get(lead.order_id);
    if (!order) continue;
    const orderAt = Date.parse(order.created_at ?? "");
    const leadAt = Date.parse(lead.first_seen_at ?? "");
    if (Number.isFinite(orderAt) && Number.isFinite(leadAt) && leadAt > orderAt) continue;
    const current = ownerByOrder.get(lead.order_id);
    const currentAt = Date.parse(current?.first_seen_at ?? "");
    if (!current || !Number.isFinite(currentAt) || (Number.isFinite(leadAt) && leadAt > currentAt)) {
      ownerByOrder.set(lead.order_id, lead);
    }
  }
  const m = new Map<string, { headline: string | null; adId: string | null; leads: LeadRow[] }>();
  for (const l of adLeads) {
    const key = l.ad_id || l.ad_headline!;
    const b = m.get(key) ?? { headline: l.ad_headline ?? null, adId: l.ad_id ?? null, leads: [] };
    if (l.ad_headline) b.headline = l.ad_headline; // keep the human headline
    if (l.ad_id) b.adId = l.ad_id; // the real Meta ad_id (distinguishes ads sharing a headline)
    b.leads.push(l);
    m.set(key, b);
  }
  for (const insight of performance) {
    if (insight.spend <= 0 && insight.impressions <= 0) continue;
    if (!m.has(insight.adId)) {
      m.set(insight.adId, { headline: null, adId: insight.adId, leads: [] });
    }
  }
  const rows = [...m.entries()].map(([adId, b]) => {
      const meta = names[adId] ?? null;
      const insight = performanceByAd.get(adId);
      const promotedProductName = meta?.promotedProductName?.trim() || null;
      const promotedSkus = [...new Set((meta?.promotedSkus ?? []).map((sku) => sku.trim().toUpperCase()).filter(Boolean))];
      const details: CampaignOrderDetail[] = [];
      const mix = new Map<string, { title: string; sku: string | null; orders: number; units: number }>();
      let ingresos = 0;
      let deliveredRevenue = 0;
      for (const lead of b.leads) {
        if (!lead.order_id) continue;
        if (ownerByOrder.get(lead.order_id) !== lead) continue;
        const order = ordersById.get(lead.order_id);
        if (!order) continue;
        const total = round2(Number(order.total_amount ?? 0) - Number(order.total_refunded ?? 0));
        const outcome = deliveryByOrder.get(lead.order_id);
        ingresos += total;
        if (campaignDeliveryBucket(outcome) === "delivered") deliveredRevenue += total;
        for (const item of order.line_items ?? []) {
          const key = `${item.sku ?? ""}|${item.title}`;
          const product = mix.get(key) ?? { title: item.title, sku: item.sku, orders: 0, units: 0 };
          product.orders += 1;
          product.units += Number(item.quantity ?? 0);
          mix.set(key, product);
        }
        const leadAt = lead.first_seen_at ? new Date(lead.first_seen_at).getTime() : NaN;
        const orderAt = order.created_at ? new Date(order.created_at).getTime() : NaN;
        details.push({
          orderId: lead.order_id,
          code: order.name,
          createdAt: order.created_at,
          customerName: lead.name,
          total,
          products: (order.line_items ?? []).map((item) => ({ title: item.title, sku: item.sku, quantity: Number(item.quantity ?? 0) })),
          match: campaignProductMatch(order, promotedProductName, promotedSkus),
          deliveryStatus: outcome?.deliveryStatus ?? null,
          statusCategory: outcome?.statusCategory ?? null,
          timeToOrderHours: Number.isFinite(leadAt) && Number.isFinite(orderAt) && orderAt >= leadAt
            ? round2((orderAt - leadAt) / 3_600_000)
            : null,
        });
      }
      const exactOrders = details.filter((order) => order.match === "exact").length;
      const mixedOrders = details.filter((order) => order.match === "mixed").length;
      const crossSellOrders = details.filter((order) => order.match === "cross_sell").length;
      const unknownProductOrders = details.filter((order) => order.match === "unknown").length;
      const knownProductOrders = exactOrders + mixedOrders + crossSellOrders;
      const deliveredOrders = details.filter((order) => campaignDeliveryBucket(deliveryByOrder.get(order.orderId)) === "delivered").length;
      const cancelledOrders = details.filter((order) => campaignDeliveryBucket(deliveryByOrder.get(order.orderId)) === "cancelled").length;
      const inRouteOrders = details.filter((order) => campaignDeliveryBucket(deliveryByOrder.get(order.orderId)) === "in_route").length;
      const shipmentKnown = details.filter((order) => !!order.deliveryStatus || !!order.statusCategory).length;
      const pedidos = details.length;
      const conversion = b.leads.length ? pedidos / b.leads.length : 0;
      const spend = round2(insight?.spend ?? 0);
      const metaConversations = Math.max(0, Math.trunc(insight?.metaConversations ?? 0));
      const impressions = insight?.impressions ?? 0;
      const reach = insight?.reach ?? 0;
      const clicks = insight?.clicks ?? 0;
      const inlineLinkClicks = insight?.inlineLinkClicks ?? 0;
      return {
        rowKey: `${insight?.storeId ?? b.leads[0]?.store_id ?? "unknown"}:${adId}`,
        adId,
        metaAdId: b.adId,
        storeIds: [...new Set(b.leads.map((lead) => lead.store_id).filter(Boolean))],
        label: meta?.adName || b.headline || adId,
        headline: b.headline,
        resolved: Boolean(meta?.adName),
        meta,
        leads: b.leads.length,
        metaConversations,
        conversationCoverageRate: metaConversations ? b.leads.length / metaConversations : null,
        pedidos,
        conversion,
        ingresos: round2(ingresos),
        promotedProductName,
        promotedSkus,
        exactOrders,
        mixedOrders,
        crossSellOrders,
        unknownProductOrders,
        productMatchRate: knownProductOrders ? (exactOrders + mixedOrders) / knownProductOrders : null,
        deliveredOrders,
        cancelledOrders,
        inRouteOrders,
        shipmentKnown,
        logisticsCoverageRate: pedidos ? shipmentKnown / pedidos : null,
        deliveryRate: shipmentKnown ? deliveredOrders / shipmentKnown : null,
        deliveredRevenue: round2(deliveredRevenue),
        revenuePerLead: b.leads.length ? round2(ingresos / b.leads.length) : 0,
        avgTicket: pedidos ? round2(ingresos / pedidos) : 0,
        metaCurrency: insight?.currency ?? null,
        spend,
        impressions,
        reach,
        clicks,
        inlineLinkClicks,
        activeDays: insight?.activeDays ?? 0,
        metaSyncedAt: insight?.syncedAt ?? null,
        currencyConflict: Boolean(insight?.currencyConflict),
        cpm: insight && insight.currency && impressions ? round2((spend / impressions) * 1_000) : null,
        frequency: insight && reach ? round2(impressions / reach) : null,
        ctr: insight && impressions ? clicks / impressions : null,
        cpc: insight?.currency && clicks ? round2(spend / clicks) : null,
        cpl: insight?.currency && b.leads.length ? round2(spend / b.leads.length) : null,
        cpa: insight?.currency && pedidos ? round2(spend / pedidos) : null,
        deliveredCpa: insight?.currency && deliveredOrders ? round2(spend / deliveredOrders) : null,
        roas: insight?.currency && spend ? round2(ingresos / spend) : null,
        deliveredRoas: insight?.currency && spend ? round2(deliveredRevenue / spend) : null,
        decision: "insufficient" as CampaignDecision,
        decisionReason: "",
        productMix: [...mix.values()].sort((a, b) => b.orders - a.orders || b.units - a.units),
        orders: details.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
      };
    });
  const totalLeads = rows.reduce((sum, row) => sum + row.leads, 0);
  const baseline = totalLeads ? rows.reduce((sum, row) => sum + row.pedidos, 0) / totalLeads : 0;
  for (const row of rows) {
    if (row.spend > 0 && row.leads === 0) {
      row.decision = "no_attribution";
      row.decisionReason = "Meta registra inversión, pero no hay leads internos vinculados al anuncio.";
    } else if (row.productMatchRate != null && row.pedidos >= 5 && row.productMatchRate < 0.5) {
      row.decision = "misaligned";
      row.decisionReason = "Menos de la mitad de los pedidos conocidos contiene el producto anunciado.";
    } else if (row.deliveryRate != null && row.shipmentKnown >= 5 && row.deliveryRate < 0.5) {
      row.decision = "operational";
      row.decisionReason = "Menos de la mitad de los pedidos con seguimiento logístico fue entregado.";
    } else if (!row.metaCurrency || row.spend <= 0 || row.currencyConflict) {
      row.decision = "data_incomplete";
      row.decisionReason = row.currencyConflict
        ? "El anuncio presenta más de una moneda; no se mezclan costos."
        : "No hay gasto histórico con moneda verificable para calcular una recomendación económica.";
    } else if (row.leads < 20) {
      row.decision = "insufficient";
      row.decisionReason = `Muestra baja: ${row.leads}/20 leads mínimos.`;
    } else if (row.deliveredOrders < 5) {
      row.decision = "insufficient";
      row.decisionReason = `Entrega aún inmadura: ${row.deliveredOrders}/5 pedidos entregados mínimos.`;
    } else if (row.conversion >= Math.max(0.15, baseline * 1.25)) {
      row.decision = "scale";
      row.decisionReason = "Conversión superior al promedio, gasto verificado y al menos cinco entregas.";
    } else if (row.conversion >= baseline) {
      row.decision = "promising";
      row.decisionReason = "Conversión igual o superior al promedio, gasto verificado y al menos cinco entregas.";
    } else {
      row.decision = "review_close";
      row.decisionReason = "Genera leads, pero convierte por debajo del promedio.";
    }
  }
  return rows.sort((a, b) => b.ingresos - a.ingresos || b.leads - a.leads);
}

export interface CampaignTrend {
  rows: Array<Record<string, string | number>>; // [{ date, [adKey]: count }] for recharts
  series: { key: string; label: string }[]; // top ads (+ "Otros"), in legend order
}

/**
 * Leads per day per Meta ad — the "tendencia por anuncio" chart. Buckets the
 * meta_ad leads by arrival day (store tz) and ad, keeps the top `topN` ads and
 * folds the rest into "Otros". Returns recharts-ready rows + series; empty when
 * there are no campaign leads.
 */
export function campaignDailyTrend(
  leads: LeadRow[],
  names: Record<string, AdMeta>,
  timeZone: string,
  topN = 5,
): CampaignTrend {
  const adLeads = leads.filter((l) => l.source === "meta_ad" && (l.ad_id || l.ad_headline));
  if (!adLeads.length) return { rows: [], series: [] };

  const keyOf = (l: LeadRow) => (l.ad_id || l.ad_headline!).replace(/\./g, "_");
  const labelByKey = new Map<string, string>();
  const totalByKey = new Map<string, number>();
  for (const l of adLeads) {
    const key = keyOf(l);
    const meta = l.ad_id ? names[l.ad_id] : undefined;
    labelByKey.set(key, prettyAdName(meta?.adName || l.ad_headline || key));
    totalByKey.set(key, (totalByKey.get(key) ?? 0) + 1);
  }
  const topKeys = [...totalByKey.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([k]) => k);
  const topSet = new Set(topKeys);
  const hasOthers = totalByKey.size > topKeys.length;

  const byDay = new Map<string, Map<string, number>>();
  for (const l of adLeads) {
    const at = l.first_seen_at ?? l.last_interaction_at;
    if (!at) continue;
    const day = tzParts(at, timeZone).date;
    const sKey = topSet.has(keyOf(l)) ? keyOf(l) : "otros";
    const dm = byDay.get(day) ?? new Map<string, number>();
    dm.set(sKey, (dm.get(sKey) ?? 0) + 1);
    byDay.set(day, dm);
  }

  const series = topKeys.map((k) => ({ key: k, label: labelByKey.get(k) ?? k }));
  if (hasOthers) series.push({ key: "otros", label: "Otros" });

  const rows = [...byDay.keys()].sort().map((day) => {
    const dm = byDay.get(day)!;
    const row: Record<string, string | number> = { date: day };
    for (const s of series) row[s.key] = dm.get(s.key) ?? 0;
    return row;
  });
  return { rows, series };
}

export interface WaNumberStat {
  phoneNumberId: string; // "" = not yet attributed
  leads: number;
  pedidos: number;
  conversion: number; // 0..1
  ingresos: number; // net revenue attributed to this number's leads
}

/**
 * Leads + conversion + revenue per WhatsApp business number, so a store running
 * several numbers (e.g. API vs Business coexistence) can compare them. Groups by
 * `wa_phone_number_id` (empty string = not yet attributed) and joins orders by
 * phone. Returns [] when no lead carries a number yet (module stays hidden).
 */
export function leadsByWaNumber(leads: LeadRow[], orders: OrderRow[]): WaNumberStat[] {
  if (!leads.some((l) => l.wa_phone_number_id)) return [];
  const netByPhone = new Map<string, number>();
  for (const o of activeOrders(orders)) {
    if (!o.customer_phone) continue;
    const net = Number(o.total_amount ?? 0) - Number(o.total_refunded ?? 0);
    netByPhone.set(o.customer_phone, (netByPhone.get(o.customer_phone) ?? 0) + net);
  }
  const m = new Map<string, { leads: number; pedidos: number; ingresos: number }>();
  for (const l of leads) {
    const key = l.wa_phone_number_id ?? "";
    const b = m.get(key) ?? { leads: 0, pedidos: 0, ingresos: 0 };
    b.leads += 1;
    if (l.has_order) {
      b.pedidos += 1;
      b.ingresos += (l.phone ? (netByPhone.get(l.phone) ?? 0) : 0);
    }
    m.set(key, b);
  }
  return [...m.entries()]
    .map(([phoneNumberId, b]) => ({
      phoneNumberId,
      leads: b.leads,
      pedidos: b.pedidos,
      conversion: b.leads ? b.pedidos / b.leads : 0,
      ingresos: round2(b.ingresos),
    }))
    .sort((a, b) => b.leads - a.leads);
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
  orders: number;
  revenue: number; // net (total_amount − refunds) of the side's active orders
}

export interface BotVsAdvisor {
  bot: ChannelFunnel;
  advisor: ChannelFunnel;
}

// An order a human advisor closed through the dashboard is tagged this way. The
// manual-sale, cart-recovery and generate-order flows ALL apply one of these
// tags AND log a lead_calls kind="sale", so the tag ⇒ "an advisor closed it".
const ADVISOR_ORDER_TAGS = new Set(["venta_manual", "carrito_recuperado"]);

/**
 * Bot-closed vs advisor-closed SALES — revenue + order count per side. An active
 * order is attributed to the ADVISOR side when a human closed it via the
 * dashboard (tagged `venta_manual`/`carrito_recuperado`); every other active
 * order arrived through the bot / Shopify sync. Revenue is net of refunds.
 */
export function botVsAdvisor(orders: OrderRow[]): BotVsAdvisor {
  const bot: ChannelFunnel = { orders: 0, revenue: 0 };
  const advisor: ChannelFunnel = { orders: 0, revenue: 0 };
  for (const o of activeOrders(orders)) {
    const net = (o.total_amount ?? 0) - (o.total_refunded ?? 0);
    const side = (o.tags ?? []).some((t) => ADVISOR_ORDER_TAGS.has(t)) ? advisor : bot;
    side.orders += 1;
    side.revenue += net;
  }
  advisor.revenue = round2(advisor.revenue);
  bot.revenue = round2(bot.revenue);
  return { bot, advisor };
}

// ===========================================================================
// Ventas por FUENTE y CIERRE — order-centric attribution (auditable).
//
// Every ACTIVE order is assigned exactly ONE acquisition source and ONE closing
// channel, so the buckets always reconcile to headline net revenue (Σ sources
// = Σ channels = total). This is the audit tool: the numbers can't silently
// double-count or drop a sale, and each order carries its assigned source +
// channel so the UI can drill down and a human can sanity-check the call.
//
// SOURCE precedence (per the product decisions):
//   winback (used a coupon AND got the recuperación-60d template ≤30d before the
//     order) ▸ pisa a la fuente original — el mensaje fue lo que lo reactivó
//   else the customer's lead source (meta_ad | cod_cart | abandoned_browse |
//     organic = tiene lead sin fuente de campaña)
//   else "sin_atribucion" (an order whose phone has no lead at all — pure web
//     checkout / histórico; surfaced on purpose so it can be investigated)
//
// CLOSING channel:
//   asesora        — closed via the dashboard (venta_manual|carrito_recuperado)
//   bot_asistido   — no dashboard tag, but an advisor logged activity on the
//                    lead within 7 días before the order (convenció por teléfono,
//                    el checkout lo hizo el cliente/bot)
//   bot            — everything else (bot/Shopify sin toque humano previo)
// ===========================================================================

export type AttributionSource =
  | "winback"
  | "meta_ad"
  | "fb_web"
  | "cod_cart"
  | "abandoned_browse"
  | "organic"
  | "sin_atribucion";

export type ClosingChannel = "asesora" | "bot_asistido" | "bot";

/** Per-phone signals for attribution, none of them range-bound (an order in the
 *  period may reference a lead/touch/send from before it). Built by lib/access. */
export interface AttributionInputs {
  /** phone → normalized lead source bucket. Absent ⇒ no lead ⇒ sin_atribucion. */
  sourceByPhone: Map<string, AttributionSource>;
  /** phone → sorted ISO timestamps of advisor actions (lead_calls, vendedora≠null). */
  advisorTouchesByPhone: Map<string, string[]>;
  /** phone → sorted ISO timestamps of successful winback template sends. */
  winbackByPhone: Map<string, string[]>;
}

export interface AttributedOrder {
  name: string | null;
  createdAt: string | null;
  net: number;
  source: AttributionSource;
  channel: ClosingChannel;
  coupons: string[];
  // NB: no customer phone here on purpose — this array is serialized to the
  // client for the drill-down, which shows only order code/date/net/channel/
  // coupon. Keeping PII (phone) out of the browser payload.
}

export interface SourceRow {
  key: AttributionSource;
  label: string;
  orders: number;
  revenue: number;
  pct: number; // share of total net revenue, 0..100
  byChannel: Record<ClosingChannel, { orders: number; revenue: number }>;
}

export interface SalesAttribution {
  total: { orders: number; revenue: number };
  sources: SourceRow[]; // revenue desc; only sources present in the period
  channels: Record<ClosingChannel, { orders: number; revenue: number }>; // marginal totals
  /** Winback "halo": orders whose phone got the template ≤30d before but were
   *  credited to another source (no coupon match). Informational — NOT added to
   *  the winback bucket, so it never steals attribution. */
  halo: { orders: number; revenue: number };
  orders: AttributedOrder[]; // every active order, attributed — the drill-down/audit feed
}

const WINBACK_ATTR_DAYS = 30; // coupon order ≤30d after the template ⇒ recuperación
const ASSIST_ATTR_DAYS = 7; // advisor touch ≤7d before the order ⇒ bot asistido

const SOURCE_LABELS: Record<AttributionSource, string> = {
  winback: "🔁 Recuperación 60d",
  meta_ad: "Meta Ads (campañas)",
  fb_web: "🌐 Meta / Web (FB·IG)",
  cod_cart: "🛒 Carrito abandonado",
  abandoned_browse: "🔎 Búsqueda abandonada",
  organic: "Orgánico (WhatsApp)",
  sin_atribucion: "Sin atribuir",
};

/** Canonical stacking/legend order for the daily chart + tables (matches the
 *  funnel narrative: paid → carts → browse → winback → organic → unknown). */
export const ATTRIBUTION_SOURCE_ORDER: AttributionSource[] = [
  "meta_ad",
  "fb_web",
  "cod_cart",
  "abandoned_browse",
  "winback",
  "organic",
  "sin_atribucion",
];

const emptyChannels = (): Record<ClosingChannel, { orders: number; revenue: number }> => ({
  asesora: { orders: 0, revenue: 0 },
  bot_asistido: { orders: 0, revenue: 0 },
  bot: { orders: 0, revenue: 0 },
});

/** Whether any timestamp in the sorted list falls within [ref − days, ref]. */
function hasEventWithin(times: string[] | undefined, refIso: string | null, days: number): boolean {
  if (!times?.length || !refIso) return false;
  const ref = new Date(refIso).getTime();
  if (!Number.isFinite(ref)) return false;
  const lo = ref - days * 86_400_000;
  for (const t of times) {
    const ms = new Date(t).getTime();
    if (Number.isFinite(ms) && ms <= ref && ms >= lo) return true;
  }
  return false;
}

/** Attribute every active order to one source + one closing channel. Pure. */
export function salesAttribution(orders: OrderRow[], inputs: AttributionInputs): SalesAttribution {
  const { sourceByPhone, advisorTouchesByPhone, winbackByPhone } = inputs;
  const attributed: AttributedOrder[] = [];
  const channels = emptyChannels();
  const bySource = new Map<AttributionSource, SourceRow>();
  let haloOrders = 0;
  let haloRevenue = 0;
  let totalRevenue = 0;

  for (const o of activeOrders(orders)) {
    const net = round2((o.total_amount ?? 0) - (o.total_refunded ?? 0));
    const phone = o.customer_phone ?? null;
    const coupons = o.discount_codes ?? [];
    const gotWinback = phone ? hasEventWithin(winbackByPhone.get(phone), o.created_at, WINBACK_ATTR_DAYS) : false;

    // Source (winback precedence): a coupon on the order AND a winback template
    // received ≤30d before ⇒ the message reactivated them.
    let source: AttributionSource;
    if (gotWinback && coupons.length > 0) {
      source = "winback";
    } else {
      source = (phone && sourceByPhone.get(phone)) || "sin_atribucion";
    }
    // Halo: influenced by the message but credited elsewhere (no coupon match).
    if (gotWinback && source !== "winback") {
      haloOrders += 1;
      haloRevenue += net;
    }

    // Closing channel.
    let channel: ClosingChannel;
    if ((o.tags ?? []).some((t) => ADVISOR_ORDER_TAGS.has(t))) {
      channel = "asesora";
    } else if (phone && hasEventWithin(advisorTouchesByPhone.get(phone), o.created_at, ASSIST_ATTR_DAYS)) {
      channel = "bot_asistido";
    } else {
      channel = "bot";
    }

    totalRevenue += net;
    channels[channel].orders += 1;
    channels[channel].revenue += net;
    const row =
      bySource.get(source) ??
      ({ key: source, label: SOURCE_LABELS[source], orders: 0, revenue: 0, pct: 0, byChannel: emptyChannels() } as SourceRow);
    row.orders += 1;
    row.revenue += net;
    row.byChannel[channel].orders += 1;
    row.byChannel[channel].revenue += net;
    bySource.set(source, row);

    attributed.push({ name: o.name, createdAt: o.created_at, net, source, channel, coupons });
  }

  totalRevenue = round2(totalRevenue);
  const sources = [...bySource.values()]
    .map((r) => {
      r.revenue = round2(r.revenue);
      r.pct = totalRevenue ? round2((r.revenue / totalRevenue) * 100) : 0;
      for (const c of Object.keys(r.byChannel) as ClosingChannel[]) r.byChannel[c].revenue = round2(r.byChannel[c].revenue);
      return r;
    })
    .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders);
  for (const c of Object.keys(channels) as ClosingChannel[]) channels[c].revenue = round2(channels[c].revenue);

  return {
    total: { orders: attributed.length, revenue: totalRevenue },
    sources,
    channels,
    halo: { orders: haloOrders, revenue: round2(haloRevenue) },
    orders: attributed,
  };
}

/** Daily net revenue stacked by source, for the tendencia chart. Buckets each
 *  attributed order by its created_at day (store tz). Returns recharts-ready
 *  rows + the present sources in canonical order. Pure. */
export function attributionDailyTrend(
  attributed: AttributedOrder[],
  timeZone: string,
): { rows: Array<Record<string, string | number>>; series: { key: AttributionSource; label: string }[] } {
  if (!attributed.length) return { rows: [], series: [] };
  const present = new Set<AttributionSource>();
  const byDay = new Map<string, Map<AttributionSource, number>>();
  for (const o of attributed) {
    if (!o.createdAt) continue;
    const day = tzParts(o.createdAt, timeZone).date;
    present.add(o.source);
    const dm = byDay.get(day) ?? new Map<AttributionSource, number>();
    dm.set(o.source, round2((dm.get(o.source) ?? 0) + o.net));
    byDay.set(day, dm);
  }
  const series = ATTRIBUTION_SOURCE_ORDER.filter((k) => present.has(k)).map((k) => ({ key: k, label: SOURCE_LABELS[k] }));
  const rows = [...byDay.keys()].sort().map((day) => {
    const dm = byDay.get(day)!;
    const row: Record<string, string | number> = { date: day };
    for (const s of series) row[s.key] = dm.get(s.key) ?? 0;
    return row;
  });
  return { rows, series };
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
