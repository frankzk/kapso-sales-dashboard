import { describe, expect, it } from "vitest";
import {
  fetchMetaDailyInsights,
  metaInsightsRange,
  normalizeMetaDailyInsight,
  splitMetaInsightsRange,
} from "@/lib/meta-insights-sync";

describe("normalizeMetaDailyInsight", () => {
  it("normalizes numeric strings and preserves action breakdowns", () => {
    expect(
      normalizeMetaDailyInsight({
        account_id: "act_123",
        account_name: "Kenku Ads",
        account_currency: "PEN",
        date_start: "2026-07-27",
        ad_id: "999",
        ad_name: "Semilla negra",
        spend: "42.50",
        impressions: "1200",
        reach: "900",
        frequency: "1.333",
        clicks: "30",
        inline_link_clicks: "21",
        ctr: "2.5",
        cpm: "35.416",
        cpc: "1.416",
        actions: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "8" }],
      }),
    ).toMatchObject({
      account_id: "123",
      date: "2026-07-27",
      ad_id: "999",
      spend: 42.5,
      impressions: 1200,
      reach: 900,
      clicks: 30,
      inline_link_clicks: 21,
    });
  });

  it("drops rows that cannot form the composite key", () => {
    expect(normalizeMetaDailyInsight({ account_id: "1", date_start: "2026-07-27" })).toBeNull();
    expect(normalizeMetaDailyInsight({ ad_id: "2", date_start: "2026-07-27" })).toBeNull();
  });
});

describe("fetchMetaDailyInsights", () => {
  it("requests daily ad-level data and follows pagination", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return {
        ok: true,
        status: 200,
        json: async () =>
          seen.length === 1
            ? {
                data: [{ account_id: "1", date_start: "2026-07-26", ad_id: "a", spend: "10" }],
                paging: { next: "https://graph.test/page-2" },
              }
            : { data: [{ account_id: "1", date_start: "2026-07-27", ad_id: "a", spend: "12" }] },
      };
    }) as unknown as typeof fetch;

    const result = await fetchMetaDailyInsights(
      "TOKEN",
      "act_1",
      { from: "2026-07-26", to: "2026-07-27" },
      { baseUrl: "https://graph.test/v21.0", fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(result.rows.map((row) => row.spend)).toEqual([10, 12]);
    const first = new URL(seen[0]!);
    expect(first.pathname).toContain("/act_1/insights");
    expect(first.searchParams.get("level")).toBe("ad");
    expect(first.searchParams.get("time_increment")).toBe("1");
    expect(seen[1]).toBe("https://graph.test/page-2");
  });

  it("isolates Meta API errors", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "Missing ads_read" } }),
    })) as unknown as typeof fetch;
    const result = await fetchMetaDailyInsights(
      "TOKEN",
      "1",
      { from: "2026-07-01", to: "2026-07-02" },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ads_read");
  });
});

describe("metaInsightsRange", () => {
  it("returns 90 inclusive Lima calendar days", () => {
    expect(metaInsightsRange(90, new Date("2026-07-28T18:00:00Z"))).toEqual({
      from: "2026-04-30",
      to: "2026-07-28",
    });
  });

  it("splits a 90-day backfill into bounded inclusive chunks", () => {
    expect(splitMetaInsightsRange({ from: "2026-04-30", to: "2026-07-28" })).toEqual([
      { from: "2026-04-30", to: "2026-05-29" },
      { from: "2026-05-30", to: "2026-06-28" },
      { from: "2026-06-29", to: "2026-07-28" },
    ]);
  });
});
