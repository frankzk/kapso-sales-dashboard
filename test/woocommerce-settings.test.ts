// Ajustes → WooCommerce (MOM §38.11): qué se acepta al guardar el sitio y las
// claves de WooCommerce, que los secretos se guarden cifrados y nunca vuelvan
// al navegador, que «Probar conexión» pruebe sin guardar, y que todo pida
// «Administrar tiendas» como las demás credenciales. Sin red: `fetch` es falso.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "./woocommerce-fake-db";

const h = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  return {
    db: null as unknown as import("./woocommerce-fake-db").FakeDb,
    allowed: true,
    revalidated: [] as string[],
  };
});

vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => h.db.client(),
  createServerSupabase: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } }),
}));
vi.mock("@/lib/permissions-access", () => ({
  hasOrgPermission: vi.fn(async (_org: string, perm: string) => h.allowed && perm === "stores.manage"),
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => h.revalidated.push(p) }));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));

import { decrypt, encrypt } from "@/lib/crypto";
import {
  WOO_NEW_SITE_NEEDS_KEYS,
  WOO_SETTINGS_FIELDS,
  buildWooSettingsPatch,
  validateWooSettings,
  wooUniqueViolationMessage,
  type WooSettingsCurrent,
} from "@/lib/woocommerce-settings";
import { generateWooWebhookSecret, saveWooSettings, testWooConnection } from "@/app/dashboard/[storeId]/settings/woo-actions";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const CK = "ck_0123456789abcdef0123456789abcdef01234567";
const CS = "cs_0123456789abcdef0123456789abcdef01234567";
const CK2 = "ck_ffffffffffffffffffffffffffffffffffffffff";
const CS2 = "cs_ffffffffffffffffffffffffffffffffffffffff";

const EMPTY: WooSettingsCurrent = {
  siteUrl: null,
  siteKey: null,
  hasConsumerKey: false,
  hasConsumerSecret: false,
  hasWebhookSecret: false,
  hasWooOrders: false,
};

