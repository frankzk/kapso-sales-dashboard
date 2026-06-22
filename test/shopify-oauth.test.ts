import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  isValidShopDomain,
  buildAuthorizeUrl,
  verifyShopifyOAuthHmac,
  exchangeCodeForToken,
} from "@/lib/shopify";

const SECRET = "shopify_app_secret";

function oauthHmac(params: Record<string, string>, secret = SECRET): string {
  const msg = Object.entries(params)
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("&");
  return createHmac("sha256", secret).update(msg).digest("hex");
}

describe("isValidShopDomain", () => {
  it("accepts canonical myshopify hosts", () => {
    expect(isValidShopDomain("aurela-peru.myshopify.com")).toBe(true);
    expect(isValidShopDomain("AURELA-PERU.MyShopify.com")).toBe(true);
  });
  it("rejects spoofs / non-myshopify hosts", () => {
    expect(isValidShopDomain("evil.com")).toBe(false);
    expect(isValidShopDomain("aurela.myshopify.com.evil.com")).toBe(false);
    expect(isValidShopDomain("aurela.myshopify.io")).toBe(false);
    expect(isValidShopDomain("")).toBe(false);
  });
});

describe("buildAuthorizeUrl", () => {
  it("builds the authorize URL with params", () => {
    const url = new URL(
      buildAuthorizeUrl({
        shop: "aurela-peru.myshopify.com",
        apiKey: "KEY",
        scopes: "read_orders",
        redirectUri: "https://app.example.com/api/shopify/callback",
        state: "store1.abc",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://aurela-peru.myshopify.com/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("KEY");
    expect(url.searchParams.get("scope")).toBe("read_orders");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/api/shopify/callback");
    expect(url.searchParams.get("state")).toBe("store1.abc");
  });
});

describe("verifyShopifyOAuthHmac", () => {
  const base = {
    code: "abc123",
    shop: "aurela-peru.myshopify.com",
    state: "store1.nonce",
    timestamp: "1700000000",
  };

  it("accepts a correctly signed callback", () => {
    const params = new URLSearchParams({ ...base, hmac: oauthHmac(base) });
    expect(verifyShopifyOAuthHmac(params, SECRET)).toBe(true);
  });

  it("rejects a tampered param", () => {
    const params = new URLSearchParams({ ...base, code: "tampered", hmac: oauthHmac(base) });
    expect(verifyShopifyOAuthHmac(params, SECRET)).toBe(false);
  });

  it("rejects a wrong secret and a missing hmac", () => {
    const params = new URLSearchParams({ ...base, hmac: oauthHmac(base) });
    expect(verifyShopifyOAuthHmac(params, "nope")).toBe(false);
    expect(verifyShopifyOAuthHmac(new URLSearchParams(base), SECRET)).toBe(false);
  });
});

describe("exchangeCodeForToken", () => {
  function fakeFetch(payload: unknown, ok = true, status = 200): typeof fetch {
    return (async () =>
      ({ ok, status, json: async () => payload, text: async () => JSON.stringify(payload) }) as Response) as unknown as typeof fetch;
  }

  it("returns the access token on success", async () => {
    const r = await exchangeCodeForToken({
      shop: "aurela-peru.myshopify.com",
      apiKey: "K",
      apiSecret: "S",
      code: "c",
      fetchImpl: fakeFetch({ access_token: "shpat_xyz", scope: "read_orders" }),
    });
    expect(r).toEqual({ access_token: "shpat_xyz", scope: "read_orders" });
  });

  it("throws when Shopify returns no token", async () => {
    await expect(
      exchangeCodeForToken({
        shop: "aurela-peru.myshopify.com",
        apiKey: "K",
        apiSecret: "S",
        code: "c",
        fetchImpl: fakeFetch({ error: "invalid_request" }),
      }),
    ).rejects.toThrow(/access_token/);
  });

  it("throws on HTTP error", async () => {
    await expect(
      exchangeCodeForToken({
        shop: "aurela-peru.myshopify.com",
        apiKey: "K",
        apiSecret: "S",
        code: "c",
        fetchImpl: fakeFetch({ error: "bad" }, false, 401),
      }),
    ).rejects.toThrow(/HTTP 401/);
  });
});
