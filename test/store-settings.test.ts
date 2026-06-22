import { describe, it, expect } from "vitest";
import { buildStoreUpdate } from "@/lib/store-settings";
import { decrypt, generateEncryptionKey } from "@/lib/crypto";

const KEY = generateEncryptionKey();

describe("buildStoreUpdate", () => {
  it("includes plain fields (trimmed) and a valid status", () => {
    const patch = buildStoreUpdate({ name: "  Aurela  ", currency: "PEN", status: "paused" }, KEY);
    expect(patch).toMatchObject({ name: "Aurela", currency: "PEN", status: "paused" });
  });

  it("ignores blank secrets (keeps existing) but encrypts provided ones", () => {
    const patch = buildStoreUpdate(
      { shopify_token: "  ", shopify_webhook_secret: "shpss_new", kapso_api_key: "" },
      KEY,
    );
    expect(patch.shopify_token_enc).toBeUndefined();
    expect(patch.kapso_api_key_enc).toBeUndefined();
    expect(typeof patch.shopify_webhook_secret_enc).toBe("string");
    // round-trips back to the provided secret
    expect(decrypt(patch.shopify_webhook_secret_enc as string, KEY)).toBe("shpss_new");
  });

  it("drops an invalid status and empty fields", () => {
    const patch = buildStoreUpdate({ status: "superactive", name: "   " }, KEY);
    expect(patch.status).toBeUndefined();
    expect(patch.name).toBeUndefined();
    expect(Object.keys(patch)).toHaveLength(0);
  });

  it("encrypts the Shopify token when provided", () => {
    const patch = buildStoreUpdate({ shopify_token: "shpat_abc" }, KEY);
    expect(decrypt(patch.shopify_token_enc as string, KEY)).toBe("shpat_abc");
  });
});
