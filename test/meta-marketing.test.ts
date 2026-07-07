import { describe, it, expect } from "vitest";
import { fetchMetaAdMeta, fetchMetaSpend, listMetaAdAccounts, normalizeMetaAdAccounts } from "@/lib/meta-marketing";

function fakeFetch(status: number, json: unknown, capture?: (url: string) => void) {
  return (async (url: string) => {
    capture?.(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    };
  }) as unknown as typeof fetch;
}

describe("listMetaAdAccounts", () => {
  it("requests /me/adaccounts with the token and parses the accounts", async () => {
    let seen = "";
    const res = await listMetaAdAccounts("TOK123", {
      baseUrl: "https://graph.test/v21.0",
      fetchImpl: fakeFetch(
        200,
        {
          data: [
            { id: "act_111", account_id: "111", name: "Aurela Ads", currency: "PEN", account_status: 1 },
            { id: "act_222", account_id: "222", name: "Kenku Ads", currency: "PEN", account_status: 1 },
          ],
        },
        (u) => (seen = u),
      ),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.accounts).toHaveLength(2);
      expect(res.accounts[0]).toMatchObject({ id: "act_111", accountId: "111", name: "Aurela Ads", currency: "PEN" });
    }
    expect(seen).toContain("/me/adaccounts");
    expect(new URL(seen).searchParams.get("access_token")).toBe("TOK123");
    expect(new URL(seen).searchParams.get("fields")).toContain("account_status");
  });

  it("surfaces a Meta API error (invalid token) without throwing", async () => {
    const res = await listMetaAdAccounts("bad", {
      fetchImpl: fakeFetch(400, { error: { message: "Invalid OAuth access token." } }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Invalid OAuth");
  });

  it("returns not-ok for an empty token (no request)", async () => {
    let called = false;
    const res = await listMetaAdAccounts("", { fetchImpl: fakeFetch(200, {}, () => (called = true)) });
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe("normalizeMetaAdAccounts (multi-account, with back-compat)", () => {
  it("parses + dedupes the jsonb array of {id,name}", () => {
    const out = normalizeMetaAdAccounts([
      { id: "act_1", name: "Aurela" },
      { id: "act_2", name: "Kenku" },
      { id: "act_1", name: "dup" }, // dropped
      { id: "  ", name: "blank" }, // dropped
    ]);
    expect(out).toEqual([
      { id: "act_1", name: "Aurela" },
      { id: "act_2", name: "Kenku" },
    ]);
  });

  it("falls back to the legacy single id/name when the array is empty", () => {
    expect(normalizeMetaAdAccounts([], "act_9", "Legacy")).toEqual([{ id: "act_9", name: "Legacy" }]);
    expect(normalizeMetaAdAccounts(null, "act_9", null)).toEqual([{ id: "act_9", name: null }]);
  });

  it("returns [] for garbage / nothing set", () => {
    expect(normalizeMetaAdAccounts(undefined)).toEqual([]);
    expect(normalizeMetaAdAccounts("nope")).toEqual([]);
    expect(normalizeMetaAdAccounts([{ name: "no id" }])).toEqual([]);
  });
});

describe("fetchMetaSpend", () => {
  function spendFetch(byAccount: Record<string, number>, capture?: (url: string) => void) {
    return (async (url: string) => {
      capture?.(url);
      const act = /act_([^/]+)\/insights/.exec(url)?.[1] ?? "";
      const spend = byAccount[act];
      return {
        ok: spend !== undefined,
        status: spend !== undefined ? 200 : 400,
        json: async () => (spend !== undefined ? { data: [{ spend: String(spend) }] } : { error: { message: "bad" } }),
      };
    }) as unknown as typeof fetch;
  }

  it("sums spend across accounts for the range", async () => {
    const seen: string[] = [];
    const total = await fetchMetaSpend("TOK", ["act_111", "222"], { from: "2026-07-01", to: "2026-07-06" }, {
      baseUrl: "https://graph.test/v21.0",
      fetchImpl: spendFetch({ "111": 120.5, "222": 80 }, (u) => seen.push(u)),
    });
    expect(total).toBe(200.5);
    expect(seen[0]).toContain("act_111/insights");
    expect(seen[0]).toContain("time_range=");
    expect(seen[1]).toContain("act_222/insights"); // bare id gets act_ prefix
  });

  it("returns null when no accounts or no token", async () => {
    expect(await fetchMetaSpend("", ["act_1"], { from: "a", to: "b" })).toBeNull();
    expect(await fetchMetaSpend("T", [], { from: "a", to: "b" })).toBeNull();
  });

  it("returns null when every account errors, but sums the ok ones otherwise", async () => {
    const allBad = await fetchMetaSpend("T", ["act_9"], { from: "a", to: "b" }, {
      baseUrl: "https://graph.test/v21.0",
      fetchImpl: spendFetch({}),
    });
    expect(allBad).toBeNull();
    const partial = await fetchMetaSpend("T", ["act_1", "act_2"], { from: "a", to: "b" }, {
      baseUrl: "https://graph.test/v21.0",
      fetchImpl: spendFetch({ "1": 50 }), // act_2 errors → counts as 0, not null
    });
    expect(partial).toBe(50);
  });
});

describe("fetchMetaAdMeta", () => {
  function adFetch(byId: Record<string, any>, capture?: (url: string) => void) {
    return (async (url: string) => {
      capture?.(url);
      const id = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
      const a = byId[id];
      const ok = a !== undefined && !a?.error;
      return { ok, status: ok ? 200 : 400, json: async () => a ?? { error: { message: "not found" } } };
    }) as unknown as typeof fetch;
  }

  it("resolves ad_ids to real ad / adset / campaign names", async () => {
    const seen: string[] = [];
    const rows = await fetchMetaAdMeta("TOK", ["111", "222"], {
      baseUrl: "https://graph.test/v21.0",
      fetchImpl: adFetch(
        {
          "111": {
            name: "mochila viral 81 9:16",
            effective_status: "ACTIVE",
            account_id: "act_999",
            adset: { id: "as1", name: "Conjunto A" },
            campaign: { id: "c1", name: "CBO Nail", objective: "OUTCOME_ENGAGEMENT" },
          },
          "222": { name: "Madera 3", effective_status: "PAUSED", account_id: "999", campaign: { id: "c1", name: "CBO Nail" } },
        },
        (u) => seen.push(u),
      ),
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.ad_id === "111")).toMatchObject({
      ad_name: "mochila viral 81 9:16",
      status: "ACTIVE",
      account_id: "999", // act_ prefix stripped
      adset_id: "as1",
      adset_name: "Conjunto A",
      campaign_name: "CBO Nail",
      objective: "OUTCOME_ENGAGEMENT",
    });
    expect(rows.find((r) => r.ad_id === "222")!.adset_id).toBeNull(); // no adset in the response
    expect(seen[0]).toContain("/v21.0/111?");
    expect(seen[0]).toContain("access_token=TOK");
  });

  it("omits ids that error (deleted / no access) without throwing", async () => {
    const rows = await fetchMetaAdMeta("TOK", ["ok", "bad"], {
      baseUrl: "https://graph.test/v21.0",
      fetchImpl: adFetch({ ok: { name: "Anuncio", account_id: "1" } }), // "bad" absent → 400
    });
    expect(rows.map((r) => r.ad_id)).toEqual(["ok"]);
  });

  it("returns [] for empty inputs", async () => {
    expect(await fetchMetaAdMeta("", ["1"])).toEqual([]);
    expect(await fetchMetaAdMeta("T", [])).toEqual([]);
  });
});
