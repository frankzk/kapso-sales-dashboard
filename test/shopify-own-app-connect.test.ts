// Tiendas con su app propia de Shopify — conectar y Ajustes (MOM §36.2, §36.4).
//
// «Conectar con app propia de Shopify» (app/dashboard/stores/new/actions.ts):
// mismo permiso que crear una tienda; un dominio malo, uno que ya está en Kapta
// (con cualquier app) o una app sin todos los permisos se rechazan SIN escribir
// nada y sin tocar ninguna otra tienda; si Shopify niega el token, el mensaje
// lo dice sin repetir el secreto; y una conexión buena crea la tienda 'propia'
// con todo cifrado, registra los webhooks con `app/uninstalled` y sincroniza.
//
// Ajustes (app/dashboard/[storeId]/settings/actions.ts): el Client secret se
// prueba antes de guardarlo y solo en tiendas 'propia'; «Re-registrar
// webhooks» suma `app/uninstalled` SOLO en una 'propia' (Kenku y Aurela se
// registran exactamente como antes). Sin red: `fetch` es falso.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Filter = [method: string, ...args: unknown[]];
interface Call {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  cols?: string;
  payload?: Record<string, unknown>;
  filters: Filter[];
}
type Reply = { data: unknown; error: unknown };

const st = vi.hoisted(() => ({
  calls: [] as Call[],
  user: { id: "owner" } as { id: string } | null,
  perms: ["stores.manage"] as string[],
  permArgs: [] as unknown[][],
  existing: [] as unknown[],
  existingError: null as unknown,
  insertError: null as unknown,
  /** La tienda que leen las acciones de Ajustes. */
  row: null as Record<string, unknown> | null,
  updated: [{ id: "store-propia" }] as unknown[],
  creds: null as Record<string, unknown> | null,
  finishWarnings: [] as string[],
  finishArgs: [] as unknown[][],
  registerArgs: [] as unknown[],
  revalidated: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: (p: unknown) => st.revalidated.push(p) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/permissions-access", () => ({
  hasOrgPermission: async (orgId: string, permission: string) => {
    st.permArgs.push([orgId, permission]);
    return st.perms.includes(permission);
  },
}));
vi.mock("@/lib/shopify-client-install", () => ({
  finishClientStoreConnection: vi.fn(async (...args: unknown[]) => {
    st.finishArgs.push(args);
    return st.finishWarnings;
  }),
}));
vi.mock("@/lib/shopify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shopify")>();
  return {
    ...actual,
    registerOrderWebhooks: vi.fn(async (opts: unknown) => {
      st.registerArgs.push(opts);
      return [{ topic: "ORDERS_CREATE", id: "gid://1" }];
    }),
  };
});
vi.mock("@/lib/ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest")>();
  return { ...actual, getStoreCreds: vi.fn(async () => st.creds) };
});

function reply(c: Call): Reply {
  if (c.table === "stores") {
    if (c.op === "insert") return st.insertError ? { data: null, error: st.insertError } : { data: { id: "new-store" }, error: null };
    if (c.op === "update") return { data: st.updated, error: null };
    if (c.filters.some((f) => f[0] === "ilike")) return { data: st.existingError ? null : st.existing, error: st.existingError };
    if (c.cols === "id, org_id") return { data: st.row ? { id: st.row.id, org_id: "org-sh" } : null, error: null };
    return { data: st.row, error: null };
  }
  return { data: null, error: null };
}

vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    const call: Call = { table, op: "select", filters: [] };
    st.calls.push(call);
    const q: any = {};
    q.select = (cols?: string) => {
      if (call.op === "select") call.cols = cols;
      return q;
    };
    for (const op of ["insert", "update", "upsert"] as const) {
      q[op] = (payload: Record<string, unknown>) => {
        call.op = op;
        call.payload = payload;
        return q;
      };
    }
    q.delete = () => {
      call.op = "delete";
      return q;
    };
    for (const m of ["eq", "neq", "in", "is", "not", "or", "ilike", "gte", "lte", "lt", "order", "limit"]) {
      q[m] = (...args: unknown[]) => {
        call.filters.push([m, ...args]);
        return q;
      };
    }
    q.maybeSingle = q.single = async () => reply(call);
    q.then = (res: any, rej: any) => Promise.resolve().then(() => reply(call)).then(res, rej);
    return q;
  };
  return {
    createAdminSupabase: () => ({ from }),
    createServerSupabase: async () => ({
      from,
      auth: {
        getUser: async () => ({ data: { user: st.user } }),
        getClaims: async () => ({ data: { claims: st.user ? { sub: st.user.id } : null } }),
      },
    }),
  };
});

