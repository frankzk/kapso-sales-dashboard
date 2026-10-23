// Ajustes → WooCommerce → «Crear los pedidos nuevos en: Shopify / WooCommerce»
// (MOM §38.1, §38.12): qué se acepta, qué se escribe en `stores` (y qué no:
// `woo_intake_from`, las claves, el token de Shopify), la prueba de conexión
// antes de pasar a WooCommerce, el mensaje del CHECK de la base y la vuelta a
// Shopify. Sin red ni base: las dos son falsas.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
});

const h = vi.hoisted(() => ({
  db: null as unknown as import("./woocommerce-fake-db").FakeDb,
  allowed: true,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (p: string) => {
    throw new Error(`redirect:${p}`);
  },
}));
vi.mock("@/lib/db", () => ({
  createServerSupabase: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner-1" } } }) } }),
  createAdminSupabase: () => h.db.client(),
}));
vi.mock("@/lib/permissions-access", () => ({ hasOrgPermission: async () => h.allowed }));

import { encrypt } from "@/lib/crypto";
import { switchStorePlatform } from "@/app/dashboard/[storeId]/settings/woo-platform-actions";
import {
  WOO_PLATFORM_FIELDS,
  WOO_PLATFORM_NEEDS_CREDS,
  buildPlatformSwitchPatch,
  platformSwitchErrorMessage,
  validatePlatformSwitch,
} from "@/lib/woocommerce-platform";
import { FakeDb, type Row } from "./woocommerce-fake-db";
import { fakeWooShop } from "./woocommerce-fake-shop";

const STORE = "11111111-1111-4111-8111-111111111111";
const CK = "ck_0123456789abcdef0123456789abcdef01234567";
const CS = "cs_0123456789abcdef0123456789abcdef01234567";
const INTAKE = "2026-10-27T15:00:00.000Z";

function storeRow(over: Row = {}): Row {
  return {
    id: STORE,
    org_id: "org-1",
    status: "active",
    timezone: "America/Lima",
    platform: "shopify",
    platform_switched_at: null,
    woo_intake_from: INTAKE,
    woo_site_url: "https://kenku.pe",
    woo_site_key: "kp",
    woo_consumer_key_enc: encrypt(CK),
    woo_consumer_secret_enc: encrypt(CS),
    woo_webhook_secret_enc: null,
    woo_last_error: null,
    shopify_token_enc: "token-cifrado",
    ...over,
  };
}

function form(target: string, confirm = true): FormData {
  const fd = new FormData();
  fd.set("store_id", STORE);
  fd.set(WOO_PLATFORM_FIELDS.target, target);
  if (confirm) fd.set(WOO_PLATFORM_FIELDS.confirm, "1");
  return fd;
}

