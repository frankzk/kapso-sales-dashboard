import { describe, it, expect } from "vitest";
import type { ConversationRow, DailyRollupRow, OrderRow } from "@/lib/types";
import {
  salesSummary,
  salesSeriesByDay,
  salesByStore,
  comparePeriods,
  aggregateRollups,
  rollupSeries,
  funnel,
  funnelFineLink,
  businessBreakdown,
  topProducts,
  dateHourPattern,
  summarizeApiLogs,
  computeDailyRollups,
  tzParts,
} from "@/lib/metrics";

const TZ = "America/Lima"; // UTC-5, no DST — deterministic

let seq = 0;
function order(p: Partial<OrderRow> = {}): OrderRow {
  seq += 1;
  return {
    store_id: "s1",
    shopify_order_id: `o${seq}`,
    name: `#${seq}`,
    created_at: "2026-06-20T15:00:00Z",
    processed_at: null,
    updated_at: null,
    total_amount: 100,
    currency: "PEN",
    financial_status: "paid",
    tags: [],
    promo_applied: false,
    stock_por_validar: false,
    shipping_mode: null,
    kapso_conversation_id: null,
    line_items: [],
    ...p,
  };
}

function conv(p: Partial<ConversationRow> = {}): ConversationRow {
  return {
    store_id: "s1",
    kapso_conversation_id: "c" + Math.random(),
    phone_number_id: "pn1",
    started_at: "2026-06-20T15:00:00Z",
    status: "ended",
    message_count: 5,
    last_message_at: null,
    ...p,
  };
}

describe("Family 1 — Ventas", () => {
  it("salesSummary computes count/revenue/AOV", () => {
    const s = salesSummary([
      order({ total_amount: 100 }),
      order({ total_amount: 200 }),
      order({ total_amount: 50 }),
    ]);
    expect(s).toEqual({ ordersCount: 3, revenue: 350, aov: 116.67 });
  });

  it("salesSeriesByDay buckets in the store timezone", () => {
    // 02:00Z → 2026-06-19 21:00 Lima; 15:00Z → 2026-06-20 10:00 Lima
    const series = salesSeriesByDay(
      [
        order({ created_at: "2026-06-20T02:00:00Z", total_amount: 30 }),
        order({ created_at: "2026-06-20T15:00:00Z", total_amount: 70 }),
        order({ created_at: "2026-06-20T18:00:00Z", total_amount: 100 }),
      ],
      TZ,
    );
    expect(series).toEqual([
      { date: "2026-06-19", orders: 1, revenue: 30 },
      { date: "2026-06-20", orders: 2, revenue: 170 },
    ]);
  });

  it("salesByStore groups and sorts by revenue desc", () => {
    const rows = salesByStore(
      [
        order({ store_id: "s1", total_amount: 100 }),
        order({ store_id: "s2", total_amount: 300 }),
        order({ store_id: "s1", total_amount: 100 }),
      ],
      { s1: "Aurela", s2: "Otra" },
    );
    expect(rows[0]).toMatchObject({ storeId: "s2", name: "Otra", revenue: 300 });
    expect(rows[1]).toMatchObject({ storeId: "s1", ordersCount: 2, revenue: 200 });
  });

  it("comparePeriods returns signed deltas and null on zero baseline", () => {
    const cmp = comparePeriods(
      { ordersCount: 12, revenue: 1200, aov: 100 },
      { ordersCount: 10, revenue: 1000, aov: 100 },
    );
    expect(cmp.ordersDeltaPct).toBe(20);
    expect(cmp.revenueDeltaPct).toBe(20);
    expect(cmp.aovDeltaPct).toBe(0);
    expect(comparePeriods({ ordersCount: 5, revenue: 0, aov: 0 }, { ordersCount: 0, revenue: 0, aov: 0 }).ordersDeltaPct).toBeNull();
  });

  it("aggregateRollups + rollupSeries consolidate across stores", () => {
    const rollups: DailyRollupRow[] = [
      rollup({ store_id: "s1", date: "2026-06-20", orders_count: 2, revenue: 200, conversations_count: 8 }),
      rollup({ store_id: "s2", date: "2026-06-20", orders_count: 1, revenue: 100, conversations_count: 2 }),
      rollup({ store_id: "s1", date: "2026-06-21", orders_count: 3, revenue: 600, conversations_count: 10 }),
    ];
    const totals = aggregateRollups(rollups);
    expect(totals.ordersCount).toBe(6);
    expect(totals.revenue).toBe(900);
    expect(totals.aov).toBe(150);
    expect(totals.conversationsCount).toBe(20);
    expect(totals.conversionRate).toBe(0.3); // 6/20

    const series = rollupSeries(rollups);
    expect(series).toHaveLength(2);
    expect(series[0]).toMatchObject({ date: "2026-06-20", orders: 3, revenue: 300, conversations: 10, conversionRate: 0.3 });
  });
});

function rollup(p: Partial<DailyRollupRow>): DailyRollupRow {
  return {
    store_id: "s1",
    date: "2026-06-20",
    orders_count: 0,
    revenue: 0,
    aov: 0,
    conversations_count: 0,
    conversion_rate: 0,
    promo_orders: 0,
    stock_validar_orders: 0,
    cod_orders: 0,
    agency_orders: 0,
    ...p,
  };
}