import { decrypt, encrypt, generateEncryptionKey } from "@/lib/crypto";
import { CLIENT_APP_WEBHOOK_TOPICS } from "@/lib/shopify";
import { OWN_APP_MIGRATION_MISSING_MESSAGE } from "@/lib/shopify-own-app";
import { connectOwnAppStore } from "@/app/dashboard/stores/new/actions";
import {
  reRegisterWebhooks,
  renewOwnAppTokenNow,
  saveOwnAppCredentials,
} from "@/app/dashboard/[storeId]/settings/actions";

process.env.ENCRYPTION_KEY = generateEncryptionKey();

const SHOP = "super-human-peru.myshopify.com";
const CLIENT_ID = "0123456789abcdef0123456789abcdef";
const SECRET = "shpss_secreto-de-prueba-0123456789";
const NEW_TOKEN = "shpat_token-nuevo-1111111111";
const ALL_SCOPES = "read_orders,read_draft_orders,write_draft_orders,read_products,read_customers,write_orders";

interface Net {
  token: { status: number; payload: unknown };
  shop: { status: number; payload: unknown };
}
let net: Net;
let fetchSpy: ReturnType<typeof vi.fn>;
const logs: string[] = [];

function respond(r: { status: number; payload: unknown }) {
  const body = JSON.stringify(r.payload);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(body), text: async () => body };
}

