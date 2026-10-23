// Tiendas con su app propia de Shopify — lib/shopify-own-app.ts (MOM §36).
//
// Lo que se fija aquí: el pedido del token (client credentials grant) y cómo se
// lee cada respuesta de Shopify; que ningún mensaje ni log repita el Client
// secret o el token; los alcances (un write_X cuenta como read_X); cuándo se
// renueva; que la renovación solo escriba en tiendas 'propia' y activas, nunca
// cambie un token por otro que vence antes y, si falla, deje el motivo sin
// tocar el token; y que `getStoreCreds` y la lectura para comprobantes renueven
// SOLO las tiendas 'propia': Kenku y Aurela ('interna') y las de la app de
// clientes no piden token, ni consultan nada de más (owner, 23-10-2026: «no
// vayas a desconectar nada»). Aquí no sale nada a la red: `fetch` es falso.

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decrypt, encrypt, generateEncryptionKey } from "@/lib/crypto";
import {
  isOwnAppMigrationMissing,
  missingScopes,
  missingScopesMessage,
  normalizeShopDomain,
  OWN_APP_RENEW_BEFORE_MS,
  OWN_APP_RENEW_ON_USE_MS,
  OWN_APP_REQUIRED_SCOPES,
  OWN_APP_TOKEN_TTL_FALLBACK_SECONDS,
  ownAppStatusLine,
  ownAppTokenForUse,
  parseScopes,
  renewOwnAppToken,
  requestClientCredentialsToken,
  shouldRenew,
  tokenExpiresAt,
} from "@/lib/shopify-own-app";
import { SHOPIFY_CLIENT_APP_SCOPES } from "@/lib/shopify";
import { getStoreCreds } from "@/lib/ingest";
import { fetchOrderForInvoice } from "@/lib/invoicing/shopify-order";

const SHOP = "super-human-peru.myshopify.com";
const CLIENT_ID = "0123456789abcdef0123456789abcdef";
const SECRET = "shpss_secreto-de-prueba-0123456789";
const OLD_TOKEN = "shpat_token-viejo-0000000000";
const NEW_TOKEN = "shpat_token-nuevo-1111111111";
const ALL_SCOPES = SHOPIFY_CLIENT_APP_SCOPES;
const NOW = new Date("2026-10-23T15:00:00.000Z"); // 10:00 en Lima
const HOUR = 60 * 60 * 1000;

// Antes de recoger las pruebas: las tablas de `it.each` ya cifran.
process.env.ENCRYPTION_KEY = generateEncryptionKey();

// ── Fakes ────────────────────────────────────────────────────────────────────

type Filter = [method: string, ...args: unknown[]];
interface Call {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  cols?: string;
  payload?: Record<string, unknown>;
  filters: Filter[];
}
type Reply = { data: unknown; error: unknown };

/** Un cliente de Supabase falso que anota cada llamada y contesta con `reply`. */
function fakeAdmin(reply: (c: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, op: "select", filters: [] };
    calls.push(call);
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
  return { admin: { from } as unknown as SupabaseClient, calls };
}

/** Una tienda como la guarda la base (con la 0271). */
function storeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "store-propia",
    org_id: "org-sh",
    name: "Súper Human Perú",
    shopify_domain: SHOP,
    shopify_app: "propia",
    status: "active",
    shopify_token_enc: encrypt(OLD_TOKEN),
    shopify_webhook_secret_enc: encrypt(SECRET),
    shopify_client_id: CLIENT_ID,
    shopify_client_secret_enc: encrypt(SECRET),
    shopify_token_expires_at: new Date(NOW.getTime() + 5 * 60 * 1000).toISOString(),
    shopify_token_renewed_at: new Date(NOW.getTime() - 24 * HOUR).toISOString(),
    shopify_token_error: null,
    currency: "PEN",
    timezone: "America/Lima",
    ...over,
  };
}

/** Kenku: app interna, token fijo, sin nada de la 0271. */
function kenkuRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "store-kenku",
    org_id: "org-kenku",
    name: "Kenku Peru",
    shopify_domain: "kenku-peru.myshopify.com",
    shopify_app: "interna",
    status: "active",
    shopify_token_enc: encrypt(OLD_TOKEN),
    shopify_webhook_secret_enc: encrypt("secreto-interna"),
    shopify_client_id: null,
    shopify_client_secret_enc: null,
    shopify_token_expires_at: null,
    shopify_token_renewed_at: null,
    shopify_token_error: null,
    currency: "PEN",
    timezone: "America/Lima",
    ...over,
  };
}

