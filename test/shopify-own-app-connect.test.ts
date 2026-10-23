// Tiendas con su app propia de Shopify — conectar y Ajustes (MOM §36.2, §36.4).
//
// «Conectar con app propia de Shopify» (app/dashboard/stores/new/actions.ts):
// mismo permiso que crear una tienda; un dominio malo, uno que ya está en Kapta
// (con cualquier app) o una app sin todos los permisos se rechazan SIN escribir
// nada y sin tocar ninguna otra tienda (una interna sin token de la misma
// organización tiene su propio mensaje: soporte la pasa a app propia, nunca
// esta acción); si Kapta ya tiene la tienda solo se
// dice DESPUÉS de que Shopify dé un token (nadie averigua qué tiendas son de
// Kapta con credenciales inventadas); si Shopify niega el token, el mensaje lo
// dice sin repetir el secreto; y una conexión buena crea la tienda 'propia' con
// todo cifrado, registra los webhooks con `app/uninstalled` y sincroniza.
//
// Ajustes (app/dashboard/[storeId]/settings/actions.ts): el Client secret se
// prueba antes de guardarlo y solo en tiendas 'propia'; al rotarlo, el anterior
// sigue firmando webhooks un tiempo; con otra app (Client ID nuevo) se registran
// sus webhooks; «Re-registrar webhooks» suma `app/uninstalled` SOLO en una
// 'propia' (Kenku y Aurela se registran exactamente como antes); y ni Ajustes a
// mano ni el OAuth de la app interna pisan el token o el secreto de una
// 'propia'. Sin red: `fetch` es falso.

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
  registerResult: [{ topic: "ORDERS_CREATE", id: "gid://1" }] as Array<{ topic: string; id: string | null; error?: string }>,
  revalidated: [] as unknown[],
  /** El orden de lo que pasa: pedidos de token y consultas de `stores`. */
  seq: [] as string[],
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
      return st.registerResult;
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
    if (c.filters.some((f) => f[0] === "ilike")) {
      st.seq.push("lookup");
      return { data: st.existingError ? null : st.existing, error: st.existingError };
    }
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

import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { decrypt, encrypt, generateEncryptionKey } from "@/lib/crypto";
import { CLIENT_APP_WEBHOOK_TOPICS } from "@/lib/shopify";
import { OWN_APP_MIGRATION_MISSING_MESSAGE, OWN_APP_PREV_WEBHOOK_SECRET_GRACE_MS } from "@/lib/shopify-own-app";
import { connectOwnAppStore } from "@/app/dashboard/stores/new/actions";
import {
  clearOwnAppPreviousSecret,
  reRegisterWebhooks,
  renewOwnAppTokenNow,
  saveOwnAppCredentials,
  updateStore,
} from "@/app/dashboard/[storeId]/settings/actions";
import { GET as internalInstall } from "@/app/api/shopify/install/route";
import { GET as internalCallback } from "@/app/api/shopify/callback/route";

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
  st.registerResult = [{ topic: "ORDERS_CREATE", id: "gid://1" }];
  st.revalidated = [];
  st.seq = [];
  net = {
    token: { status: 200, payload: { access_token: NEW_TOKEN, scope: ALL_SCOPES, expires_in: 86399 } },
    shop: {
      status: 200,
      payload: { data: { shop: { name: "Súper Human Perú", currencyCode: "PEN", ianaTimezone: "America/Lima", myshopifyDomain: SHOP } } },
    },
  };
  fetchSpy = vi.fn(async (url: unknown) => {
    const isToken = String(url).endsWith("/admin/oauth/access_token");
    if (isToken) st.seq.push("token");
    return respond(isToken ? net.token : net.shop);
  });
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