describe("validateWooSettings", () => {
  it("acepta lo de una tienda nueva y dice que hay que probarlo", () => {
    const v = validateWooSettings(
      { siteUrl: " https://Kenku.pe/ ", siteKey: "KP", consumerKey: CK, consumerSecret: CS, webhookSecret: "a".repeat(32) },
      EMPTY,
    );
    expect(v).toEqual({
      ok: true,
      values: { siteUrl: "https://kenku.pe", siteKey: "kp", consumerKey: CK, consumerSecret: CS, webhookSecret: "a".repeat(32) },
      apiChanged: true,
      apiComplete: true,
    });
  });

  it("solo https a un dominio público", () => {
    for (const siteUrl of ["http://kenku.pe", "https://10.0.0.5", "https://localhost", "https://kenku.pe:8443", "https://u:p@kenku.pe", "https://kenku.pe/wp-json/wc/v3", "kenku.pe"]) {
      const v = validateWooSettings({ siteUrl, siteKey: "kp" }, EMPTY);
      expect(v.ok, siteUrl).toBe(false);
    }
  });

  it("la clave del sitio: minúsculas y dígitos, empezando por letra", () => {
    for (const siteKey of ["k", "1kp", "kp-1", "k p", "abcdefghijklm"]) {
      expect(validateWooSettings({ siteUrl: "https://kenku.pe", siteKey }, EMPTY).ok, siteKey).toBe(false);
    }
    expect(validateWooSettings({ siteUrl: "https://kenku.pe", siteKey: "aur" }, EMPTY).ok).toBe(true);
  });

  it("la clave del sitio no se cambia cuando ya hay pedidos con ella", () => {
    const current = { ...EMPTY, siteUrl: "https://kenku.pe", siteKey: "kp", hasWooOrders: true };
    const v = validateWooSettings({ siteKey: "kenku" }, current);
    expect(v).toMatchObject({ ok: false });
    expect(!v.ok && v.error).toContain("wc-kp-");
    // La misma clave otra vez no es un cambio.
    expect(validateWooSettings({ siteKey: "kp", webhookSecret: "b".repeat(20) }, current).ok).toBe(true);
    // Sin pedidos todavía, sí.
    expect(validateWooSettings({ siteKey: "kenku" }, { ...current, hasWooOrders: false }).ok).toBe(true);
  });

  it("las claves de la API: con su forma y de a dos", () => {
    const base = { siteUrl: "https://kenku.pe", siteKey: "kp" };
    expect(validateWooSettings({ ...base, consumerKey: "abc123", consumerSecret: CS }, EMPTY).ok).toBe(false);
    expect(validateWooSettings({ ...base, consumerKey: CK, consumerSecret: "cs_ con espacio" }, EMPTY).ok).toBe(false);
    expect(validateWooSettings({ ...base, consumerKey: CK }, EMPTY)).toMatchObject({ ok: false });
    expect(validateWooSettings({ ...base, consumerSecret: CS }, EMPTY)).toMatchObject({ ok: false });
  });

  it("el secreto de los webhooks sin los caracteres que WooCommerce transforma", () => {
    const base = { siteUrl: "https://kenku.pe", siteKey: "kp" };
    for (const webhookSecret of ["corto", "a&b".repeat(8), "a<b>".repeat(5), `x"${"y".repeat(20)}`, "con espacio en medio 1234"]) {
      expect(validateWooSettings({ ...base, webhookSecret }, EMPTY).ok, webhookSecret).toBe(false);
    }
  });

  it("cambiar la dirección exige las dos claves escritas otra vez", () => {
    const stored: WooSettingsCurrent = { ...EMPTY, siteUrl: "https://kenku.pe", siteKey: "kp", hasConsumerKey: true, hasConsumerSecret: true };
    expect(validateWooSettings({ siteUrl: "https://kenku-pe.com" }, stored)).toEqual({ ok: false, error: WOO_NEW_SITE_NEEDS_KEYS });
    expect(validateWooSettings({ siteUrl: "https://kenku-pe.com", consumerKey: CK, consumerSecret: CS }, stored).ok).toBe(true);
    // La misma dirección, escrita otra vez, no es un cambio.
    expect(validateWooSettings({ siteUrl: "https://kenku.pe/", webhookSecret: "a".repeat(32) }, stored).ok).toBe(true);
    // Sin claves guardadas no hay nada que pueda viajar.
    expect(validateWooSettings({ siteUrl: "https://kenku-pe.com" }, { ...stored, hasConsumerKey: false, hasConsumerSecret: false }).ok).toBe(true);
  });

  it("en blanco conserva; nada que cambiar es un error; sin sitio o sin clave, también", () => {
    const current = { ...EMPTY, siteUrl: "https://kenku.pe", siteKey: "kp", hasConsumerKey: true, hasConsumerSecret: true };
    expect(validateWooSettings({}, current)).toEqual({ ok: false, error: "No hay cambios que guardar." });
    expect(validateWooSettings({ siteUrl: "https://kenku.pe", siteKey: "kp" }, current)).toMatchObject({ ok: false });
    expect(validateWooSettings({ webhookSecret: "c".repeat(24) }, EMPTY)).toMatchObject({ ok: false });
    // Solo el secreto de webhooks: no hay que probar la API.
    expect(validateWooSettings({ webhookSecret: "c".repeat(24) }, current)).toMatchObject({
      ok: true,
      apiChanged: false,
      apiComplete: true,
    });
  });
});

describe("buildWooSettingsPatch", () => {
  it("cifra los secretos y deja el sitio y la clave tal cual", () => {
    const patch = buildWooSettingsPatch({ siteUrl: "https://kenku.pe", siteKey: "kp", consumerKey: CK, consumerSecret: CS, webhookSecret: "w".repeat(32) });
    expect(Object.keys(patch).sort()).toEqual(
      ["woo_consumer_key_enc", "woo_consumer_secret_enc", "woo_site_key", "woo_site_url", "woo_webhook_secret_enc"].sort(),
    );
    expect(patch.woo_site_url).toBe("https://kenku.pe");
    expect(decrypt(patch.woo_consumer_key_enc!)).toBe(CK);
    expect(decrypt(patch.woo_consumer_secret_enc!)).toBe(CS);
    expect(decrypt(patch.woo_webhook_secret_enc!)).toBe("w".repeat(32));
    expect(JSON.stringify(patch)).not.toContain(CK);
  });

  it("solo lo que cambia", () => {
    expect(buildWooSettingsPatch({ webhookSecret: "w".repeat(32) })).toEqual({ woo_webhook_secret_enc: expect.any(String) });
  });

  it("explica la clave o el sitio repetidos en otra tienda", () => {
    expect(wooUniqueViolationMessage({ code: "23505", message: 'duplicate key value violates unique constraint "stores_woo_site_key_uniq"' })).toContain(
      "clave del sitio",
    );
    expect(wooUniqueViolationMessage({ code: "23505", message: "stores_woo_site_url_uniq" })).toContain("otra tienda");
    expect(wooUniqueViolationMessage({ code: "42501", message: "x" })).toBeNull();
  });
});