interface FetchCall {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

function jsonResponse(status: number, payload: unknown): Response {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

/** `fetch` falso: el pedido del token contesta `token`; GraphQL contesta `graphql`. */
function fakeFetch(
  token: () => Response = () =>
    jsonResponse(200, { access_token: NEW_TOKEN, scope: ALL_SCOPES, expires_in: 86399 }),
  graphql: () => Response = () => jsonResponse(200, { data: {} }),
) {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as FetchCall["init"] });
    return String(url).endsWith("/admin/oauth/access_token") ? token() : graphql();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const logs: string[] = [];
beforeEach(() => {
  logs.length = 0;
  for (const level of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function expectNoSecrets(text: string) {
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(NEW_TOKEN);
  expect(text).not.toContain(OLD_TOKEN);
}

// ── Puras ────────────────────────────────────────────────────────────────────

describe("alcances", () => {
  it("son los de la app de clientes: seis, en el mismo orden", () => {
    expect(OWN_APP_REQUIRED_SCOPES).toEqual([
      "read_orders",
      "read_draft_orders",
      "write_draft_orders",
      "read_products",
      "read_customers",
      "write_orders",
    ]);
  });

  it("parseScopes acepta comas, espacios, mayúsculas y listas; quita repetidos", () => {
    expect(parseScopes("read_orders, write_orders,read_orders")).toEqual(["read_orders", "write_orders"]);
    expect(parseScopes("READ_Products  read_customers")).toEqual(["read_products", "read_customers"]);
    expect(parseScopes(["write_orders"])).toEqual(["write_orders"]);
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes(42)).toEqual([]);
  });

  it("con todos, no falta ninguno", () => {
    expect(missingScopes(ALL_SCOPES.split(","))).toEqual([]);
  });

  it("write_X cuenta como read_X (pero no al revés)", () => {
    expect(missingScopes(["write_orders", "write_draft_orders", "read_products", "read_customers"])).toEqual([]);
    expect(missingScopes(["read_orders", "read_draft_orders", "read_products", "read_customers"])).toEqual([
      "write_draft_orders",
      "write_orders",
    ]);
  });

  it("nombra los que faltan, en el orden del contrato", () => {
    expect(missingScopes([])).toEqual([...OWN_APP_REQUIRED_SCOPES]);
    expect(missingScopes(["read_orders", "write_orders", "write_draft_orders"])).toEqual(["read_products", "read_customers"]);
    expect(missingScopesMessage(["read_customers", "write_orders"])).toContain("read_customers, write_orders");
  });
});

describe("shouldRenew", () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  it("sin fecha o con una que no se entiende: renueva", () => {
    expect(shouldRenew(null, NOW, OWN_APP_RENEW_ON_USE_MS)).toBe(true);
    expect(shouldRenew(undefined, NOW, OWN_APP_RENEW_ON_USE_MS)).toBe(true);
    expect(shouldRenew("no es fecha", NOW, OWN_APP_RENEW_ON_USE_MS)).toBe(true);
  });

  it("vencido o dentro del margen: renueva; fuera del margen: no", () => {
    expect(shouldRenew(at(-1), NOW, OWN_APP_RENEW_ON_USE_MS)).toBe(true);
    expect(shouldRenew(at(OWN_APP_RENEW_ON_USE_MS), NOW, OWN_APP_RENEW_ON_USE_MS)).toBe(true);
    expect(shouldRenew(at(OWN_APP_RENEW_ON_USE_MS + 1), NOW, OWN_APP_RENEW_ON_USE_MS)).toBe(false);
    expect(shouldRenew(at(11 * HOUR).toISOString(), NOW, OWN_APP_RENEW_BEFORE_MS)).toBe(true);
    expect(shouldRenew(at(13 * HOUR).toISOString(), NOW, OWN_APP_RENEW_BEFORE_MS)).toBe(false);
  });

  it("los dos márgenes: 12 horas el cron, 15 minutos al usar", () => {
    expect(OWN_APP_RENEW_BEFORE_MS).toBe(12 * HOUR);
    expect(OWN_APP_RENEW_ON_USE_MS).toBe(15 * 60 * 1000);
  });
});

describe("tokenExpiresAt", () => {
  const plus = (s: number) => new Date(NOW.getTime() + s * 1000).toISOString();

  it("usa expires_in de Shopify", () => {
    expect(tokenExpiresAt(86399, NOW).toISOString()).toBe(plus(86399));
    expect(tokenExpiresAt("3600", NOW).toISOString()).toBe(plus(3600));
  });

  it.each<[string, unknown]>([
    ["sin dato", undefined],
    ["null", null],
    ["texto", "mañana"],
    ["cero", 0],
    ["negativo", -5],
    ["infinito", Infinity],
  ])("sin un expires_in válido asume 24 h (%s)", (_l, v) => {
    expect(tokenExpiresAt(v, NOW).toISOString()).toBe(plus(OWN_APP_TOKEN_TTL_FALLBACK_SECONDS));
  });

  it("nunca más de 24 h: renovar antes no cuesta nada", () => {
    expect(tokenExpiresAt(10 * 86400, NOW).toISOString()).toBe(plus(86400));
  });
});

describe("normalizeShopDomain", () => {
  it.each<[string, string]>([
    ["super-human-peru.myshopify.com", SHOP],
    ["  Super-Human-Peru.MyShopify.com ", SHOP],
    ["https://super-human-peru.myshopify.com/admin/orders", SHOP],
    ["https://admin.shopify.com/store/super-human-peru/orders", SHOP],
    ["admin.shopify.com/store/super-human-peru", SHOP],
  ])("%s → %s", (raw, want) => {
    expect(normalizeShopDomain(raw)).toBe(want);
  });

  it.each(["", "superhuman.pe", "127.0.0.1", "super-human-peru.myshopify.com.evil.com", "evil.com/x.myshopify.com", "a_b.myshopify.com"])(
    "rechaza %j",
    (raw) => {
      expect(normalizeShopDomain(raw)).toBeNull();
    },
  );
});

describe("isOwnAppMigrationMissing", () => {
  it("una columna nueva que no existe, o el CHECK viejo sin 'propia'", () => {
    expect(isOwnAppMigrationMissing({ code: "42703", message: 'column stores.shopify_client_id does not exist' })).toBe(true);
    expect(
      isOwnAppMigrationMissing({ code: "PGRST204", message: "Could not find the 'shopify_token_expires_at' column of 'stores' in the schema cache" }),
    ).toBe(true);
    expect(
      isOwnAppMigrationMissing({
        code: "23514",
        message: 'new row for relation "stores" violates check constraint "stores_shopify_app_check"',
      }),
    ).toBe(true);
  });

  it("otro error no se disfraza de «falta la migración»", () => {
    expect(isOwnAppMigrationMissing({ code: "42703", message: "column stores.otra does not exist" })).toBe(false);
    expect(isOwnAppMigrationMissing({ code: "23505", message: "duplicate key stores_own_app_shop_uniq" })).toBe(false);
    expect(isOwnAppMigrationMissing({ code: "23514", message: 'violates check constraint "stores_own_app_columns_check"' })).toBe(false);
    expect(isOwnAppMigrationMissing(null)).toBe(false);
    expect(isOwnAppMigrationMissing("x")).toBe(false);
  });
});

describe("ownAppStatusLine", () => {
  it("renovado hace X y vence a las HH:MM, en la hora de la tienda", () => {
    expect(
      ownAppStatusLine({
        renewedAt: new Date(NOW.getTime() - 35 * 60 * 1000).toISOString(),
        expiresAt: "2026-10-23T19:20:00.000Z",
        now: NOW,
        timeZone: "America/Lima",
      }),
    ).toBe("App propia · acceso renovado hace 35 min · vence a las 14:20");
  });

  it("si vence mañana, lo dice", () => {
    expect(
      ownAppStatusLine({
        renewedAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
        expiresAt: "2026-10-24T13:00:00.000Z",
        now: NOW,
      }),
    ).toBe("App propia · acceso renovado hace 2 h · vence mañana a las 08:00");
  });

  it("sin renovación todavía, o ya vencido", () => {
    expect(ownAppStatusLine({ renewedAt: null, expiresAt: null, now: NOW })).toBe("App propia · acceso aún sin renovar");
    expect(
      ownAppStatusLine({ renewedAt: "2026-10-22T10:00:00.000Z", expiresAt: "2026-10-23T14:00:00.000Z", now: NOW }),
    ).toBe("App propia · acceso renovado hace 29 h · venció a las 09:00");
  });
});

// ── El pedido del token ──────────────────────────────────────────────────────

describe("requestClientCredentialsToken", () => {
  it("POST con formulario a /admin/oauth/access_token de la tienda, sin seguir redirecciones y con tope", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const r = await requestClientCredentialsToken({ shop: SHOP, clientId: CLIENT_ID, clientSecret: SECRET, fetchImpl, now: NOW });
    expect(r).toEqual({
      ok: true,
      token: NEW_TOKEN,
      scopes: [...OWN_APP_REQUIRED_SCOPES],
      expiresAt: new Date(NOW.getTime() + 86399 * 1000),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
  });

  it("sin expires_in asume 24 h", async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(200, { access_token: NEW_TOKEN, scope: ALL_SCOPES }));
    const r = await requestClientCredentialsToken({ shop: SHOP, clientId: CLIENT_ID, clientSecret: SECRET, fetchImpl, now: NOW });
    expect(r.ok && r.expiresAt.toISOString()).toBe(new Date(NOW.getTime() + 24 * HOUR).toISOString());
  });

  it.each<[string, Response]>([
    ["sin access_token", jsonResponse(200, { scope: ALL_SCOPES })],
    ["access_token vacío", jsonResponse(200, { access_token: " " })],
    ["no es JSON", jsonResponse(200, "<html>hola</html>")],
  ])("200 %s es respuesta_invalida", async (_l, res) => {
    const { fetchImpl } = fakeFetch(() => res);
    const r = await requestClientCredentialsToken({ shop: SHOP, clientId: CLIENT_ID, clientSecret: SECRET, fetchImpl });
    expect(r).toMatchObject({ ok: false, reason: "respuesta_invalida" });
  });

  it.each<[string, number, unknown, string, string]>([
    ["credenciales malas", 401, { error: "invalid_client", error_description: "Client authentication failed" }, "credenciales", "Client ID o el Client secret"],
    ["400 sin más", 400, { error: "invalid_request" }, "credenciales", "Client ID o el Client secret"],
    ["otra organización", 400, { error: "shop_not_permitted", error_description: "Client credentials cannot be performed on this shop." }, "otra_organizacion", "no es de la organización"],
    ["403", 403, "Forbidden", "otra_organizacion", "no es de la organización"],
    ["app no instalada", 400, { error: "app_not_installed" }, "no_instalada", "no está instalada"],
    ["404", 404, "Not Found", "no_instalada", "no está instalada"],
    ["redirección", 302, "", "no_instalada", "no está instalada"],
    ["Shopify caído", 503, "Service Unavailable", "red", "Intenta de nuevo"],
    ["demasiadas", 429, { errors: "Throttled" }, "red", "Intenta de nuevo"],
  ])("%s → %s", async (_l, status, payload, reason, text) => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(status, payload));
    const r = await requestClientCredentialsToken({ shop: SHOP, clientId: CLIENT_ID, clientSecret: SECRET, fetchImpl });
    expect(r).toMatchObject({ ok: false, reason });
    expect(!r.ok && r.message).toContain(text);
    expect(!r.ok && r.message).toContain(`HTTP ${status}`);
  });