describe("Family 2 — Embudo / conversión", () => {
  it("funnel = orders / conversations", () => {
    const f = funnel(
      [order(), order(), order()],
      Array.from({ length: 10 }, () => conv()),
    );
    expect(f).toEqual({ conversations: 10, orders: 3, conversionRate: 0.3 });
  });

  it("funnelFineLink matches on kapso_conversation_id", () => {
    const conversations = [
      conv({ kapso_conversation_id: "k1" }),
      conv({ kapso_conversation_id: "k2" }),
      conv({ kapso_conversation_id: "k3" }),
    ];
    const orders = [
      order({ kapso_conversation_id: "k1" }), // matched
      order({ kapso_conversation_id: "k2" }), // matched
      order({ kapso_conversation_id: "k9" }), // has id, no conversation
      order({ kapso_conversation_id: null }), // orphan
    ];
    expect(funnelFineLink(orders, conversations)).toEqual({
      ordersWithConversationId: 3,
      matchedOrders: 2,
      matchedConversations: 2,
      unmatchedOrders: 1,
      orphanOrders: 1,
    });
  });
});

describe("Family 3 — Desglose de negocio", () => {
  it("businessBreakdown counts promo/stock/cod/agency", () => {
    const b = businessBreakdown([
      order({ promo_applied: true, shipping_mode: "cod" }),
      order({ promo_applied: true, stock_por_validar: true, shipping_mode: "agency" }),
      order({ shipping_mode: "cod" }),
      order({ shipping_mode: null }),
    ]);
    expect(b).toMatchObject({
      total: 4,
      promoOrders: 2,
      promoPct: 50,
      stockValidarOrders: 1,
      codOrders: 2,
      agencyOrders: 1,
      otherShippingOrders: 1,
    });
  });

  it("topProducts aggregates line_items by sku", () => {
    const tp = topProducts([
      order({
        line_items: [
          { title: "Polo", sku: "POLO", quantity: 2, price: 50, product_id: null, variant_id: null },
          { title: "Gorro", sku: "GORRO", quantity: 1, price: 30, product_id: null, variant_id: null },
        ],
      }),
      order({
        line_items: [
          { title: "Polo", sku: "POLO", quantity: 3, price: 50, product_id: null, variant_id: null },
        ],
      }),
    ]);
    expect(tp[0]).toMatchObject({ key: "POLO", quantity: 5, revenue: 250, orders: 2 });
    expect(tp[1]).toMatchObject({ key: "GORRO", quantity: 1, revenue: 30, orders: 1 });
  });

  it("dateHourPattern finds the peak slot (store tz)", () => {
    const orders = [
      order({ created_at: "2026-06-20T15:00:00Z" }), // Sat 10:00 Lima
      order({ created_at: "2026-06-20T15:30:00Z" }), // Sat 10:00 Lima
      order({ created_at: "2026-06-20T20:00:00Z" }), // Sat 15:00 Lima
    ];
    const p = dateHourPattern(orders, TZ);
    expect(p.peak).toEqual({ weekday: 6, hour: 10, count: 2 });
    expect(p.byHour[10]).toBe(2);
    expect(p.byWeekday[6]).toBe(3);
  });
});

describe("Family 4 — Operativo", () => {
  it("summarizeApiLogs computes error rate + latency", () => {
    const s = summarizeApiLogs([
      { status_code: 200, duration_ms: 100 },
      { status_code: 500, duration_ms: 300 },
      { status_code: 200, duration_ms: 200 },
      { status_code: 429, duration_ms: 400 },
    ]);
    expect(s.total).toBe(4);
    expect(s.errors).toBe(2);
    expect(s.errorRate).toBe(0.5);
    expect(s.avgLatencyMs).toBe(250);
    expect(s.p95LatencyMs).toBe(400);
  });
});

describe("computeDailyRollups (mirrors the SQL recompute)", () => {
  it("buckets orders + conversations by store-tz date with conversion_rate", () => {
    const orders = [
      order({ created_at: "2026-06-20T15:00:00Z", total_amount: 100, promo_applied: true, shipping_mode: "cod" }),
      order({ created_at: "2026-06-20T16:00:00Z", total_amount: 300, shipping_mode: "agency" }),
    ];
    const conversations = [
      conv({ started_at: "2026-06-20T15:00:00Z" }),
      conv({ started_at: "2026-06-20T16:00:00Z" }),
      conv({ started_at: "2026-06-20T17:00:00Z" }),
      conv({ started_at: "2026-06-20T18:00:00Z" }),
    ];
    const rows = computeDailyRollups("s1", orders, conversations, TZ);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      store_id: "s1",
      date: "2026-06-20",
      orders_count: 2,
      revenue: 400,
      aov: 200,
      conversations_count: 4,
      conversion_rate: 0.5,
      promo_orders: 1,
      cod_orders: 1,
      agency_orders: 1,
    });
  });
});

describe("tzParts", () => {
  it("returns date/hour/weekday for an instant in a timezone", () => {
    expect(tzParts("2026-06-20T15:00:00Z", TZ)).toEqual({ date: "2026-06-20", hour: 10, weekday: 6 });
    // crosses midnight backwards
    expect(tzParts("2026-06-20T02:00:00Z", TZ)).toEqual({ date: "2026-06-19", hour: 21, weekday: 5 });
  });
});
