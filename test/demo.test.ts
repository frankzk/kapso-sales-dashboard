import { describe, it, expect } from "vitest";
import { generateDemoData } from "@/lib/demo";
import {
  businessBreakdown,
  computeDailyRollups,
  funnel,
  funnelFineLink,
  salesSummary,
  topProducts,
} from "@/lib/metrics";

describe("generateDemoData", () => {
  const { orders, conversations } = generateDemoData({ storeId: "demo", days: 30, seed: 7 });

  it("produces linked, non-trivial data", () => {
    expect(orders.length).toBeGreaterThan(0);
    expect(conversations.length).toBeGreaterThan(orders.length);
  });

  it("every order links to an existing conversation (fine link is clean)", () => {
    const ids = new Set(conversations.map((c) => c.kapso_conversation_id));
    for (const o of orders) {
      expect(o.kapso_conversation_id).toBeTruthy();
      expect(ids.has(o.kapso_conversation_id!)).toBe(true);
    }
    const fine = funnelFineLink(orders, conversations);
    expect(fine.unmatchedOrders).toBe(0);
    expect(fine.orphanOrders).toBe(0);
    expect(fine.matchedOrders).toBe(orders.length);
  });

  it("yields sane metrics across the families", () => {
    const f = funnel(orders, conversations);
    expect(f.conversionRate).toBeGreaterThan(0);
    expect(f.conversionRate).toBeLessThan(1);

    const s = salesSummary(orders);
    expect(s.revenue).toBeGreaterThan(0);
    expect(s.aov).toBeGreaterThan(0);

    const b = businessBreakdown(orders);
    expect(b.total).toBe(orders.length);
    expect(b.codOrders + b.agencyOrders).toBe(orders.length); // demo always sets a mode
    expect(topProducts(orders).length).toBeGreaterThan(0);

    const rollups = computeDailyRollups("demo", orders, conversations, "America/Lima");
    expect(rollups.length).toBeGreaterThan(0);
    expect(rollups.reduce((a, r) => a + r.orders_count, 0)).toBe(orders.length);
  });

  it("is deterministic for a fixed seed", () => {
    const a = generateDemoData({ storeId: "demo", days: 10, seed: 1 });
    const b = generateDemoData({ storeId: "demo", days: 10, seed: 1 });
    expect(a.orders.length).toBe(b.orders.length);
    expect(a.orders[0]?.total_amount).toBe(b.orders[0]?.total_amount);
  });
});
