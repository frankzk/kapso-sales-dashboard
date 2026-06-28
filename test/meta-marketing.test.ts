import { describe, it, expect } from "vitest";
import { listMetaAdAccounts, normalizeMetaAdAccounts } from "@/lib/meta-marketing";

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