// ── Las acciones ────────────────────────────────────────────────────────────

function storeRow(over: Row = {}): Row {
  return {
    id: STORE_ID,
    org_id: "org-1",
    status: "active",
    timezone: "America/Lima",
    platform: "shopify",
    woo_site_url: null,
    woo_site_key: null,
    woo_consumer_key_enc: null,
    woo_consumer_secret_enc: null,
    woo_webhook_secret_enc: null,
    woo_last_error: null,
    // Lo de Shopify de la tienda, que estas acciones no tocan.
    shopify_token_enc: "token-cifrado-de-shopify",
    shopify_webhook_secret_enc: "secreto-cifrado-de-shopify",
    ...over,
  };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set("store_id", STORE_ID);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const calls: { url: URL; auth: string | null; method: string }[] = [];

/** Los webhooks del sitio (MOM §38.14): por defecto, los cuatro temas activos hacia esta tienda. */
const webhook = (id: number, topic: string, status = "active", storeId = STORE_ID) => ({
  id,
  status,
  topic,
  delivery_url: `https://kapta.example/api/webhooks/woocommerce/${storeId}`,
});
const HEALTHY_WEBHOOKS = ["order.created", "order.updated", "order.deleted", "order.restored"].map((t, i) => webhook(i + 1, t));
let siteWebhooks: unknown[] = HEALTHY_WEBHOOKS;

function stubWoo(status = 200, body: unknown = [{ id: 1 }], headers: Record<string, string> = { "X-WP-Total": "42", "X-WP-TotalPages": "42" }) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, auth: new Headers(init?.headers).get("authorization"), method: init?.method ?? "GET" });
      if (url.pathname.endsWith("/settings/general/woocommerce_currency")) {
        return new Response(JSON.stringify({ id: "woocommerce_currency", value: "PEN" }), { status: 200 });
      }
      if (url.pathname.endsWith("/wp-json/wc/v3/webhooks")) {
        return new Response(JSON.stringify(siteWebhooks), {
          status: 200,
          headers: { "X-WP-Total": String(siteWebhooks.length), "X-WP-TotalPages": "1" },
        });
      }
      return new Response(JSON.stringify(body), { status, headers });
    }),
  );
}

