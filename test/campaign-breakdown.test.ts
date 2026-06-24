import { describe, it, expect } from "vitest";
import { campaignBreakdown } from "@/lib/metrics";
import type { LeadRow, OrderRow } from "@/lib/types";

const orders = [
  { customer_phone: "51920582451", total_amount: 219, total_refunded: 0, cancelled_at: null },
  { customer_phone: "51933333333", total_amount: 99, total_refunded: 0, cancelled_at: null },
] as unknown as OrderRow[];

const leads = [
  { phone: "51920582451", source: "meta_ad", ad_id: "120246653255450657", ad_headline: "✈️ Viaja Sin Maletas", has_order: true },
  { phone: "51911111111", source: "meta_ad", ad_id: "120246653255450657", ad_headline: "✈️ Viaja Sin Maletas", has_order: false },
  { phone: "51933333333", source: "meta_ad", ad_id: "999", ad_headline: "🍳 Set Cocina", has_order: true },
  { phone: "51944444444", source: null, ad_id: null, ad_headline: null, has_order: true }, // organic — excluded
] as unknown as LeadRow[];

describe("campaignBreakdown (revenue half of ROAS)", () => {
  it("groups meta_ad leads by ad and attributes revenue by phone", () => {
    const rows = campaignBreakdown(leads, orders);
    expect(rows).toHaveLength(2);
    const viaja = rows.find((r) => r.adId === "120246653255450657")!;
    expect(viaja).toMatchObject({ label: "✈️ Viaja Sin Maletas", leads: 2, pedidos: 1, ingresos: 219 });
    expect(viaja.conversion).toBeCloseTo(0.5);
    expect(rows[0]!.adId).toBe("120246653255450657"); // sorted by revenue desc
  });

  it("returns [] when there are no campaign-attributed leads", () => {
    const organic = [
      { phone: "x", source: null, ad_id: null, ad_headline: null, has_order: true },
    ] as unknown as LeadRow[];
    expect(campaignBreakdown(organic, orders)).toEqual([]);
  });
});
