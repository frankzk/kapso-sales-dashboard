import { describe, it, expect } from "vitest";
import type { ConversationRow, DailyRollupRow, LeadRow, OrderRow } from "@/lib/types";
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
  lossReasons,
  lostRevenueByReason,
  botVsAdvisor,
  conversationalFunnel,
  funnelHealth,
  formatDuration,
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
    cancelled_at: null,
    total_refunded: 0,
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
    inbound_count: 0,
    first_response_seconds: null,
    ...p,
  };
}

let leadSeq = 0;
function lead(p: Partial<LeadRow> = {}): LeadRow {
  leadSeq += 1;
  return {
    id: `l${leadSeq}`,
    store_id: "s1",
    phone: `51900000${leadSeq}`,
    wa_id: null,
    name: null,
    email: null,
    first_seen_at: "2026-06-20T15:00:00Z",
    last_interaction_at: "2026-06-20T15:00:00Z",
    kapso_conversation_id: null,
    bot_compra_state: null,
    handoff_reason: null,
    handoff_context: null,
    handoff_at: null,
    category: "open",
    status: "nuevo",
    needs_attention: false,
    order_id: null,
    has_order: false,
    claimed_by: null,
    claimed_at: null,
    closed_by: null,
    next_followup_at: null,
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

  it("salesSummary nets refunds and excludes cancelled orders", () => {
    const s = salesSummary([
      order({ total_amount: 200, total_refunded: 50 }), // net 150
      order({ total_amount: 100 }), // net 100
      order({ total_amount: 999, cancelled_at: "2026-06-20T16:00:00Z" }), // excluded
    ]);
    expect(s).toEqual({ ordersCount: 2, revenue: 250, aov: 125 });
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

  it("aggregateRollups averages first-response from sum/samples", () => {
    const totals = aggregateRollups([
      rollup({ inbound_messages: 10, response_seconds_sum: 100, response_samples: 2 }),
      rollup({ inbound_messages: 5, response_seconds_sum: 50, response_samples: 3 }),
    ]);
    expect(totals.inboundMessages).toBe(15);
    expect(totals.avgFirstResponseSeconds).toBe(30); // (100+50)/(2+3)
  });

  it("aggregateRollups returns null avg response when no samples", () => {
    const totals = aggregateRollups([rollup({ inbound_messages: 4 })]);
    expect(totals.inboundMessages).toBe(4);
    expect(totals.avgFirstResponseSeconds).toBeNull();
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
    cancelled_orders: 0,
    refunded_amount: 0,
    inbound_messages: 0,
    response_seconds_sum: 0,
    response_samples: 0,
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

  it("businessBreakdown excludes cancelled orders and sums refunds", () => {
    const b = businessBreakdown([
      order({ shipping_mode: "cod", total_refunded: 20 }),
      order({ shipping_mode: "agency", cancelled_at: "2026-06-20T18:00:00Z" }),
    ]);
    expect(b.total).toBe(1);
    expect(b.cancelledOrders).toBe(1);
    expect(b.refundedAmount).toBe(20);
    expect(b.codOrders).toBe(1);
    expect(b.agencyOrders).toBe(0); // cancelled agency order excluded
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
    expect(s.p50LatencyMs).toBe(200);
    expect(s.p95LatencyMs).toBe(400);
  });

  it("summarizeApiLogs tolerates alternate field names + nested timing", () => {
    const s = summarizeApiLogs([
      { status: "200", response_time_ms: 50 },
      { response_status: 503, latency: "150" }, // error + string latency
      { code: 200, timing: { duration_ms: 100 } }, // nested latency
    ]);
    expect(s.total).toBe(3);
    expect(s.errors).toBe(1);
    expect(s.avgLatencyMs).toBe(100); // (50+150+100)/3
  });
});

describe("computeDailyRollups (mirrors the SQL recompute)", () => {
  it("buckets orders + conversations by store-tz date with conversion_rate", () => {
    const orders = [
      order({ created_at: "2026-06-20T15:00:00Z", total_amount: 100, promo_applied: true, shipping_mode: "cod" }),
      order({ created_at: "2026-06-20T16:00:00Z", total_amount: 300, shipping_mode: "agency" }),
    ];
    const conversations = [
      conv({ started_at: "2026-06-20T15:00:00Z", inbound_count: 3, first_response_seconds: 30 }),
      conv({ started_at: "2026-06-20T16:00:00Z", inbound_count: 2, first_response_seconds: 90 }),
      conv({ started_at: "2026-06-20T17:00:00Z", inbound_count: 5, first_response_seconds: null }),
      conv({ started_at: "2026-06-20T18:00:00Z", inbound_count: 1, first_response_seconds: 60 }),
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
      inbound_messages: 11, // 3+2+5+1
      response_seconds_sum: 180, // 30+90+60 (null excluded)
      response_samples: 3,
    });
  });

  it("nets refunds and counts cancellations separately", () => {
    const orders = [
      order({ created_at: "2026-06-20T15:00:00Z", total_amount: 200, total_refunded: 50, shipping_mode: "cod" }),
      order({ created_at: "2026-06-20T16:00:00Z", total_amount: 100, shipping_mode: "agency" }),
      order({ created_at: "2026-06-20T17:00:00Z", total_amount: 300, cancelled_at: "2026-06-20T18:00:00Z", shipping_mode: "cod" }),
    ];
    const rows = computeDailyRollups("s1", orders, [], "America/Lima");
    expect(rows[0]).toMatchObject({
      orders_count: 2,
      revenue: 250, // (200-50) + 100
      refunded_amount: 50,
      cancelled_orders: 1,
      cod_orders: 1, // the cancelled COD order is excluded
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

describe("Family 5 — Leads-derived", () => {
  it("lossReasons buckets non-buying leads and excludes won/hot", () => {
    const result = lossReasons([
      lead({ status: "nuevo" }),
      lead({ status: "nuevo" }),
      lead({ status: "nuevo" }),
      lead({ status: "no_responde" }),
      lead({ status: "ya_compro_otro_lado", category: "lost" }),
      lead({ status: "sin_stock", category: "lost" }),
      lead({ status: "solo_informacion", category: "lost" }),
      lead({ status: "pedido_generado", category: "won", has_order: true }), // excluded
      lead({ status: "yape_por_verificar", category: "hot" }), // excluded
    ]);
    expect(result.total).toBe(7);
    const byBucket = Object.fromEntries(result.reasons.map((r) => [r.bucket, r.count]));
    expect(byBucket).toEqual({ no_respondio: 4, compro_otro_lado: 1, sin_stock: 1, solo_info: 1 });
    expect(result.reasons[0]!.bucket).toBe("no_respondio");
    expect(result.reasons[0]!.pct).toBe(57.14);
  });

  it("lostRevenueByReason estimates count × AOV", () => {
    const loss = lossReasons([
      lead({ status: "nuevo" }),
      lead({ status: "nuevo" }),
      lead({ status: "sin_stock", category: "lost" }),
    ]);
    const lr = lostRevenueByReason(loss, 100);
    expect(lr.total).toBe(300);
    expect(Object.fromEntries(lr.items.map((i) => [i.bucket, i.estRevenue]))).toEqual({
      no_respondio: 200,
      sin_stock: 100,
    });
  });

  it("botVsAdvisor splits by handoff and counts orders", () => {
    const bva = botVsAdvisor([
      lead({ handoff_at: null, has_order: true }),
      lead({ handoff_at: null, has_order: false }),
      lead({ handoff_at: "2026-06-20T16:00:00Z", has_order: true }),
      lead({ handoff_at: "2026-06-20T16:00:00Z", has_order: false }),
    ]);
    expect(bva.bot).toEqual({ leads: 2, orders: 1, conversionRate: 0.5 });
    expect(bva.advisor).toEqual({ leads: 2, orders: 1, conversionRate: 0.5 });
  });

  it("conversationalFunnel builds 6 monotonic stages with step %", () => {
    const stages = conversationalFunnel({
      conversations: [conv(), conv(), conv(), conv()], // 4 convs × 5 msgs = 20 inbound proxy
      leads: [
        lead({ category: "won", has_order: true }),
        lead({ status: "casi_cierra", category: "hot" }),
        lead({ status: "otros_productos" }),
        lead({ status: "nuevo" }),
      ],
      orders: [order()],
    });
    expect(stages.map((s) => s.key)).toEqual([
      "mensajes",
      "conversaciones",
      "interesados",
      "datos",
      "compromiso",
      "pedidos",
    ]);
    expect(stages.map((s) => s.value)).toEqual([20, 4, 3, 2, 1, 1]);
    expect(stages[0]!.stepPct).toBeNull();
    expect(stages[1]!.stepPct).toBe(0.2);
    expect(stages[2]!.stepPct).toBe(0.75);
    expect(stages[4]!.stepPct).toBe(0.5);
  });

  it("conversationalFunnel honors an explicit inboundMessages override", () => {
    const stages = conversationalFunnel({
      conversations: [conv()],
      leads: [],
      orders: [],
      inboundMessages: 99,
    });
    expect(stages[0]!.value).toBe(99);
  });

  it("funnelHealth flags step thresholds + the worst step", () => {
    const h = funnelHealth([
      { key: "a", label: "A", value: 100, stepPct: null },
      { key: "b", label: "B", value: 80, stepPct: 0.8 },
      { key: "c", label: "C", value: 40, stepPct: 0.5 },
      { key: "d", label: "D", value: 8, stepPct: 0.2 },
    ]);
    expect(h.stages.map((s) => s.status)).toEqual(["green", "green", "amber", "red"]);
    expect(h.critical?.key).toBe("d");
  });
});

describe("formatDuration", () => {
  it("formats seconds into a human duration", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(72)).toBe("1m 12s");
    expect(formatDuration(120)).toBe("2m");
    expect(formatDuration(3660)).toBe("1h 1m");
    expect(formatDuration(null)).toBe("—");
  });
});