  it("la red caída y el tiempo agotado son «red»", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await requestClientCredentialsToken({ shop: SHOP, clientId: CLIENT_ID, clientSecret: SECRET, fetchImpl: down })).toEqual({
      ok: false,
      reason: "red",
      message: "No se pudo conectar con Shopify. Intenta de nuevo.",
    });
    const slow = vi.fn(async () => {
      throw new DOMException("timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    expect(await requestClientCredentialsToken({ shop: SHOP, clientId: CLIENT_ID, clientSecret: SECRET, fetchImpl: slow })).toMatchObject({
      reason: "red",
      message: "Shopify no respondió a tiempo. Intenta de nuevo.",
    });
  });

  it("nunca repite el secreto ni el cuerpo de la respuesta, aunque Shopify los devuelva", async () => {
    const echo = { error: `invalid_client ${SECRET}`, error_description: `bad secret ${SECRET} token ${NEW_TOKEN}` };
    const { fetchImpl } = fakeFetch(() => jsonResponse(401, echo));
    const r = await requestClientCredentialsToken({ shop: SHOP, clientId: CLIENT_ID, clientSecret: SECRET, fetchImpl });
    expect(r.ok).toBe(false);
    expectNoSecrets(JSON.stringify(r));
    expect(JSON.stringify(r)).not.toContain("bad secret");
    // Un código raro (con espacios o el secreto) no se cita.
    expect(!r.ok && r.message).toContain("(HTTP 401)");
    expectNoSecrets(logs.join("\n"));
  });

  it("un dominio que no es *.myshopify.com no sale a la red", async () => {
    const { fetchImpl, calls } = fakeFetch();
    for (const shop of ["169.254.169.254", "evil.com", "super-human-peru.myshopify.com.evil.com"]) {
      expect(await requestClientCredentialsToken({ shop, clientId: CLIENT_ID, clientSecret: SECRET, fetchImpl })).toMatchObject({
        ok: false,
        reason: "credenciales",
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("sin Client ID o sin Client secret no sale a la red", async () => {
    const { fetchImpl, calls } = fakeFetch();
    expect(await requestClientCredentialsToken({ shop: SHOP, clientId: "", clientSecret: SECRET, fetchImpl })).toMatchObject({ ok: false });
    expect(await requestClientCredentialsToken({ shop: SHOP, clientId: CLIENT_ID, clientSecret: " ", fetchImpl })).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });
});

// ── La renovación ────────────────────────────────────────────────────────────

describe("renewOwnAppToken", () => {
  function db(row: Record<string, unknown> | null, opts: { updated?: unknown[]; readError?: unknown; saveError?: unknown } = {}) {
    return fakeAdmin((c) => {
      if (c.table !== "stores") return { data: null, error: null };
      if (c.op === "select") return opts.readError ? { data: null, error: opts.readError } : { data: row, error: null };
      if (c.op === "update" && "shopify_token_enc" in (c.payload ?? {})) {
        return opts.saveError ? { data: null, error: opts.saveError } : { data: opts.updated ?? [{ id: row?.id }], error: null };
      }
      return { data: null, error: null };
    });
  }
  const writes = (calls: Call[]) => calls.filter((c) => c.op !== "select");

  it("renueva y guarda cifrado, con condición: propia, activa y sin uno que venza después", async () => {
    const { admin, calls } = db(storeRow());
    const { fetchImpl, calls: net } = fakeFetch();
    const r = await renewOwnAppToken(admin, "store-propia", { fetchImpl, now: NOW });
    const expiresAt = new Date(NOW.getTime() + 86399 * 1000);
    expect(r).toEqual({ ok: true, token: NEW_TOKEN, expiresAt, renewed: true, stored: true, missingScopes: [] });
    expect(net).toHaveLength(1);
    // Pide el token con el secreto descifrado de la tienda.
    expect(new URLSearchParams(String(net[0]!.init.body)).get("client_secret")).toBe(SECRET);

    const [save, ...rest] = writes(calls);
    expect(rest).toEqual([]);
    expect(save!.op).toBe("update");
    expect(Object.keys(save!.payload!).sort()).toEqual(
      ["shopify_token_enc", "shopify_token_error", "shopify_token_expires_at", "shopify_token_renewed_at"].sort(),
    );
    expect(decrypt(String(save!.payload!.shopify_token_enc))).toBe(NEW_TOKEN);
    expect(save!.payload!.shopify_token_expires_at).toBe(expiresAt.toISOString());
    expect(save!.payload!.shopify_token_renewed_at).toBe(NOW.toISOString());
    expect(save!.payload!.shopify_token_error).toBeNull();
    expect(save!.filters).toEqual([
      ["eq", "id", "store-propia"],
      ["eq", "shopify_app", "propia"],
      ["eq", "status", "active"],
      ["or", `shopify_token_expires_at.is.null,shopify_token_expires_at.lt.${expiresAt.toISOString()}`],
    ]);
    expectNoSecrets(logs.join("\n"));
  });

  it("si en la base ya hay uno que vence después, no lo pisa (y avisa que no guardó)", async () => {
    const { admin } = db(storeRow(), { updated: [] });
    const { fetchImpl } = fakeFetch();
    const r = await renewOwnAppToken(admin, "store-propia", { fetchImpl, now: NOW });
    expect(r).toMatchObject({ ok: true, token: NEW_TOKEN, renewed: true, stored: false });
  });

  it("si Shopify lo niega: anota el motivo y no toca el token", async () => {
    const { admin, calls } = db(storeRow());
    const { fetchImpl } = fakeFetch(() => jsonResponse(401, { error: "invalid_client", error_description: SECRET }));
    const r = await renewOwnAppToken(admin, "store-propia", { fetchImpl, now: NOW });
    expect(r).toMatchObject({ ok: false, reason: "credenciales" });
    const w = writes(calls);
    expect(w).toHaveLength(1);
    expect(Object.keys(w[0]!.payload!)).toEqual(["shopify_token_error"]);
    expect(String(w[0]!.payload!.shopify_token_error)).toContain("Client secret");
    expectNoSecrets(String(w[0]!.payload!.shopify_token_error));
    expect(w[0]!.filters).toEqual([
      ["eq", "id", "store-propia"],
      ["eq", "shopify_app", "propia"],
    ]);
    expectNoSecrets(JSON.stringify(r) + logs.join("\n"));
  });

  it("con permisos de menos guarda el token igual y deja el aviso", async () => {
    const { admin, calls } = db(storeRow());
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse(200, { access_token: NEW_TOKEN, scope: "read_orders,read_draft_orders,write_draft_orders,read_products", expires_in: 86399 }),
    );
    const r = await renewOwnAppToken(admin, "store-propia", { fetchImpl, now: NOW });
    expect(r).toMatchObject({ ok: true, missingScopes: ["read_customers", "write_orders"] });
    const save = writes(calls)[0]!;
    expect(decrypt(String(save.payload!.shopify_token_enc))).toBe(NEW_TOKEN);
    expect(save.payload!.shopify_token_error).toBe(missingScopesMessage(["read_customers", "write_orders"]));
  });

  it("con `skipIfValidForMs` y un token que aún sirve, no pide otro ni escribe", async () => {
    const { admin, calls } = db(storeRow({ shopify_token_expires_at: new Date(NOW.getTime() + 20 * HOUR).toISOString() }));
    const { fetchImpl, calls: net } = fakeFetch();
    const r = await renewOwnAppToken(admin, "store-propia", { fetchImpl, now: NOW, skipIfValidForMs: OWN_APP_RENEW_BEFORE_MS });
    expect(r).toMatchObject({ ok: true, token: OLD_TOKEN, renewed: false, stored: false });
    expect(net).toHaveLength(0);
    expect(writes(calls)).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["interna (Kenku)", kenkuRow(), "no_propia"],
    ["clientes", kenkuRow({ shopify_app: "clientes" }), "no_propia"],
    ["propia deshabilitada (desinstalada)", storeRow({ status: "disabled", shopify_token_enc: null }), "inactiva"],
    ["propia en pausa", storeRow({ status: "paused" }), "inactiva"],
  ])("%s: no pide token ni escribe nada", async (_l, row, reason) => {
    const { admin, calls } = db(row);
    const { fetchImpl, calls: net } = fakeFetch();
    const r = await renewOwnAppToken(admin, String(row.id), { fetchImpl, now: NOW });
    expect(r).toMatchObject({ ok: false, reason });
    expect(net).toHaveLength(0);
    expect(writes(calls)).toEqual([]);
  });

  it("sin la 0271: sin_migracion, sin red ni escrituras", async () => {
    const { admin, calls } = db(null, {
      readError: { code: "42703", message: "column stores.shopify_client_id does not exist" },
    });
    const { fetchImpl, calls: net } = fakeFetch();
    expect(await renewOwnAppToken(admin, "x", { fetchImpl, now: NOW })).toMatchObject({ ok: false, reason: "sin_migracion" });
    expect(net).toHaveLength(0);
    expect(writes(calls)).toEqual([]);
  });

  it("sin Client secret guardado: lo anota y no sale a la red", async () => {
    const { admin, calls } = db(storeRow({ shopify_client_secret_enc: null }));
    const { fetchImpl, calls: net } = fakeFetch();
    expect(await renewOwnAppToken(admin, "store-propia", { fetchImpl, now: NOW })).toMatchObject({ ok: false, reason: "sin_credenciales" });
    expect(net).toHaveLength(0);
    expect(writes(calls).map((c) => Object.keys(c.payload!))).toEqual([["shopify_token_error"]]);
  });

  it("si el guardado falla, es un fallo (guardado)", async () => {
    const { admin } = db(storeRow(), { saveError: { message: "boom" } });
    const { fetchImpl } = fakeFetch();
    expect(await renewOwnAppToken(admin, "store-propia", { fetchImpl, now: NOW })).toMatchObject({ ok: false, reason: "guardado" });
  });
});

describe("ownAppTokenForUse", () => {
  /** Un cliente que falla la prueba si alguien lo usa. */
  const untouchable = {
    from: () => {
      throw new Error("no debía consultar la base");
    },
  } as unknown as SupabaseClient;

  it("interna y clientes: devuelve el token tal cual, sin base ni red", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const row = (over: Record<string, unknown> = {}) => kenkuRow(over) as { id: string };
    expect(await ownAppTokenForUse(untouchable, row(), OLD_TOKEN, { fetchImpl, now: NOW })).toBe(OLD_TOKEN);
    expect(await ownAppTokenForUse(untouchable, row({ shopify_app: "clientes" }), OLD_TOKEN, { fetchImpl, now: NOW })).toBe(OLD_TOKEN);
    expect(await ownAppTokenForUse(untouchable, row({ shopify_app: undefined }), null, { fetchImpl, now: NOW })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("propia con más de 15 minutos por delante: el actual, sin base ni red", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const row = storeRow({ shopify_token_expires_at: new Date(NOW.getTime() + 16 * 60 * 1000).toISOString() });
    expect(await ownAppTokenForUse(untouchable, row as { id: string }, OLD_TOKEN, { fetchImpl, now: NOW })).toBe(OLD_TOKEN);
    expect(calls).toHaveLength(0);
  });

  it("propia deshabilitada: no renueva", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const row = storeRow({ status: "disabled", shopify_token_enc: null, shopify_token_expires_at: null });
    expect(await ownAppTokenForUse(untouchable, row as { id: string }, null, { fetchImpl, now: NOW })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("propia a 5 minutos de vencer: renueva y usa el nuevo", async () => {
    const row = storeRow();
    const { admin } = fakeAdmin((c) => (c.op === "select" ? { data: row, error: null } : { data: [{ id: row.id }], error: null }));
    const { fetchImpl, calls } = fakeFetch();
    expect(await ownAppTokenForUse(admin, row as { id: string }, OLD_TOKEN, { fetchImpl, now: NOW })).toBe(NEW_TOKEN);
    expect(calls).toHaveLength(1);
  });

  it("propia sin token: renueva", async () => {
    const row = storeRow({ shopify_token_enc: null, shopify_token_expires_at: null });
    const { admin } = fakeAdmin((c) => (c.op === "select" ? { data: row, error: null } : { data: [{ id: row.id }], error: null }));
    const { fetchImpl } = fakeFetch();
    expect(await ownAppTokenForUse(admin, row as { id: string }, null, { fetchImpl, now: NOW })).toBe(NEW_TOKEN);
  });

  it("si la renovación falla y el actual aún vale, usa el actual; si ya venció, ninguno", async () => {
    const failing = () => jsonResponse(503, "down");
    const live = storeRow();
    const { admin: a1 } = fakeAdmin((c) => (c.op === "select" ? { data: live, error: null } : { data: null, error: null }));
    expect(await ownAppTokenForUse(a1, live as { id: string }, OLD_TOKEN, { fetchImpl: fakeFetch(failing).fetchImpl, now: NOW })).toBe(OLD_TOKEN);

    const dead = storeRow({ shopify_token_expires_at: new Date(NOW.getTime() - 60_000).toISOString() });
    const { admin: a2 } = fakeAdmin((c) => (c.op === "select" ? { data: dead, error: null } : { data: null, error: null }));
    expect(await ownAppTokenForUse(a2, dead as { id: string }, OLD_TOKEN, { fetchImpl: fakeFetch(failing).fetchImpl, now: NOW })).toBeNull();
    // El aviso del log lleva la tienda y el motivo, nunca el token.
    expect(logs.join("\n")).toContain('"motivo":"red"');
    expectNoSecrets(logs.join("\n"));
  });
});

// ── Donde se usa: getStoreCreds y los comprobantes ───────────────────────────

describe("getStoreCreds (lib/ingest.ts)", () => {
  function storesDb(rows: Record<string, Record<string, unknown>>) {
    return fakeAdmin((c) => {
      if (c.table !== "stores") return { data: null, error: null };
      const id = c.filters.find((f) => f[0] === "eq" && f[1] === "id")?.[2] as string;
      if (c.op === "select") return { data: rows[id] ?? null, error: null };
      return { data: [{ id }], error: null };
    });
  }

  it.each<[string, Record<string, unknown>]>([
    ["Kenku (interna)", kenkuRow()],
    ["Aurela (interna, sin columnas de la 0271)", { ...kenkuRow({ id: "store-aurela", name: "Aurela" }), shopify_client_id: undefined, shopify_token_expires_at: undefined }],
    ["una de clientes", kenkuRow({ id: "store-cliente", shopify_app: "clientes" })],
    ["una de antes de la 0249 (sin shopify_app)", { ...kenkuRow({ id: "store-vieja" }), shopify_app: undefined }],
  ])("%s: una sola lectura, el token de siempre y ningún pedido de token", async (_l, row) => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, { access_token: NEW_TOKEN }));
    vi.stubGlobal("fetch", fetchSpy);
    const { admin, calls } = storesDb({ [String(row.id)]: row });
    const creds = await getStoreCreds(String(row.id), admin);
    expect(creds?.shopify_token).toBe(OLD_TOKEN);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: "stores", op: "select", cols: "*" });
  });

  it("propia a punto de vencer: renueva antes de devolver", async () => {
    // getStoreCreds usa el reloj de verdad.
    const row = storeRow({ shopify_token_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() });
    const fetchSpy = vi.fn(async () => jsonResponse(200, { access_token: NEW_TOKEN, scope: ALL_SCOPES, expires_in: 86399 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { admin, calls } = storesDb({ "store-propia": row });
    const creds = await getStoreCreds("store-propia", admin);
    expect(creds?.shopify_token).toBe(NEW_TOKEN);
    expect(creds?.shopify_app).toBe("propia");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(calls.filter((c) => c.op === "update")).toHaveLength(1);
    // El Client secret no se suma a las credenciales: solo viaja, como siempre,
    // el secreto de los webhooks (que en una app propia es el mismo).
    expect(Object.keys(creds!).filter((k) => k.includes("client"))).toEqual([]);
    expect(creds?.shopify_webhook_secret).toBe(SECRET);
  });

  it("propia con el token al día: como cualquier otra, sin red", async () => {
    const row = storeRow({ shopify_token_expires_at: new Date(Date.now() + 20 * HOUR).toISOString() });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { admin, calls } = storesDb({ "store-propia": row });
    expect((await getStoreCreds("store-propia", admin))?.shopify_token).toBe(OLD_TOKEN);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});

describe("fetchOrderForInvoice (lib/invoicing/shopify-order.ts)", () => {
  it("propia a punto de vencer: renueva y lee el pedido con el token nuevo", async () => {
    const row = storeRow({ shopify_token_expires_at: new Date(Date.now() + 60_000).toISOString() });
    const { admin, calls } = fakeAdmin((c) => {
      if (c.op === "select" && c.cols === "shopify_domain,shopify_token_enc,shopify_app") {
        return { data: { shopify_domain: row.shopify_domain, shopify_token_enc: row.shopify_token_enc, shopify_app: "propia" }, error: null };
      }
      if (c.op === "select") return { data: row, error: null };
      return { data: [{ id: row.id }], error: null };
    });
    const { fetchImpl, calls: net } = fakeFetch(undefined, () => jsonResponse(200, { data: { order: null } }));
    const read = await fetchOrderForInvoice({ storeId: "store-propia", shopifyOrderId: "6123456789012" }, { admin, fetchImpl });
    expect(read).toEqual({ ok: false, reason: "no_encontrado" });
    expect(net.map((c) => c.url)).toEqual([
      `https://${SHOP}/admin/oauth/access_token`,
      `https://${SHOP}/admin/api/2025-01/graphql.json`,
    ]);
    expect(net[1]!.init.headers["X-Shopify-Access-Token"]).toBe(NEW_TOKEN);
    expect(calls.filter((c) => c.op === "update")).toHaveLength(1);
  });

  it("interna: una sola lectura y ningún pedido de token", async () => {
    const { admin, calls } = fakeAdmin(() => ({
      data: { shopify_domain: "kenku-peru.myshopify.com", shopify_token_enc: encrypt(OLD_TOKEN), shopify_app: "interna" },
      error: null,
    }));
    const { fetchImpl, calls: net } = fakeFetch(undefined, () => jsonResponse(200, { data: { order: null } }));
    await fetchOrderForInvoice({ storeId: "store-kenku", shopifyOrderId: "6123456789012" }, { admin, fetchImpl });
    expect(calls).toHaveLength(1);
    expect(net.map((c) => c.url)).toEqual(["https://kenku-peru.myshopify.com/admin/api/2025-01/graphql.json"]);
    expect(net[0]!.init.headers["X-Shopify-Access-Token"]).toBe(OLD_TOKEN);
  });
});
