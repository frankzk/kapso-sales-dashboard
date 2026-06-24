import { describe, it, expect } from "vitest";
import { sourceBreakdown } from "@/lib/metrics";
import type { LeadRow, OrderRow } from "@/lib/types";

const orders = [
  { customer_phone: "51920582451", total_amount: 219, total_refunded: 0, cancelled_at: null },
  { customer_phone: "51999999999", total_amount: 99, total_refunded: 0, cancelled_at: null },
  { customer_phone: "51900000000", total_amount: 500, total_refunded: 0, cancelled_at: "2026-06-20" }, // cancelled → ignored
] as unknown as OrderRow[];

const leads = [
  { phone: "51920582451", source: "meta_ad", has_order: true }, // Jeannette — ad → won (S/219)
  { phone: "51911111111", source: "meta_ad", has_order: false }, // ad → not won
  { phone: "51999999999", source: null, has_order: true }, // organic → won (S/99)
  { phone: "51922222222", source: null, has_order: false }, // organic → not won
] as unknown as LeadRow[];

describe("sourceBreakdown (per-source conversion)", () => {
  it("splits Meta Ads vs organic with conversion and net revenue", () => {
    const stats = sourceBreakdown(leads, orders);
    expect(stats).toHaveLength(2);

    const ad = stats.find((s) => s.key === "meta_ad")!;
    expect(ad).toMatchObject({ leads: 2, pedidos: 1, ingresos: 219 });
    expect(ad.conversion).toBeCloseTo(0.5);

    const org = stats.find((s) => s.key === "organic")!;
    expect(org).toMatchObject({ leads: 2, pedidos: 1, ingresos: 99 });
    expect(org.conversion).toBeCloseTo(0.5);

    // sorted by revenue desc → Meta Ads first
    expect(stats[0]!.key).toBe("meta_ad");
  });

  it("returns [] when no lead has a source yet (module stays hidden)", () => {
    const noSource = [{ phone: "x", source: null, has_order: false }] as unknown as LeadRow[];
    expect(sourceBreakdown(noSource, orders)).toEqual([]);
  });
});
