import { describe, it, expect } from "vitest";
import { campaignBreakdown, campaignDailyTrend } from "@/lib/metrics";
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

  it("keeps two ads that SHARE a headline as separate rows, distinguishable by metaAdId", () => {
    // The reported case: two distinct ad_ids with the same CTWA headline ("Madera
    // Como Nueva"). They must stay ad-level (2 rows), told apart by the real ad_id.
    const mixed = [
      { phone: "a", source: "meta_ad", ad_id: "111", ad_headline: "Madera Como Nueva", has_order: false },
      { phone: "b", source: "meta_ad", ad_id: "222", ad_headline: "Madera Como Nueva", has_order: false },
      { phone: "c", source: "meta_ad", ad_id: null, ad_headline: "Madera Como Nueva", has_order: false }, // Meta sent no ad_id
    ] as unknown as LeadRow[];
    const rows = campaignBreakdown(mixed, orders);
    expect(rows).toHaveLength(3); // two ads + the headline-only group — NOT collapsed into one
    expect(rows.find((r) => r.adId === "111")!.metaAdId).toBe("111");
    expect(rows.find((r) => r.adId === "222")!.metaAdId).toBe("222");
    expect(rows.find((r) => r.adId === "Madera Como Nueva")!.metaAdId).toBeNull(); // "sin ad id"
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

  it("campaignDailyTrend buckets leads per day per ad (store tz)", () => {
    const trendLeads = [
      { phone: "1", source: "meta_ad", ad_id: "A", ad_headline: "H", first_seen_at: "2026-06-24T10:00:00Z" },
      { phone: "2", source: "meta_ad", ad_id: "A", ad_headline: "H", first_seen_at: "2026-06-25T10:00:00Z" },
      { phone: "3", source: "meta_ad", ad_id: "B", ad_headline: "H2", first_seen_at: "2026-06-25T10:00:00Z" },
    ] as unknown as LeadRow[];
    const t = campaignDailyTrend(trendLeads, {}, "UTC");
    expect(t.rows.map((r) => r.date)).toEqual(["2026-06-24", "2026-06-25"]);
    expect(t.series.map((s) => s.key)).toEqual(["A", "B"]); // A (2 leads) before B (1)
    const d25 = t.rows.find((r) => r.date === "2026-06-25")!;
    expect(d25["A"]).toBe(1);
    expect(d25["B"]).toBe(1);
    expect(t.rows.find((r) => r.date === "2026-06-24")!["B"]).toBe(0);
  });

  it("returns [] when there are no campaign-attributed leads", () => {
    const organic = [
      { phone: "x", source: null, ad_id: null, ad_headline: null, has_order: true },
    ] as unknown as LeadRow[];
    expect(campaignBreakdown(organic, orders)).toEqual([]);
  });
});
