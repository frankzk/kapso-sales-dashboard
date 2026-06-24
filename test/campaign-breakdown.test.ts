import { describe, it, expect } from "vitest";
import { campaignBreakdown } from "@/lib/metrics";
import type { AdMeta } from "@/lib/meta-ads";
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

  it("upgrades the label to the real Meta ad name when resolved, else falls back", () => {
    const names: Record<string, AdMeta> = {
      "120246653255450657": {
        accountId: "1253056442078246",
        campaignId: "120246653018520657",
        campaignName: "CBO Msj | TravelersBackpack | 2306 Campaña",
        objective: "OUTCOME_ENGAGEMENT",
        adsetId: "120246653018510657",
        adsetName: "CBO Msj | TravelersBackpack | 2306 Conjunto de anuncios",
        adName: "mochila viral 31",
        status: "ACTIVE",
        fetchedAt: "2026-06-24T00:00:00Z",
      },
    };
    const rows = campaignBreakdown(leads, orders, names);

    const viaja = rows.find((r) => r.adId === "120246653255450657")!;
    expect(viaja.label).toBe("mochila viral 31"); // real ad name, not the shared headline
    expect(viaja.resolved).toBe(true);
    expect(viaja.headline).toBe("✈️ Viaja Sin Maletas"); // headline still preserved
    expect(viaja.meta?.campaignName).toBe("CBO Msj | TravelersBackpack | 2306 Campaña");
    expect(viaja.meta?.accountId).toBe("1253056442078246");

    // The other ad has no lookup entry → degrades to its headline, unresolved.
    const cocina = rows.find((r) => r.adId === "999")!;
    expect(cocina.label).toBe("🍳 Set Cocina");
    expect(cocina.resolved).toBe(false);
    expect(cocina.meta).toBeNull();
  });

  it("returns [] when there are no campaign-attributed leads", () => {
    const organic = [
      { phone: "x", source: null, ad_id: null, ad_headline: null, has_order: true },
    ] as unknown as LeadRow[];
    expect(campaignBreakdown(organic, orders)).toEqual([]);
  });
});
