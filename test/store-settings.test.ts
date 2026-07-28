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

  it("persists browse and winback automatic-send toggles", () => {
    expect(
      buildStoreUpdate({
        browse_template_enabled: "true",
        winback_template_enabled: "true",
      }),
    ).toMatchObject({
      browse_template_enabled: true,
      winback_template_enabled: true,
    });

    expect(
      buildStoreUpdate({
        browse_template_enabled: "false",
        winback_template_enabled: "false",
      }),
    ).toMatchObject({
      browse_template_enabled: false,
      winback_template_enabled: false,
    });
  });
});

describe("clave de Anthropic por tienda (0052)", () => {
  it("cifra la clave y guarda el modelo en claro", () => {
    const patch = buildStoreUpdate(
      { anthropic_api_key: "sk-ant-abc123", anthropic_model: "claude-haiku-4-5" },
      KEY,
    );
    expect(patch.anthropic_model).toBe("claude-haiku-4-5");
    // La clave nunca se guarda en texto plano.
    expect(patch.anthropic_api_key_enc).toBeTypeOf("string");
    expect(patch.anthropic_api_key_enc).not.toContain("sk-ant-abc123");
    expect(decrypt(patch.anthropic_api_key_enc as string, KEY)).toBe("sk-ant-abc123");
  });

  it("en blanco significa 'no la cambies', como el resto de secretos", () => {
    const patch = buildStoreUpdate({ anthropic_api_key: "   ", name: "Aurela" }, KEY);
    expect(patch).not.toHaveProperty("anthropic_api_key_enc");
    expect(patch.name).toBe("Aurela");
  });
});

describe("buildStoreUpdate — Aliclik (0054)", () => {
  it("cifra el token y el secreto de webhook", () => {
    const patch = buildStoreUpdate(
      { aliclik_api_token: "alc_tok", aliclik_webhook_secret: "whsec" },
      KEY,
    );
    expect(decrypt(patch.aliclik_api_token_enc as string, KEY)).toBe("alc_tok");
    expect(decrypt(patch.aliclik_webhook_secret_enc as string, KEY)).toBe("whsec");
  });

  it("en blanco conserva el valor existente, como el resto de secretos", () => {
    const patch = buildStoreUpdate({ aliclik_api_token: "  ", aliclik_webhook_secret: "" }, KEY);
    expect(patch.aliclik_api_token_enc).toBeUndefined();
    expect(patch.aliclik_webhook_secret_enc).toBeUndefined();
  });

  it("el interruptor se puede APAGAR (es un toggle, no un campo en blanco)", () => {
    expect(buildStoreUpdate({ aliclik_enabled: "true" }, KEY).aliclik_enabled).toBe(true);
    expect(buildStoreUpdate({ aliclik_enabled: false }, KEY).aliclik_enabled).toBe(false);
    // Ausente = no se toca.
    expect(buildStoreUpdate({}, KEY).aliclik_enabled).toBeUndefined();
  });
});