const ALREADY_CONNECTED = "Esa tienda de Shopify ya está conectada a Kapta. No se cambió nada en ella.";
const SAME_ORG_TOKEN_FORM =
  "Esa tienda de Shopify ya está en esta organización, sin acceso a Shopify: se creó con «Crear tienda con token de Admin API». No se cambió nada: pídele a soporte de Kapta que la pase a app propia y después guarda el Client ID y el Client secret en sus Ajustes → Shopify → «Credenciales de la app» → «Probar y guardar».";

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
    // Primero el token (prueba que quien conecta tiene la app instalada en la
    // tienda); después, si el dominio ya está, en cualquier organización.
    expect(st.seq).toEqual(["token", "lookup"]);
    const lookup = st.calls.find((c) => c.table === "stores" && c.filters.some((f) => f[0] === "ilike"))!;
    expect(lookup.filters).toEqual([
      ["ilike", "shopify_domain", SHOP],
      ["limit", 20],
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
    // El vencimiento y la renovación salen del mismo reloj: exacto, siempre.
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
    st.existing = [{ id: "store-kenku", org_id: "org-kenku", shopify_app: "interna", shopify_token_enc: "enc:token-kenku" }];
    expect(await connectOwnAppStore({}, good({ shopify_domain: "kenku-peru.myshopify.com" }))).toEqual({ error: ALREADY_CONNECTED });
    // Se enteró después de que Shopify diera un token a la app de quien conecta
    // (que no le cambia nada a Kenku); no escribe ni registra nada.
    expect(st.seq).toEqual(["token", "lookup"]);
    expect(st.calls.filter((c) => c.op !== "select")).toEqual([]);
    expect(st.finishArgs).toEqual([]);
    expect(st.registerArgs).toEqual([]);
  });

  it("con credenciales inventadas no se averigua si una tienda es de Kapta", async () => {
    st.existing = [{ id: "store-kenku", org_id: "org-kenku", shopify_app: "interna", shopify_token_enc: "enc:token-kenku" }];
    net.token = { status: 401, payload: { error: "invalid_client" } };
    const r = await connectOwnAppStore({}, good({ shopify_domain: "kenku-peru.myshopify.com", client_id: "inventado1", client_secret: "inventado2" }));
    // El mismo rechazo de Shopify que con una tienda que no está en Kapta.
    expect(r.error).toContain("Shopify rechazó el Client ID o el Client secret");
    expect(r.error).not.toContain("Kapta");
    expect(st.seq).toEqual(["token"]);
    expect(st.calls.some((c) => c.filters.some((f) => f[0] === "ilike"))).toBe(false);
    expect(st.calls.filter((c) => c.op !== "select")).toEqual([]);
  });

  it("un dominio registrado en otra organización sin conexión: lo dice distinto y tampoco lo toca", async () => {
    st.existing = [{ id: "store-apartada", org_id: "org-otra", shopify_app: "interna", shopify_token_enc: null }];
    const r = await connectOwnAppStore({}, good());
    expect(r.error).toBe(
      "Esa tienda de Shopify está registrada en Kapta en otra organización, sin conexión. No se cambió nada: escríbele a soporte de Kapta para liberarla.",
    );
    expect(st.calls.filter((c) => c.op !== "select")).toEqual([]);
    expect(logs.join("\n")).toContain('"conectar":"dominio_ocupado"');
    expectNoSecrets(logs.join("\n"));
    // Con token, en esta organización o en otra, es «ya está conectada».
    for (const row of [
      { id: "s1", org_id: "org-sh", shopify_app: "interna", shopify_token_enc: "enc:x" },
      { id: "s2", org_id: "org-otra", shopify_app: "interna", shopify_token_enc: "enc:x" },
    ]) {
      st.existing = [row];
      expect((await connectOwnAppStore({}, good())).error).toBe(ALREADY_CONNECTED);
    }
  });

  it("en ESTA organización, interna y sin token (el formulario del token): pide a soporte pasarla a app propia y no la toca", async () => {
    st.existing = [{ id: "store-sin-token", org_id: "org-sh", shopify_app: "interna", shopify_token_enc: null }];
    const r = await connectOwnAppStore({}, good());
    expect(r).toEqual({ error: SAME_ORG_TOKEN_FORM });
    // Se enteró después del token, y no escribe, no registra ni sincroniza nada.
    expect(st.seq).toEqual(["token", "lookup"]);
    expect(st.calls.filter((c) => c.op !== "select")).toEqual([]);
    expect(st.finishArgs).toEqual([]);
    expect(st.registerArgs).toEqual([]);
    // Soporte la encuentra en el log, sin secretos.
    expect(logs.join("\n")).toContain('"mismaOrgSinToken":true');
    expect(logs.join("\n")).toContain("store-sin-token");
    expectNoSecrets(JSON.stringify(r) + logs.join("\n"));

    // Si otra fila del dominio tiene token, es «ya está conectada», como antes.
    st.existing = [
      { id: "store-sin-token", org_id: "org-sh", shopify_app: "interna", shopify_token_enc: null },
      { id: "store-otra", org_id: "org-otra", shopify_app: "clientes", shopify_token_enc: "enc:x" },
    ];
    expect((await connectOwnAppStore({}, good())).error).toBe(ALREADY_CONNECTED);
    // Una propia o de clientes sin token en esta organización (desinstalada) no
    // salió del formulario del token: tampoco cambia.
    for (const app of ["propia", "clientes"]) {
      st.existing = [{ id: `store-${app}`, org_id: "org-sh", shopify_app: app, shopify_token_enc: null }];
      expect((await connectOwnAppStore({}, good())).error, app).toBe(ALREADY_CONNECTED);
    }
    expect(st.calls.filter((c) => c.op !== "select")).toEqual([]);
  });

  it("si no se pudo comprobar el dominio, no sigue", async () => {
    st.existingError = { message: "timeout" };
    expect((await connectOwnAppStore({}, good())).error).toContain("No se creó nada");
    expect(storeWrites()).toEqual([]);
    expect(st.finishArgs).toEqual([]);
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
    // Ni siquiera pregunta si la tienda ya está en Kapta.
    expect(st.seq).toEqual(["token"]);
  });

  it("sin la 0271 (el CHECK viejo no acepta 'propia'): lo dice y no queda nada", async () => {
    st.insertError = { code: "23514", message: 'new row for relation "stores" violates check constraint "stores_shopify_app_check"' };
    expect(await connectOwnAppStore({}, good())).toEqual({ error: OWN_APP_MIGRATION_MISSING_MESSAGE });
    expect(st.finishArgs).toEqual([]);
    expect(st.calls.some((c) => c.table === "user_store_access")).toBe(false);
  });

  it("si otro la conectó a la vez (índice único): ya está conectada", async () => {
    st.insertError = { code: "23505", message: "duplicate key value violates unique constraint \"stores_own_app_shop_uniq\"" };
    expect((await connectOwnAppStore({}, good())).error).toBe(ALREADY_CONNECTED);
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
    st.row = propiaRow({ shopify_webhook_secret_enc: encrypt(SECRET) });
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
    expect(p.shopify_token_retry_at).toBeNull();
    expect(p).not.toHaveProperty("status");
    // El mismo secreto otra vez: no hay «anterior» que guardar ni borrar.
    expect(p).not.toHaveProperty("shopify_webhook_secret_prev_enc");
    expect(p).not.toHaveProperty("shopify_webhook_secret_prev_set_at");
    // La misma app: no vuelve a registrar webhooks.
    expect(st.registerArgs).toEqual([]);
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

  it("en pausa: guarda y renueva como una activa", async () => {
    st.row = propiaRow({ status: "paused", shopify_webhook_secret_enc: encrypt(SECRET) });
    expect(await saveOwnAppCredentials({}, fd())).toEqual({ notice: "Credenciales probadas y guardadas. Acceso renovado." });
  });

  it("rotar el secreto (mismo Client ID): el anterior queda aparte, 48 h, y el aviso dice qué hacer", async () => {
    const OLD = "shpss_secreto-anterior-9876543210";
    const oldEnc = encrypt(OLD);
    st.row = propiaRow({ shopify_webhook_secret_enc: oldEnc, timezone: "America/Lima" });
    const before = Date.now();
    const r = await saveOwnAppCredentials({}, fd());
    expect(r.notice).toContain("Kapta acepta también el secreto anterior en los webhooks hasta el");
    expect(r.notice).toContain("revócalo ahora en el Dev Dashboard");
    expect(r.notice).toContain("«Ya revoqué el secreto anterior»");
    const p = storeWrites()[0]!.payload!;
    // El anterior, tal cual estaba cifrado; el nuevo, en los dos campos.
    expect(p.shopify_webhook_secret_prev_enc).toBe(oldEnc);
    expect(decrypt(String(p.shopify_webhook_secret_enc))).toBe(SECRET);
    const setAt = Date.parse(String(p.shopify_webhook_secret_prev_set_at));
    expect(setAt).toBeGreaterThanOrEqual(before);
    expect(setAt).toBeLessThanOrEqual(Date.now());
    expect(st.registerArgs).toEqual([]);
    expectNoSecrets(JSON.stringify(r));
    expect(JSON.stringify(r)).not.toContain(OLD);
    expect(OWN_APP_PREV_WEBHOOK_SECRET_GRACE_MS).toBe(48 * 60 * 60 * 1000);
  });

  it("otra app (Client ID nuevo): no acepta el secreto de la anterior y registra los webhooks de la nueva", async () => {
    st.row = propiaRow({ shopify_client_id: "client-id-de-la-app-anterior", shopify_webhook_secret_enc: encrypt("shpss_de-la-anterior") });
    const r = await saveOwnAppCredentials({}, fd());
    expect(r.notice).toContain("sus webhooks registrados");
    expect(r.notice).toContain("Desinstala la app anterior");
    const p = storeWrites()[0]!.payload!;
    expect(p.shopify_client_id).toBe(CLIENT_ID);
    expect(p.shopify_webhook_secret_prev_enc).toBeNull();
    expect(p.shopify_webhook_secret_prev_set_at).toBeNull();
    expect(st.registerArgs).toEqual([
      {
        domain: SHOP,
        token: NEW_TOKEN,
        callbackUrl: "https://kapta.test/api/webhooks/shopify/store-propia",
        extraTopics: CLIENT_APP_WEBHOOK_TOPICS,
      },
    ]);
  });

  it("otra app con webhooks que fallan: guardó, y dice que los re-registre", async () => {
    st.row = propiaRow({ shopify_client_id: "client-id-de-la-app-anterior" });
    st.registerResult = [{ topic: "APP_UNINSTALLED", id: null, error: "boom" }];
    const r = await saveOwnAppCredentials({}, fd());
    expect(r.error).toContain("probadas y guardadas");
    expect(r.error).toContain("APP_UNINSTALLED: boom");
    expect(r.error).toContain("«Re-registrar webhooks»");
    expect(storeWrites()).toHaveLength(1);
  });

  it("otra app en una tienda deshabilitada: guarda, sin registrar webhooks", async () => {
    st.row = propiaRow({ status: "disabled", shopify_client_id: "client-id-de-la-app-anterior" });
    expect((await saveOwnAppCredentials({}, fd())).notice).toContain("sigue sin estar activa");
    expect(st.registerArgs).toEqual([]);
  });

  it("la que soporte pasó a app propia (sin Client ID guardado): registra webhooks y no pide desinstalar ninguna «anterior»", async () => {
    // MOM §36.2: era 'interna' sin token; la única app instalada es la propia.
    st.row = propiaRow({ shopify_client_id: null, shopify_webhook_secret_enc: null });
    expect(await saveOwnAppCredentials({}, fd())).toEqual({
      notice: "Credenciales probadas y guardadas, y los webhooks registrados. Acceso renovado.",
    });
    const p = storeWrites()[0]!.payload!;
    expect(p.shopify_client_id).toBe(CLIENT_ID);
    expect(decrypt(String(p.shopify_webhook_secret_enc))).toBe(SECRET);
    expect(p.shopify_webhook_secret_prev_enc).toBeNull();
    expect(st.registerArgs).toEqual([
      {
        domain: SHOP,
        token: NEW_TOKEN,
        callbackUrl: "https://kapta.test/api/webhooks/shopify/store-propia",
        extraTopics: CLIENT_APP_WEBHOOK_TOPICS,
      },
    ]);
    // Con webhooks que fallan: que los re-registre, sin «desinstala la app anterior».
    st.calls = [];
    st.registerArgs = [];
    st.registerResult = [{ topic: "APP_UNINSTALLED", id: null, error: "boom" }];
    const r = await saveOwnAppCredentials({}, fd());
    expect(r.error).toBe(
      "Credenciales probadas y guardadas, pero los webhooks tuvieron problemas: APP_UNINSTALLED: boom. Pulsa «Re-registrar webhooks».",
    );
    expect(JSON.stringify(r)).not.toContain("anterior");
    expectNoSecrets(JSON.stringify(r) + logs.join("\n"));
  });
});