beforeEach(() => {
  st.calls = [];
  st.user = { id: "owner" };
  st.perms = ["stores.manage"];
  st.permArgs = [];
  st.existing = [];
  st.existingError = null;
  st.insertError = null;
  st.row = null;
  st.updated = [{ id: "store-propia" }];
  st.creds = null;
  st.finishWarnings = [];
  st.finishArgs = [];
  st.registerArgs = [];
  st.revalidated = [];
  net = {
    token: { status: 200, payload: { access_token: NEW_TOKEN, scope: ALL_SCOPES, expires_in: 86399 } },
    shop: {
      status: 200,
      payload: { data: { shop: { name: "Súper Human Perú", currencyCode: "PEN", ianaTimezone: "America/Lima", myshopifyDomain: SHOP } } },
    },
  };
  fetchSpy = vi.fn(async (url: unknown) =>
    respond(String(url).endsWith("/admin/oauth/access_token") ? net.token : net.shop),
  );
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://kapta.test");
  logs.length = 0;
  for (const level of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const good = (over: Record<string, string> = {}) =>
  form({ org_id: "org-sh", shopify_domain: SHOP, client_id: CLIENT_ID, client_secret: SECRET, name: "", ...over });

/** Ninguna escritura en `stores` salvo, si se dice, el insert de la tienda nueva. */
function storeWrites() {
  return st.calls.filter((c) => c.table === "stores" && c.op !== "select");
}

function expectNoSecrets(text: string) {
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(NEW_TOKEN);
}

describe("connectOwnAppStore", () => {
  it("conecta: crea la tienda 'propia' con todo cifrado, webhooks con app/uninstalled y sincroniza", async () => {
    await expect(connectOwnAppStore({}, good())).rejects.toThrow("REDIRECT:/dashboard/new-store");

    expect(st.permArgs).toEqual([["org-sh", "stores.manage"]]);
    // Primero pregunta si el dominio ya está, en cualquier organización.
    const lookup = st.calls.find((c) => c.table === "stores" && c.filters.some((f) => f[0] === "ilike"))!;
    expect(lookup.filters).toEqual([
      ["ilike", "shopify_domain", SHOP],
      ["limit", 1],
    ]);
    expect(lookup.filters.some((f) => f[1] === "org_id")).toBe(false);

    const writes = storeWrites();
    expect(writes).toHaveLength(1);
    const ins = writes[0]!;
    expect(ins.op).toBe("insert");
    const p = ins.payload!;
    expect(p).toMatchObject({
      org_id: "org-sh",
      name: "Súper Human Perú",
      shopify_domain: SHOP,
      shopify_app: "propia",
      shopify_client_id: CLIENT_ID,
      currency: "PEN",
      timezone: "America/Lima",
      status: "active",
    });
    expect(decrypt(String(p.shopify_token_enc))).toBe(NEW_TOKEN);
    expect(decrypt(String(p.shopify_client_secret_enc))).toBe(SECRET);
    // Shopify firma los webhooks de la app con su Client secret.
    expect(decrypt(String(p.shopify_webhook_secret_enc))).toBe(SECRET);
    expect(Date.parse(String(p.shopify_token_expires_at)) - Date.parse(String(p.shopify_token_renewed_at))).toBe(86399 * 1000);
    // Nada en claro.
    expectNoSecrets(JSON.stringify(p));

    expect(st.calls.find((c) => c.table === "user_store_access")?.payload).toEqual({ user_id: "owner", store_id: "new-store" });
    // Webhooks (con APP_UNINSTALLED) y primera sincronización: lo de la app de clientes.
    expect(st.finishArgs).toHaveLength(1);
    expect(st.finishArgs[0]![1]).toEqual({ storeId: "new-store", shop: SHOP, token: NEW_TOKEN });
    expectNoSecrets(logs.join("\n"));
  });

  it("con avisos de webhooks o sincronización: la tienda queda creada y los avisos se ven", async () => {
    st.finishWarnings = ["Webhooks con problemas: APP_UNINSTALLED: x"];
    expect(await connectOwnAppStore({}, good({ name: "SH" }))).toEqual({
      warnings: ["Webhooks con problemas: APP_UNINSTALLED: x"],
      storeId: "new-store",
    });
    expect(storeWrites()[0]!.payload!.name).toBe("SH");
  });

  it("acepta la URL del admin y la normaliza", async () => {
    await expect(
      connectOwnAppStore({}, good({ shopify_domain: "https://admin.shopify.com/store/super-human-peru/orders" })),
    ).rejects.toThrow("REDIRECT:");
    expect(storeWrites()[0]!.payload!.shopify_domain).toBe(SHOP);
  });

  it("sin «Administrar tiendas» en esa organización: no hace nada", async () => {
    st.perms = [];
    expect(await connectOwnAppStore({}, good())).toEqual({
      error: "No tienes permiso para crear tiendas en esta organización.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(st.calls.filter((c) => c.op !== "select")).toEqual([]);
  });

  it("sin sesión: al login", async () => {
    st.user = null;
    await expect(connectOwnAppStore({}, good())).rejects.toThrow("REDIRECT:/login");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["superhuman.pe", "127.0.0.1", "super-human-peru.myshopify.com.evil.com", ""])(
    "dominio inválido (%j): no sale a la red ni escribe",
    async (domain) => {
      expect(await connectOwnAppStore({}, good({ shopify_domain: domain }))).toEqual({
        error: "Dominio de Shopify inválido. Debe ser tu-tienda.myshopify.com.",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(st.calls.filter((c) => c.op !== "select")).toEqual([]);
    },
  );

  it("sin Client ID o sin Client secret: no sale a la red", async () => {
    expect((await connectOwnAppStore({}, good({ client_id: "" }))).error).toContain("Client ID");
    expect((await connectOwnAppStore({}, good({ client_secret: "corto" }))).error).toContain("Client secret");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("un dominio que ya está en Kapta (Kenku, Aurela, clientes u otra propia): no la toca", async () => {
    st.existing = [{ id: "store-kenku" }];
    expect(await connectOwnAppStore({}, good({ shopify_domain: "kenku-peru.myshopify.com" }))).toEqual({
      error: "Esa tienda de Shopify ya está conectada a Kapta. No se cambió nada en ella.",
    });
    // Ni pide token (que acuñaría uno para una tienda ajena) ni escribe.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(st.calls.filter((c) => c.op !== "select")).toEqual([]);
    expect(st.finishArgs).toEqual([]);
  });

  it("si no se pudo comprobar el dominio, no sigue", async () => {
    st.existingError = { message: "timeout" };
    expect((await connectOwnAppStore({}, good())).error).toContain("No se creó nada");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("app sin todos los permisos: no conecta y nombra los que faltan", async () => {
    net.token.payload = { access_token: NEW_TOKEN, scope: "read_orders,read_draft_orders,write_draft_orders,read_products", expires_in: 86399 };
    const r = await connectOwnAppStore({}, good());
    expect(r.error).toContain("read_customers, write_orders");
    expect(storeWrites()).toEqual([]);
    expect(st.finishArgs).toEqual([]);
    expectNoSecrets(JSON.stringify(r));
  });

  it.each<[string, number, unknown, string]>([
    ["credenciales", 401, { error: "invalid_client", error_description: `bad ${SECRET}` }, "Client ID o el Client secret"],
    ["no instalada", 404, "Not Found", "no está instalada"],
    ["otra organización", 400, { error: "shop_not_permitted" }, "no es de la organización"],
  ])("Shopify niega el token (%s): lo dice sin repetir el secreto y no escribe", async (_l, status, payload, text) => {
    net.token = { status, payload };
    const r = await connectOwnAppStore({}, good());
    expect(r.error).toContain(text);
    expectNoSecrets(JSON.stringify(r) + logs.join("\n"));
    expect(storeWrites()).toEqual([]);
  });

  it("sin la 0271 (el CHECK viejo no acepta 'propia'): lo dice y no queda nada", async () => {
    st.insertError = { code: "23514", message: 'new row for relation "stores" violates check constraint "stores_shopify_app_check"' };
    expect(await connectOwnAppStore({}, good())).toEqual({ error: OWN_APP_MIGRATION_MISSING_MESSAGE });
    expect(st.finishArgs).toEqual([]);
    expect(st.calls.some((c) => c.table === "user_store_access")).toBe(false);
  });

  it("si otro la conectó a la vez (índice único): ya está conectada", async () => {
    st.insertError = { code: "23505", message: "duplicate key value violates unique constraint \"stores_own_app_shop_uniq\"" };
    expect((await connectOwnAppStore({}, good())).error).toBe(
      "Esa tienda de Shopify ya está conectada a Kapta. No se cambió nada en ella.",
    );
  });

  it("solo inserta: nunca actualiza ni borra una tienda", () => {
    const src = readFileSync(resolve(process.cwd(), "app/dashboard/stores/new/actions.ts"), "utf8");
    expect(src).not.toMatch(/\.update\(|\.upsert\(|\.delete\(/);
  });
});

// ── Ajustes ──────────────────────────────────────────────────────────────────

function propiaRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "store-propia",
    shopify_domain: SHOP,
    shopify_app: "propia",
    status: "active",
    shopify_client_id: CLIENT_ID,
    ...over,
  };
}

describe("saveOwnAppCredentials", () => {
  const fd = (over: Record<string, string> = {}) =>
    form({ store_id: "store-propia", own_client_id: CLIENT_ID, own_client_secret: SECRET, ...over });

  it("prueba el secreto y, si sirve, lo guarda cifrado (también como secreto de webhooks) con el token nuevo", async () => {
    st.row = propiaRow();
    expect(await saveOwnAppCredentials({}, fd())).toEqual({ notice: "Credenciales probadas y guardadas. Acceso renovado." });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const writes = storeWrites();
    expect(writes).toHaveLength(1);
    const p = writes[0]!.payload!;
    expect(decrypt(String(p.shopify_client_secret_enc))).toBe(SECRET);
    expect(decrypt(String(p.shopify_webhook_secret_enc))).toBe(SECRET);
    expect(decrypt(String(p.shopify_token_enc))).toBe(NEW_TOKEN);
    expect(p.shopify_client_id).toBe(CLIENT_ID);
    expect(p.shopify_token_error).toBeNull();
    expect(p).not.toHaveProperty("status");
    expect(writes[0]!.filters).toEqual([
      ["eq", "id", "store-propia"],
      ["eq", "shopify_app", "propia"],
    ]);
    expectNoSecrets(JSON.stringify(p) + logs.join("\n"));
  });

  it("si Shopify lo niega, no guarda nada", async () => {
    st.row = propiaRow();
    net.token = { status: 401, payload: { error: "invalid_client" } };
    const r = await saveOwnAppCredentials({}, fd());
    expect(r.error).toMatch(/^No se guardó: Shopify rechazó/);
    expect(storeWrites()).toEqual([]);
    expectNoSecrets(JSON.stringify(r));
  });

  it("con permisos de menos, no guarda", async () => {
    st.row = propiaRow();
    net.token.payload = { access_token: NEW_TOKEN, scope: "read_orders", expires_in: 86399 };
    expect((await saveOwnAppCredentials({}, fd())).error).toContain("No se guardó");
    expect(storeWrites()).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["Kenku (interna)", propiaRow({ id: "store-propia", shopify_app: "interna", shopify_client_id: null })],
    ["una de clientes", propiaRow({ shopify_app: "clientes", shopify_client_id: null })],
  ])("%s: no se toca", async (_l, row) => {
    st.row = row;
    expect(await saveOwnAppCredentials({}, fd())).toEqual({ error: "Esta tienda no está conectada con una app propia." });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storeWrites()).toEqual([]);
  });

  it("sin permiso: nada", async () => {
    st.row = propiaRow();
    st.perms = [];
    expect((await saveOwnAppCredentials({}, fd())).error).toContain("Sin permiso");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("una tienda deshabilitada sigue deshabilitada, y el aviso lo dice", async () => {
    st.row = propiaRow({ status: "disabled" });
    expect((await saveOwnAppCredentials({}, fd())).notice).toContain("sigue sin estar activa");
    expect(storeWrites()[0]!.payload).not.toHaveProperty("status");
  });
});

describe("renewOwnAppTokenNow", () => {
  it("en una 'propia' renueva; en Kenku no hace nada", async () => {
    st.row = { ...propiaRow(), shopify_client_secret_enc: encrypt(SECRET), shopify_token_enc: null, shopify_token_expires_at: null };
    expect(await renewOwnAppTokenNow({}, form({ store_id: "store-propia" }))).toEqual({ notice: "Acceso renovado." });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockClear();
    st.calls = [];
    st.row = propiaRow({ shopify_app: "interna" });
    expect((await renewOwnAppTokenNow({}, form({ store_id: "store-propia" }))).error).toContain("no está conectada con una app propia");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storeWrites()).toEqual([]);
  });
});

describe("reRegisterWebhooks", () => {
  const creds = (shopify_app: string) => ({ shopify_app, shopify_domain: SHOP, shopify_token: "tok" });

  it("Kenku y Aurela (interna) y clientes: exactamente como antes, sin temas extra", async () => {
    for (const app of ["interna", "clientes"]) {
      st.row = propiaRow({ shopify_app: app });
      st.creds = creds(app);
      st.registerArgs = [];
      await reRegisterWebhooks({}, form({ store_id: "store-propia" }));
      expect(st.registerArgs).toEqual([
        { domain: SHOP, token: "tok", callbackUrl: "https://kapta.test/api/webhooks/shopify/store-propia" },
      ]);
      expect(Object.keys(st.registerArgs[0] as object)).not.toContain("extraTopics");
    }
  });

  it("una 'propia' también registra app/uninstalled", async () => {
    st.row = propiaRow();
    st.creds = creds("propia");
    await reRegisterWebhooks({}, form({ store_id: "store-propia" }));
    expect(st.registerArgs).toEqual([
      {
        domain: SHOP,
        token: "tok",
        callbackUrl: "https://kapta.test/api/webhooks/shopify/store-propia",
        extraTopics: CLIENT_APP_WEBHOOK_TOPICS,
      },
    ]);
  });
});

// ── La pantalla ──────────────────────────────────────────────────────────────

describe("las pantallas", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const FORMS = read("components/forms.tsx");
  const NEW_PAGE = read("app/dashboard/stores/new/page.tsx");
  const SETTINGS = read("components/store-settings.tsx");
  const PAGE = read("app/dashboard/[storeId]/settings/page.tsx");

  it("«Conectar con app propia de Shopify» está al lado de crear una tienda, con el texto del MOM", () => {
    expect(NEW_PAGE).toContain("Conectar con app propia de Shopify");
    expect(NEW_PAGE).toContain("<ConnectOwnAppStoreForm orgs={orgs} scopes={OWN_APP_REQUIRED_SCOPES} />");
    expect(FORMS.replace(/\s+/g, " ")).toContain(
      "Para tiendas cuya organización de Shopify creó su propia app en el Dev Dashboard. Kapta renueva el acceso cada día.",
    );
    // El Client secret va en un campo de contraseña.
    expect(FORMS).toMatch(/name="client_secret"\s+type="password"/);
  });

  it("Ajustes nunca manda el Client secret ni el token al navegador", () => {
    expect(PAGE).toContain("hasSecret: Boolean(full.shopify_client_secret_enc)");
    expect(PAGE).not.toMatch(/decrypt/);
    const ownApp = PAGE.slice(PAGE.indexOf("ownApp:"), PAGE.indexOf(": null,", PAGE.indexOf("ownApp:")));
    expect(ownApp).not.toMatch(/shopify_client_secret_enc\s*[,}]|shopify_token_enc/);
    expect(SETTINGS).toMatch(/name="own_client_secret"\s+type="password"/);
  });

  it("una tienda 'propia' no ofrece «Reconectar con Shopify» (la app interna) ni el token a mano", () => {
    const section = SETTINGS.slice(SETTINGS.indexOf("function OwnAppShopifySection"), SETTINGS.indexOf("function KapsoSection"));
    expect(section).not.toContain("/api/shopify/install");
    expect(section).not.toContain('name="shopify_token"');
    expect(section).not.toContain('name="shopify_webhook_secret"');
    expect(section).toContain("{ownApp.statusLine}");
    expect(section).toContain("{ownApp.error}");
  });
});