beforeEach(() => {
  h.db = new FakeDb({ stores: [storeRow()] });
  h.allowed = true;
  h.revalidated.length = 0;
  siteWebhooks = HEALTHY_WEBHOOKS;
  stubWoo();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saveWooSettings", () => {
  const full = {
    [WOO_SETTINGS_FIELDS.siteUrl]: "https://kenku.pe",
    [WOO_SETTINGS_FIELDS.siteKey]: "kp",
    [WOO_SETTINGS_FIELDS.consumerKey]: CK,
    [WOO_SETTINGS_FIELDS.consumerSecret]: CS,
    [WOO_SETTINGS_FIELDS.webhookSecret]: "f".repeat(48),
  };

  it("prueba las claves contra /orders?per_page=1 y las guarda cifradas", async () => {
    const r = await saveWooSettings({}, form(full));
    expect(r.error).toBeUndefined();
    expect(r.notice).toContain("Conexión correcta con kenku.pe: 42 pedidos");
    expect(r.notice).toContain("sincronización trae cada 5 minutos");
    expect(calls[0]!.url.toString()).toContain("https://kenku.pe/wp-json/wc/v3/orders?");
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("1");

    const row = h.db.rows("stores")[0]!;
    expect(row).toMatchObject({ woo_site_url: "https://kenku.pe", woo_site_key: "kp", woo_last_error: null });
    expect(decrypt(row.woo_consumer_key_enc)).toBe(CK);
    expect(decrypt(row.woo_consumer_secret_enc)).toBe(CS);
    expect(decrypt(row.woo_webhook_secret_enc)).toBe("f".repeat(48));
    // Ningún secreto vuelve en la respuesta, y lo de Shopify sigue igual.
    expect(JSON.stringify(r)).not.toContain(CK);
    expect(JSON.stringify(r)).not.toContain(CS);
    expect(row.shopify_token_enc).toBe("token-cifrado-de-shopify");
    expect(row.platform).toBe("shopify");
    expect(h.revalidated).toEqual([`/dashboard/${STORE_ID}/settings`]);
  });

  it("la primera vez que guarda las claves fija desde cuándo entran los pedidos del sitio; después no lo mueve", async () => {
    const before = Date.now();
    const r = await saveWooSettings({}, form(full));
    expect(r.notice).toContain("Solo entran los pedidos creados desde este momento");
    const fixed = h.db.rows("stores")[0]!.woo_intake_from as string;
    expect(Date.parse(fixed)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(fixed)).toBeLessThanOrEqual(Date.now());

    // Claves nuevas para el mismo sitio: el piso queda donde estaba.
    const again = await saveWooSettings({}, form({ [WOO_SETTINGS_FIELDS.consumerKey]: CK2, [WOO_SETTINGS_FIELDS.consumerSecret]: CS2 }));
    expect(again.error).toBeUndefined();
    expect(h.db.rows("stores")[0]!.woo_intake_from).toBe(fixed);
  });

  it("si WooCommerce rechaza las claves, no guarda nada", async () => {
    stubWoo(401, { code: "woocommerce_rest_authentication_error", message: "Clave de consumidor no válida." });
    const r = await saveWooSettings({}, form(full));
    expect(r.error).toMatch(/^No se guardó: WooCommerce rechazó la Consumer key/);
    expect(h.db.rows("stores")[0]!.woo_site_url).toBeNull();
    expect(h.db.opsOn("stores", "update")).toEqual([]);
  });

  it("solo el secreto de webhooks: no llama a WooCommerce", async () => {
    h.db = new FakeDb({
      stores: [storeRow({ woo_site_url: "https://kenku.pe", woo_site_key: "kp", woo_consumer_key_enc: encrypt(CK), woo_consumer_secret_enc: encrypt(CS) })],
    });
    const r = await saveWooSettings({}, form({ [WOO_SETTINGS_FIELDS.webhookSecret]: "e".repeat(40) }));
    expect(r.error).toBeUndefined();
    expect(calls).toEqual([]);
    expect(decrypt(h.db.rows("stores")[0]!.woo_webhook_secret_enc)).toBe("e".repeat(40));
  });

  it("no cambia la clave del sitio si ya hay pedidos de WooCommerce", async () => {
    h.db = new FakeDb({
      stores: [storeRow({ woo_site_url: "https://kenku.pe", woo_site_key: "kp" })],
      orders: [{ id: "o-1", store_id: STORE_ID, shopify_order_id: "wc-kp-1", platform: "woocommerce" }],
    });
    const r = await saveWooSettings({}, form({ [WOO_SETTINGS_FIELDS.siteKey]: "kenku" }));
    expect(r.error).toContain("no se cambia");
    expect(h.db.rows("stores")[0]!.woo_site_key).toBe("kp");
  });

  it("sin «Administrar tiendas» no lee ni escribe nada de WooCommerce", async () => {
    h.allowed = false;
    const r = await saveWooSettings({}, form(full));
    expect(r.error).toMatch(/Sin permiso/);
    expect(calls).toEqual([]);
    expect(h.db.opsOn("stores", "update")).toEqual([]);
  });

  it("una dirección nueva con las claves en blanco no prueba ni guarda: las claves guardadas no viajan a otro sitio", async () => {
    h.db = new FakeDb({
      stores: [storeRow({ woo_site_url: "https://kenku.pe", woo_site_key: "kp", woo_consumer_key_enc: encrypt(CK), woo_consumer_secret_enc: encrypt(CS) })],
    });
    const tries: Record<string, string>[] = [
      { [WOO_SETTINGS_FIELDS.siteUrl]: "https://kenku-pe.com" },
      { [WOO_SETTINGS_FIELDS.siteUrl]: "https://kenku-pe.com", [WOO_SETTINGS_FIELDS.webhookSecret]: "e".repeat(40) },
    ];
    for (const fields of tries) {
      const r = await saveWooSettings({}, form(fields));
      expect(r.error).toBe(WOO_NEW_SITE_NEEDS_KEYS);
    }
    expect(calls).toEqual([]);
    expect(h.db.opsOn("stores", "update")).toEqual([]);
    expect(h.db.rows("stores")[0]!.woo_site_url).toBe("https://kenku.pe");

    // Con las dos claves escritas de nuevo, sí: se prueban en la dirección nueva.
    const ok = await saveWooSettings(
      {},
      form({ [WOO_SETTINGS_FIELDS.siteUrl]: "https://kenku-pe.com", [WOO_SETTINGS_FIELDS.consumerKey]: CK2, [WOO_SETTINGS_FIELDS.consumerSecret]: CS2 }),
    );
    expect(ok.error).toBeUndefined();
    expect(calls[0]!.url.host).toBe("kenku-pe.com");
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(`${CK2}:${CS2}`).toString("base64")}`);
  });

  it("la clave o el sitio ya usados por otra tienda", async () => {
    h.db.failOn = (table, op) =>
      table === "stores" && op === "update"
        ? { code: "23505", message: 'duplicate key value violates unique constraint "stores_woo_site_url_uniq"' }
        : null;
    const r = await saveWooSettings({}, form(full));
    expect(r.error).toContain("ya está en otra tienda");
  });

  it("guardado lo probado, revisa los webhooks del sitio con esas claves, solo con GET (MOM §38.14)", async () => {
    const r = await saveWooSettings({}, form(full));
    expect(r.notice).toContain("Webhooks: los cuatro temas tienen uno activo que entrega a esta tienda.");
    const hooks = calls.filter((c) => c.url.pathname === "/wp-json/wc/v3/webhooks");
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.url.host).toBe("kenku.pe");
    expect(hooks[0]!.auth).toBe(`Basic ${Buffer.from(`${CK}:${CS}`).toString("base64")}`);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(h.db.rows("sync_state")).toEqual([
      expect.objectContaining({ store_id: STORE_ID, source: "woo_webhooks", status: "ok", error: null }),
    ]);
    expect(h.db.rows("stores")[0]!.woo_last_error).toBeNull();
  });

  it("un webhook desactivado no frena el guardado: lo dice el aviso y queda en el último fallo", async () => {
    siteWebhooks = HEALTHY_WEBHOOKS.map((w) => (w.topic === "order.deleted" ? { ...w, status: "disabled" } : w));
    const r = await saveWooSettings({}, form(full));
    expect(r.error).toBeUndefined();
    expect(r.notice).toMatch(/^Guardado\. /);
    expect(r.notice).toContain("Webhooks: order.deleted está desactivado.");
    const row = h.db.rows("stores")[0]!;
    expect(row.woo_site_url).toBe("https://kenku.pe");
    expect(row.woo_last_error).toMatch(/^Webhooks en WooCommerce: order\.deleted está desactivado\. /);
    expect(h.db.rows("sync_state")[0]).toMatchObject({ source: "woo_webhooks", status: "warning" });
    // Nada de la respuesta (la dirección de entrega) llega a la base.
    expect(JSON.stringify(h.db.rows("sync_state"))).not.toContain("kapta.example");
  });

  it("si la conexión no sirve, no guarda ni revisa los webhooks", async () => {
    stubWoo(401, { code: "woocommerce_rest_authentication_error", message: "Clave de consumidor no válida." });
    await saveWooSettings({}, form(full));
    expect(calls.some((c) => c.url.pathname.endsWith("/webhooks"))).toBe(false);
    expect(h.db.rows("sync_state")).toEqual([]);
  });
});

describe("testWooConnection", () => {
  it("prueba lo escrito sin guardarlo", async () => {
    const r = await testWooConnection(
      {},
      form({ [WOO_SETTINGS_FIELDS.siteUrl]: "https://aurela.pe", [WOO_SETTINGS_FIELDS.consumerKey]: CK2, [WOO_SETTINGS_FIELDS.consumerSecret]: CS2 }),
    );
    expect(r.notice).toContain("todavía no se guardó");
    expect(r.notice).toContain("Moneda: PEN");
    expect(calls[0]!.url.host).toBe("aurela.pe");
    expect(h.db.opsOn("stores", "update")).toEqual([]);
  });

  it("con lo guardado, deja el resultado en woo_last_error", async () => {
    h.db = new FakeDb({
      stores: [
        storeRow({
          woo_site_url: "https://kenku.pe",
          woo_site_key: "kp",
          woo_consumer_key_enc: encrypt(CK),
          woo_consumer_secret_enc: encrypt(CS),
          woo_last_error: "Sincronización: WooCommerce falló (HTTP 500).",
        }),
      ],
    });
    const ok = await testWooConnection({}, form({}));
    expect(ok.notice).toContain("Conexión correcta");
    expect(h.db.rows("stores")[0]!.woo_last_error).toBeNull();

    stubWoo(500, { code: "internal_server_error", message: "boom" });
    const bad = await testWooConnection({}, form({}));
    expect(bad.error).toContain("HTTP 500");
    expect(h.db.rows("stores")[0]!.woo_last_error).toMatch(/^Conexión: .*HTTP 500/);
  });

  it("otra dirección con las claves en blanco no manda las guardadas", async () => {
    h.db = new FakeDb({
      stores: [storeRow({ woo_site_url: "https://kenku.pe", woo_site_key: "kp", woo_consumer_key_enc: encrypt(CK), woo_consumer_secret_enc: encrypt(CS) })],
    });
    const tries: Record<string, string>[] = [
      { [WOO_SETTINGS_FIELDS.siteUrl]: "https://otro-sitio.pe" },
      { [WOO_SETTINGS_FIELDS.siteUrl]: "https://otro-sitio.pe", [WOO_SETTINGS_FIELDS.consumerKey]: CK2 },
    ];
    for (const fields of tries) {
      const r = await testWooConnection({}, form(fields));
      expect(r.error).toBe(WOO_NEW_SITE_NEEDS_KEYS);
    }
    expect(calls).toEqual([]);
    // La misma dirección (aunque la escriban) sí prueba con lo guardado.
    const same = await testWooConnection({}, form({ [WOO_SETTINGS_FIELDS.siteUrl]: "https://kenku.pe/" }));
    expect(same.notice).toContain("Conexión correcta");
    expect(calls[0]!.url.host).toBe("kenku.pe");
  });

  it("sin dirección ni claves no llama a nadie", async () => {
    const r = await testWooConnection({}, form({}));
    expect(r.error).toContain("hacen falta");
    expect(calls).toEqual([]);
  });

  it("con la conexión buena revisa también los webhooks; con lo escrito, sin registrar nada (MOM §38.14)", async () => {
    siteWebhooks = HEALTHY_WEBHOOKS.filter((w) => w.topic !== "order.restored");
    const r = await testWooConnection(
      {},
      form({ [WOO_SETTINGS_FIELDS.siteUrl]: "https://aurela.pe", [WOO_SETTINGS_FIELDS.consumerKey]: CK2, [WOO_SETTINGS_FIELDS.consumerSecret]: CS2 }),
    );
    expect(r.notice).toContain("Webhooks: falta order.restored.");
    expect(r.notice).toMatch(/\(Probado con lo escrito; todavía no se guardó\.\)$/);
    expect(calls.filter((c) => c.url.pathname.endsWith("/webhooks")).map((c) => c.url.host)).toEqual(["aurela.pe"]);
    expect(h.db.opsOn("stores", "update")).toEqual([]);
    expect(h.db.opsOn("sync_state")).toEqual([]);
  });

  it("con lo guardado, la revisión queda en sync_state y en el último fallo, y una buena lo borra", async () => {
    h.db = new FakeDb({
      stores: [storeRow({ woo_site_url: "https://kenku.pe", woo_site_key: "kp", woo_consumer_key_enc: encrypt(CK), woo_consumer_secret_enc: encrypt(CS) })],
    });
    siteWebhooks = HEALTHY_WEBHOOKS.map((w) => (w.topic === "order.created" ? { ...w, status: "paused" } : w));
    const bad = await testWooConnection({}, form({}));
    expect(bad.notice).toContain("Conexión correcta");
    expect(bad.notice).toContain("Webhooks: order.created está en pausa.");
    expect(h.db.rows("stores")[0]!.woo_last_error).toMatch(/^Webhooks en WooCommerce: order\.created está en pausa\. /);
    expect(h.db.rows("sync_state")[0]).toMatchObject({ source: "woo_webhooks", status: "warning" });

    siteWebhooks = HEALTHY_WEBHOOKS;
    const ok = await testWooConnection({}, form({}));
    expect(ok.notice).toContain("Webhooks: los cuatro temas");
    expect(h.db.rows("stores")[0]!.woo_last_error).toBeNull();
    expect(h.db.rows("sync_state")[0]).toMatchObject({ source: "woo_webhooks", status: "ok", error: null });
  });
});

describe("generateWooWebhookSecret", () => {
  it("genera uno hexadecimal, lo guarda cifrado y lo muestra una sola vez", async () => {
    const r = await generateWooWebhookSecret({}, form({}));
    expect(r.wooSecret).toMatch(/^[0-9a-f]{48}$/);
    expect(decrypt(h.db.rows("stores")[0]!.woo_webhook_secret_enc)).toBe(r.wooSecret);
    expect(validateWooSettings({ siteUrl: "https://kenku.pe", siteKey: "kp", webhookSecret: r.wooSecret }, EMPTY).ok).toBe(true);
  });

  it("sin permiso no genera nada", async () => {
    h.allowed = false;
    const r = await generateWooWebhookSecret({}, form({}));
    expect(r.wooSecret).toBeUndefined();
    expect(h.db.opsOn("stores", "update")).toEqual([]);
  });
});

// ── El cableado: formulario, acción, página ─────────────────────────────────

describe("el formulario, la acción y la página dicen lo mismo", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const SECTION = read("components/woocommerce-settings-section.tsx");
  const ACTIONS = read("app/dashboard/[storeId]/settings/woo-actions.ts");
  const PAGE = read("app/dashboard/[storeId]/settings/page.tsx");
  const SETTINGS = read("components/store-settings.tsx");

  it("cada campo de WOO_SETTINGS_FIELDS está en el formulario, y la acción los lee todos", () => {
    for (const name of Object.values(WOO_SETTINGS_FIELDS)) {
      expect(SECTION, name).toContain(`name="${name}"`);
    }
    // La acción los lee por WOO_SETTINGS_FIELDS: los cinco.
    for (const key of Object.keys(WOO_SETTINGS_FIELDS)) {
      expect(ACTIONS, key).toContain(`get(WOO_SETTINGS_FIELDS.${key})`);
    }
  });

  it("los secretos son campos de contraseña, que nunca se rellenan con lo guardado", () => {
    for (const name of [WOO_SETTINGS_FIELDS.consumerKey, WOO_SETTINGS_FIELDS.consumerSecret, WOO_SETTINGS_FIELDS.webhookSecret]) {
      expect(SECTION, name).toMatch(new RegExp(`<SecretInput\\s+name="${name}"`));
    }
    const secretInput = SECTION.slice(SECTION.indexOf("function SecretInput("), SECTION.indexOf("export function WooCommerceSettingsSection("));
    expect(secretInput).toContain('type="password"');
    expect(secretInput).not.toContain("defaultValue");
  });

  it("la sección no importa nada que arrastre node:crypto", () => {
    const imports = [...SECTION.matchAll(/^import[\s\S]*?from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(3);
    for (const mod of imports) {
      expect(mod).not.toMatch(/^(node:crypto|@\/lib\/crypto|@\/lib\/woocommerce|@\/lib\/woocommerce-intake|@\/lib\/ingest)$/);
    }
  });

  it("la página manda de cada secreto solo si hay uno", () => {
    const woo = PAGE.slice(PAGE.indexOf("    woo: {"), PAGE.indexOf("    // Solo sí/no, nunca los valores"));
    expect(woo).toContain("hasConsumerKey: Boolean(full.woo_consumer_key_enc)");
    expect(woo).toContain("hasConsumerSecret: Boolean(full.woo_consumer_secret_enc)");
    expect(woo).toContain("hasWebhookSecret: Boolean(full.woo_webhook_secret_enc)");
    expect(woo.match(/_enc/g)).toHaveLength(3);
  });

  it("la sección está en el índice y en la página de Ajustes", () => {
    expect(SETTINGS).toContain('{ id: "woocommerce", label: "WooCommerce" }');
    expect(SETTINGS).toContain("<WooCommerceSettingsSection storeId={s.id} data={data.woo} />");
    expect(SECTION).toContain('id="woocommerce"');
  });

  it("las acciones piden «Administrar tiendas» y no tocan ni la plataforma ni lo de Shopify", () => {
    expect(ACTIONS).toContain('"stores.manage"');
    expect(ACTIONS).not.toMatch(/platform\s*:/);
    expect(ACTIONS).not.toMatch(/shopify_(token|webhook)/);
  });
});