describe("clearOwnAppPreviousSecret («Ya revoqué el secreto anterior»)", () => {
  it("en una 'propia' borra el anterior; en Kenku no hace nada", async () => {
    st.row = propiaRow();
    expect(await clearOwnAppPreviousSecret({}, form({ store_id: "store-propia" }))).toEqual({
      notice: "Listo: Kapta ya solo acepta webhooks firmados con el Client secret actual.",
    });
    const w = storeWrites();
    expect(w).toHaveLength(1);
    expect(w[0]!.payload).toEqual({ shopify_webhook_secret_prev_enc: null, shopify_webhook_secret_prev_set_at: null });
    expect(w[0]!.filters).toEqual([
      ["eq", "id", "store-propia"],
      ["eq", "shopify_app", "propia"],
    ]);

    st.calls = [];
    st.row = propiaRow({ shopify_app: "interna" });
    expect((await clearOwnAppPreviousSecret({}, form({ store_id: "store-propia" }))).error).toContain("no está conectada con una app propia");
    expect(storeWrites()).toEqual([]);
  });
});

describe("una tienda 'propia' no recibe el token ni el secreto de webhooks a mano", () => {
  it.each(["shopify_token", "shopify_webhook_secret"])("Ajustes → %s en una propia: no guarda nada", async (field) => {
    st.row = propiaRow();
    const r = await updateStore({}, form({ store_id: "store-propia", [field]: "pegado-a-mano-123" }));
    expect(r.error).toContain("usa su app propia de Shopify");
    expect(storeWrites()).toEqual([]);
  });

  it("Kenku (interna): el secreto HMAC a mano se guarda como siempre", async () => {
    st.row = propiaRow({ shopify_app: "interna", shopify_client_id: null });
    expect(await updateStore({}, form({ store_id: "store-propia", shopify_webhook_secret: "secreto-nuevo-kenku" }))).toEqual({
      notice: "Tienda actualizada.",
    });
    const w = storeWrites();
    expect(w).toHaveLength(1);
    expect(decrypt(String(w[0]!.payload!.shopify_webhook_secret_enc))).toBe("secreto-nuevo-kenku");
  });

  const API_SECRET = "secreto-de-la-app-interna";
  function callbackReq(storeId: string) {
    const params = new URLSearchParams({ code: "codigo", shop: SHOP, state: `${storeId}.abc`, timestamp: "1" });
    const sorted = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("&");
    params.set("hmac", createHmac("sha256", API_SECRET).update(sorted).digest("hex"));
    return new NextRequest(`https://kapta.test/api/shopify/callback?${params}`, {
      headers: { cookie: `shopify_oauth_state=${storeId}.abc` },
    });
  }

  it("el OAuth de la app interna no instala ni reconecta una 'propia'", async () => {
    vi.stubEnv("SHOPIFY_APP_API_KEY", "clave-app-interna");
    vi.stubEnv("SHOPIFY_APP_API_SECRET", API_SECRET);
    st.row = propiaRow();
    const install = await internalInstall(new NextRequest("https://kapta.test/api/shopify/install?storeId=store-propia"));
    expect(install.status).toBe(409);
    const cb = await internalCallback(callbackReq("store-propia"));
    expect(cb.headers.get("location")).toContain("shopify_error=app-propia");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storeWrites()).toEqual([]);
  });

  it("Kenku (interna): el OAuth de la app interna sigue igual", async () => {
    vi.stubEnv("SHOPIFY_APP_API_KEY", "clave-app-interna");
    vi.stubEnv("SHOPIFY_APP_API_SECRET", API_SECRET);
    st.row = propiaRow({ shopify_app: "interna", shopify_client_id: null });
    const install = await internalInstall(new NextRequest("https://kapta.test/api/shopify/install?storeId=store-propia"));
    expect(install.headers.get("location")).toContain(`https://${SHOP}/admin/oauth/authorize`);
    const cb = await internalCallback(callbackReq("store-propia"));
    expect(cb.headers.get("location")).toContain("installed=1");
    const w = storeWrites();
    expect(w).toHaveLength(1);
    expect(decrypt(String(w[0]!.payload!.shopify_webhook_secret_enc))).toBe(API_SECRET);
    expect(w[0]!.payload!.status).toBe("active");
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
    // Primero la app propia; cada camino con su título, y el del token de
    // Admin API dice a quién NO le sirve.
    const own = NEW_PAGE.indexOf("<ConnectOwnAppStoreForm");
    const legacy = NEW_PAGE.indexOf("<CreateStoreForm");
    expect(own).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(own);
    const flatPage = NEW_PAGE.replace(/\s+/g, " ");
    expect(flatPage).toContain("Dev Dashboard: Client ID + Client secret.");
    expect(flatPage).toContain("Crear tienda con token de Admin API");
    expect(flatPage).toContain(
      "Si tienes Client ID y Client secret del Dev Dashboard, usa «Conectar con app propia de Shopify», arriba.",
    );
    expect(NEW_PAGE.slice(legacy - 600, legacy)).toContain("<h2");
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
    expect(section).toContain("{ownApp.hint}");
    expect(section).toContain("{ownApp.error}");
    // El título sale del contenido: permisos que faltan no es «falló».
    expect(section).toContain("title={ownApp.errorTitle}");
    expect(section).not.toContain('title="La última renovación falló"');
    // A una deshabilitada no se le ofrece «Renovar ahora».
    expect(section).toMatch(/\{ownApp\.disabled \? null : \(\s*<ActionRow\s+action=\{renewOwnAppTokenNow\}/);
    // Mientras vale el secreto anterior, el botón para confirmar que se revocó.
    expect(section).toMatch(/\{ownApp\.prevSecretUntil \? \(\s*<ActionRow\s+action=\{clearOwnAppPreviousSecret\}/);
  });

  it("Ajustes manda una tienda 'propia' a su sección: nunca a la de la app interna", () => {
    // La primera línea de ShopifySection despacha a OwnAppShopifySection; sin
    // ella, una propia vería «Reconectar con Shopify» y el secreto HMAC a mano.
    expect(SETTINGS).toMatch(
      /function ShopifySection\(\{ data \}: \{ data: StoreSettingsData \}\) \{\s*if \(data\.ownApp\) return <OwnAppShopifySection data=\{data\} ownApp=\{data\.ownApp\} \/>;/,
    );
    // Y la página llena `ownApp` justo para las tiendas 'propia' (null en las demás).
    expect(PAGE.replace(/\s+/g, " ")).toMatch(/ownApp: full\.shopify_app === OWN_APP \? \{/);
    const ownApp = PAGE.slice(PAGE.indexOf("ownApp:"), PAGE.indexOf("leadVoice: {", PAGE.indexOf("ownApp:")));
    expect(ownApp.replace(/\s+/g, " ")).toMatch(/\} : null, (\/\/[^\n]*)?/);
    for (const key of ["statusLine:", "hint:", "disabled:", "errorTitle:", "prevSecretUntil:"]) expect(ownApp).toContain(key);
  });
});