beforeEach(() => {
  h.allowed = true;
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("qué se acepta (validatePlatformSwitch)", () => {
  const ready = { platform: "shopify", apiComplete: true };
  it("solo shopify o woocommerce, y solo si cambia", () => {
    expect(validatePlatformSwitch({ target: "magento", confirm: "1" }, ready)).toEqual({ ok: false, error: "Elige Shopify o WooCommerce." });
    expect(validatePlatformSwitch({ target: "shopify", confirm: "1" }, ready)).toMatchObject({ ok: false });
    expect(validatePlatformSwitch({ target: "woocommerce", confirm: "1" }, ready)).toEqual({ ok: true, target: "woocommerce" });
  });
  it("sin confirmar, no", () => {
    expect(validatePlatformSwitch({ target: "woocommerce", confirm: null }, ready)).toMatchObject({ ok: false });
  });
  it("a WooCommerce sin las claves completas, no; a Shopify siempre", () => {
    expect(validatePlatformSwitch({ target: "woocommerce", confirm: "1" }, { platform: "shopify", apiComplete: false })).toEqual({
      ok: false,
      error: WOO_PLATFORM_NEEDS_CREDS,
    });
    expect(validatePlatformSwitch({ target: "shopify", confirm: "1" }, { platform: "woocommerce", apiComplete: false })).toEqual({
      ok: true,
      target: "shopify",
    });
  });
  it("platform_switched_at solo la primera vez; volver a Shopify solo cambia platform", () => {
    expect(buildPlatformSwitchPatch("woocommerce", { platformSwitchedAt: null }, "T")).toEqual({ platform: "woocommerce", platform_switched_at: "T" });
    expect(buildPlatformSwitchPatch("woocommerce", { platformSwitchedAt: "S" }, "T")).toEqual({ platform: "woocommerce" });
    expect(buildPlatformSwitchPatch("shopify", { platformSwitchedAt: "S" }, "T")).toEqual({ platform: "shopify" });
  });
  it("el CHECK de la base (stores_woo_platform_check) se dice con palabras de la operación", () => {
    expect(
      platformSwitchErrorMessage({ code: "23514", message: 'new row for relation "stores" violates check constraint "stores_woo_platform_check"' }),
    ).toBe(WOO_PLATFORM_NEEDS_CREDS);
  });
});

describe("la acción (switchStorePlatform)", () => {
  it("a WooCommerce: prueba la conexión guardada, cambia platform y fija platform_switched_at; nada más", async () => {
    h.db = new FakeDb({ stores: [storeRow()] });
    const shop = fakeWooShop();
    vi.stubGlobal("fetch", shop.fetchImpl);
    const res = await switchStorePlatform({}, form("woocommerce"));
    expect(res.error).toBeUndefined();
    expect(res.notice).toContain("«Generar pedido», «Venta telefónica» y los buscadores de productos de esta tienda usan WooCommerce");
    // Lee y escribe sin cambiar nada: un lote vacío.
    expect(shop.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /orders", "POST /orders/batch"]);
    expect(shop.calls[1]!.body).toEqual({});
    const updates = h.db.opsOn("stores", "update");
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0]!.payload).sort()).toEqual(["platform", "platform_switched_at"]);
    expect(updates[0]!.filters).toContainEqual(["eq", "platform", "shopify"]);
    const store = h.db.rows("stores")[0]!;
    expect(store.platform).toBe("woocommerce");
    expect(store.platform_switched_at).toEqual(expect.any(String));
    expect(store.woo_intake_from).toBe(INTAKE);
    expect(store.shopify_token_enc).toBe("token-cifrado");
    const log = JSON.parse(String(vi.mocked(console.info).mock.calls[0]![0]).replace("[woo-platform] ", ""));
    expect(log).toMatchObject({ storeId: STORE, from: "shopify", to: "woocommerce", by: "owner-1", firstSwitch: true });
    expect(JSON.stringify(log)).not.toContain(CK);
  });

  it("y de vuelta a Shopify: sin probar nada, sin mover platform_switched_at", async () => {
    h.db = new FakeDb({ stores: [storeRow({ platform: "woocommerce", platform_switched_at: "2026-10-27T23:00:00Z" })] });
    const shop = fakeWooShop({ failAlways: { "GET /orders": "timeout" } });
    vi.stubGlobal("fetch", shop.fetchImpl);
    const res = await switchStorePlatform({}, form("shopify"));
    expect(res.error).toBeUndefined();
    expect(shop.calls).toHaveLength(0);
    expect(h.db.rows("stores")[0]).toMatchObject({ platform: "shopify", platform_switched_at: "2026-10-27T23:00:00Z", woo_intake_from: INTAKE });
  });

  it("si WooCommerce no responde con las claves guardadas, no cambia", async () => {
    h.db = new FakeDb({ stores: [storeRow()] });
    vi.stubGlobal("fetch", fakeWooShop({ failAlways: { "GET /orders": { status: 401, body: { code: "woocommerce_rest_authentication_error", message: "Clave no válida" } } } }).fetchImpl);
    const res = await switchStorePlatform({}, form("woocommerce"));
    expect(res.error).toMatch(/^No se cambió: WooCommerce no responde con las claves guardadas/);
    expect(h.db.opsOn("stores", "update")).toHaveLength(0);
    expect(h.db.rows("stores")[0]!.platform).toBe("shopify");
  });

  it("una clave de solo «Lectura» (sirve para la entrada, no para vender): no cambia y lo dice", async () => {
    h.db = new FakeDb({ stores: [storeRow()] });
    const shop = fakeWooShop({
      failAlways: {
        "POST /orders/batch": {
          status: 401,
          body: { code: "woocommerce_rest_authentication_error", message: "The API key provided does not have write permissions." },
        },
      },
    });
    vi.stubGlobal("fetch", shop.fetchImpl);
    const res = await switchStorePlatform({}, form("woocommerce"));
    expect(res.error).toMatch(/^No se cambió: las claves guardadas leen pero no pueden crear pedidos en WooCommerce\. La clave de la API de WooCommerce es de solo lectura/);
    expect(h.db.opsOn("stores", "update")).toHaveLength(0);
    expect(h.db.rows("stores")[0]!.platform).toBe("shopify");
  });

  it("sin las claves completas: el mensaje claro, sin llamar a nadie", async () => {
    h.db = new FakeDb({ stores: [storeRow({ woo_consumer_secret_enc: null })] });
    vi.stubGlobal("fetch", vi.fn());
    const res = await switchStorePlatform({}, form("woocommerce"));
    expect(res.error).toBe(WOO_PLATFORM_NEEDS_CREDS);
    expect(h.db.opsOn("stores", "update")).toHaveLength(0);
  });

  it("si la base lo rechaza igual (stores_woo_platform_check), el mismo mensaje", async () => {
    h.db = new FakeDb({ stores: [storeRow()] });
    h.db.failOn = (table, op) =>
      table === "stores" && op === "update"
        ? { code: "23514", message: 'new row for relation "stores" violates check constraint "stores_woo_platform_check"' }
        : null;
    vi.stubGlobal("fetch", fakeWooShop().fetchImpl);
    const res = await switchStorePlatform({}, form("woocommerce"));
    expect(res.error).toBe(WOO_PLATFORM_NEEDS_CREDS);
  });

  it("sin confirmar o sin permiso, nada", async () => {
    h.db = new FakeDb({ stores: [storeRow()] });
    vi.stubGlobal("fetch", vi.fn());
    expect((await switchStorePlatform({}, form("woocommerce", false))).error).toMatch(/^Marca la confirmación/);
    h.allowed = false;
    expect((await switchStorePlatform({}, form("woocommerce"))).error).toBe("Sin permiso para cambiar esta tienda.");
    expect(h.db.opsOn("stores", "update")).toHaveLength(0);
  });

  it("si otra persona cambió la plataforma entre la lectura y el guardado, no se pisa", async () => {
    h.db = new FakeDb({ stores: [storeRow()] });
    vi.stubGlobal("fetch", fakeWooShop().fetchImpl);
    const original = h.db.from.bind(h.db);
    let reads = 0;
    h.db.from = (table: string) => {
      const q = original(table);
      if (table === "stores" && ++reads === 3) h.db.rows("stores")[0]!.platform = "woocommerce";
      return q;
    };
    const res = await switchStorePlatform({}, form("woocommerce"));
    expect(res.error).toContain("Alguien cambió la plataforma");
  });
});

describe("el cableado", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const SECTION = read("components/woocommerce-settings-section.tsx");
  const ACTION = read("app/dashboard/[storeId]/settings/woo-platform-actions.ts");

  it("el formulario manda los dos campos y la acción los lee por WOO_PLATFORM_FIELDS", () => {
    expect(SECTION).toContain("name={WOO_PLATFORM_FIELDS.target}");
    expect(SECTION).toContain("name={WOO_PLATFORM_FIELDS.confirm}");
    expect(ACTION).toContain("formData.get(WOO_PLATFORM_FIELDS.target)");
    expect(ACTION).toContain("formData.get(WOO_PLATFORM_FIELDS.confirm)");
  });

  it("pide «Administrar tiendas» y confirmación en el diálogo; no toca woo_intake_from ni Shopify", () => {
    expect(ACTION).toContain('"stores.manage"');
    expect(SECTION).toContain("window.confirm(texto)");
    expect(ACTION).not.toMatch(/woo_intake_from\s*:/);
    expect(ACTION).not.toMatch(/shopify_(token|webhook)/);
  });
});
