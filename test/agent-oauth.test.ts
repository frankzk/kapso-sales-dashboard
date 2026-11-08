// OAuth del conector de IA (MOM §42.8; 0319): que un agente como Grok Bot se
// conecte a Kapta por la dirección del servidor y una persona apruebe el
// acceso, sin copiar tokens. Lo que se fija:
//   - el 401 de /api/mcp apunta a los metadatos, y los metadatos apuntan al
//     registro, la autorización y el canje de este mismo sitio;
//   - el registro es público pero solo guarda redirect_uris https (o localhost)
//     y tiene tope por hora;
//   - un cliente o una redirect_uri que no son los registrados NUNCA redirigen;
//   - «Permitir» exige automations.manage y tiendas que la persona ve, de una
//     sola organización; el código es de un solo uso, vence y se guarda su hash;
//   - el canje exige PKCE S256, el mismo cliente y la misma redirect_uri; un
//     código repetido revoca el token que se dio con él;
//   - el token que sale es un agent_tokens con las tiendas y herramientas
//     aprobadas, que se revoca como cualquier otro.
// Sin red ni base real.

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  OAUTH_REGISTRATIONS_PER_HOUR,
  OAUTH_SCOPES,
  authorizationServerMetadata,
  clientRedirect,
  hashAuthCode,
  isValidRedirectUri,
  parseAuthorizeRequest,
  parseRegistration,
  pkceMatches,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  resourceBelongsHere,
} from "@/lib/agent-oauth";
import { hashAgentToken } from "@/lib/agent-auth";

// ---------------------------------------------------------------------------
// Base falsa
// ---------------------------------------------------------------------------

type Op = [method: string, ...args: unknown[]];
interface Query {
  table: string;
  ops: Op[];
}
interface Reply {
  data?: unknown;
  error?: unknown;
  count?: number;
}

function fakeDb(reply: (q: Query) => Reply = () => ({ data: [] }), user: { id: string } | null = null) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const result = (single: boolean) => {
        const r = reply(q);
        const data = single && Array.isArray(r.data) ? (r.data[0] ?? null) : (r.data ?? (single ? null : []));
        return { data, error: r.error ?? null, count: r.count ?? null };
      };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "or", "order", "limit", "not", "gt", "gte", "lte", "is", "insert", "update"]) {
        b[m] = (...args: unknown[]) => {
          q.ops.push([m, ...args]);
          return b;
        };
      }
      b.maybeSingle = () => Promise.resolve(result(true));
      b.single = () => Promise.resolve(result(true));
      b.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(result(false)).then(ok, ko);
      return b;
    },
    auth: { getUser: async () => ({ data: { user } }) },
  };
  return { client: client as unknown as SupabaseClient, queries };
}

const op = (q: Query | undefined, method: string) => q?.ops.find(([m]) => m === method);
const has = (q: Query | undefined, method: string, ...args: unknown[]) =>
  !!q?.ops.some(([m, ...a]) => m === method && JSON.stringify(a.slice(0, args.length)) === JSON.stringify(args));

const h = vi.hoisted(() => ({
  admin: null as unknown as { client: unknown; queries: { table: string; ops: unknown[][] }[] },
  server: null as unknown as { client: unknown; queries: { table: string; ops: unknown[][] }[] },
  allowed: true,
  host: "kapta.example",
}));
vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => h.admin.client,
  createServerSupabase: async () => h.server.client,
}));
vi.mock("@/lib/permissions-access", () => ({
  hasOrgPermission: async (_org: string, key: string) => h.allowed && key === "automations.manage",
  orgsWithPermission: async () => [],
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: h.host, "x-forwarded-proto": "https" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
}));
vi.mock("@/lib/ingest", () => ({ getStoreCreds: async () => null }));

const ORIGIN = "https://kapta.example";
const ORG = "00000000-0000-4000-8000-0000000000aa";
const KENKU = "00000000-0000-4000-8000-000000000001";
const AURELA = "00000000-0000-4000-8000-000000000002";
const OTHER_ORG_STORE = "00000000-0000-4000-8000-000000000009";
const USER = "00000000-0000-4000-8000-0000000000c1";
const CLIENT = "kcli_AAAAAAAAAAAAAAAAAAAAAA";
const REDIRECT = "https://grok.example/oauth/callback";

const VERIFIER = "v".repeat(43) + "-._~abc";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

// ---------------------------------------------------------------------------
// Reglas puras
// ---------------------------------------------------------------------------

describe("metadatos", () => {
  it("el recurso y el servidor de autorización son este mismo sitio", () => {
    expect(protectedResourceMetadataUrl(`${ORIGIN}/`)).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`);
    expect(protectedResourceMetadata(ORIGIN)).toMatchObject({ resource: `${ORIGIN}/api/mcp`, authorization_servers: [ORIGIN], bearer_methods_supported: ["header"] });
    expect(authorizationServerMetadata(ORIGIN)).toEqual({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/api/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/oauth/register`,
      scopes_supported: OAUTH_SCOPES,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
    });
  });
  it("por OAuth solo se dan las herramientas de lectura", () => {
    expect(OAUTH_SCOPES).toEqual(["pedidos.leer", "conversaciones.leer", "politicas.leer"]);
  });
});

describe("registro", () => {
  it("redirect_uri: https, o http solo a la propia máquina; sin fragmento ni usuario", () => {
    expect(isValidRedirectUri("https://grok.com/callback?x=1")).toBe(true);
    expect(isValidRedirectUri("http://localhost:3334/callback")).toBe(true);
    expect(isValidRedirectUri("http://127.0.0.1/cb")).toBe(true);
    expect(isValidRedirectUri("http://grok.com/callback")).toBe(false);
    expect(isValidRedirectUri("https://grok.com/cb#frag")).toBe(false);
    expect(isValidRedirectUri("https://user:pw@grok.com/cb")).toBe(false);
    expect(isValidRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isValidRedirectUri("https://" + "a".repeat(500) + ".com")).toBe(false);
  });
  it("solo clientes públicos con authorization_code; el nombre se limpia", () => {
    expect(parseRegistration({ redirect_uris: [REDIRECT, REDIRECT], client_name: "  Grok   Bot " })).toEqual({ ok: true, clientName: "Grok Bot", redirectUris: [REDIRECT] });
    expect(parseRegistration({ redirect_uris: [REDIRECT] })).toMatchObject({ ok: true, clientName: "Agente de IA" });
    expect(parseRegistration({ redirect_uris: [] })).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    expect(parseRegistration({ redirect_uris: ["http://evil.com/cb"] })).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    expect(parseRegistration({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" })).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    expect(parseRegistration({ redirect_uris: [REDIRECT], grant_types: ["client_credentials"] })).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    expect(parseRegistration([REDIRECT])).toMatchObject({ ok: false });
  });
});

describe("PKCE y autorización", () => {
  it("S256 en tiempo constante; un verificador corto o con otros caracteres no vale", () => {
    expect(pkceMatches(VERIFIER, CHALLENGE)).toBe(true);
    expect(pkceMatches(VERIFIER + "x", CHALLENGE)).toBe(false);
    expect(pkceMatches("corto", CHALLENGE)).toBe(false);
    expect(pkceMatches(VERIFIER.replace("v", "+"), CHALLENGE)).toBe(false);
    expect(pkceMatches(undefined, CHALLENGE)).toBe(false);
  });

  const good = { response_type: "code", client_id: CLIENT, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "abc" };

  it("un cliente desconocido o una redirect_uri distinta no redirigen nunca", () => {
    expect(parseAuthorizeRequest(good, null, ORIGIN)).toMatchObject({ ok: false, fatal: true });
    expect(parseAuthorizeRequest({ ...good, redirect_uri: "https://evil.example/cb" }, [REDIRECT], ORIGIN)).toMatchObject({ ok: false, fatal: true });
    // Sin redirect_uri vale la única registrada.
    expect(parseAuthorizeRequest({ ...good, redirect_uri: undefined }, [REDIRECT], ORIGIN)).toMatchObject({ ok: true, request: { redirectUri: REDIRECT } });
    expect(parseAuthorizeRequest({ ...good, redirect_uri: undefined }, [REDIRECT, "https://otro.example/cb"], ORIGIN)).toMatchObject({ ok: false, fatal: true });
  });

  it("lo demás vuelve al cliente con su error y su state", () => {
    expect(parseAuthorizeRequest({ ...good, response_type: "token" }, [REDIRECT], ORIGIN)).toMatchObject({ ok: false, fatal: false, error: "unsupported_response_type", state: "abc", redirectUri: REDIRECT });
    expect(parseAuthorizeRequest({ ...good, code_challenge_method: "plain" }, [REDIRECT], ORIGIN)).toMatchObject({ fatal: false, error: "invalid_request" });
    expect(parseAuthorizeRequest({ ...good, code_challenge: "x" }, [REDIRECT], ORIGIN)).toMatchObject({ fatal: false, error: "invalid_request" });
    expect(parseAuthorizeRequest({ ...good, resource: "https://otro.example/api/mcp" }, [REDIRECT], ORIGIN)).toMatchObject({ fatal: false, error: "invalid_target" });
    expect(parseAuthorizeRequest({ ...good, scope: "admin" }, [REDIRECT], ORIGIN)).toMatchObject({ fatal: false, error: "invalid_scope" });
  });

  it("las herramientas pedidas, o todas las de lectura", () => {
    expect(parseAuthorizeRequest(good, [REDIRECT], ORIGIN)).toMatchObject({ ok: true, request: { requestedScopes: OAUTH_SCOPES, state: "abc" } });
    expect(parseAuthorizeRequest({ ...good, scope: "pedidos.leer whatsapp.enviar" }, [REDIRECT], ORIGIN)).toMatchObject({ ok: true, request: { requestedScopes: ["pedidos.leer"] } });
    expect(parseAuthorizeRequest({ ...good, resource: `${ORIGIN}/api/mcp` }, [REDIRECT], ORIGIN)).toMatchObject({ ok: true });
  });

  it("el recurso es de este origen; la vuelta conserva la query del cliente", () => {
    expect(resourceBelongsHere(`${ORIGIN}/api/mcp`, ORIGIN)).toBe(true);
    expect(resourceBelongsHere(ORIGIN, `${ORIGIN}/`)).toBe(true);
    expect(resourceBelongsHere("https://kapta.example.evil.com/api/mcp", ORIGIN)).toBe(false);
    expect(clientRedirect("https://grok.example/cb?x=1", { code: "c d", state: null })).toBe("https://grok.example/cb?x=1&code=c+d");
  });
});

// ---------------------------------------------------------------------------
// Las rutas
// ---------------------------------------------------------------------------

async function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`${ORIGIN}${path}`, init);
}

describe("metadatos por HTTP y el 401 de /api/mcp", () => {
  it(".well-known responde con el origen de la petición y CORS", async () => {
    const pr = await import("@/app/.well-known/oauth-protected-resource/[[...path]]/route");
    const res = pr.GET(await call("/.well-known/oauth-protected-resource/api/mcp"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toMatchObject({ resource: `${ORIGIN}/api/mcp`, authorization_servers: [ORIGIN] });
    const as = await import("@/app/.well-known/oauth-authorization-server/[[...path]]/route");
    expect(await as.GET(await call("/.well-known/oauth-authorization-server")).json()).toMatchObject({ issuer: ORIGIN, code_challenge_methods_supported: ["S256"] });
  });

  it("/api/mcp sin token dice dónde pedir permiso", async () => {
    h.admin = fakeDb() as unknown as typeof h.admin;
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(await call("/api/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer realm="kapta", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`);
  });
});

describe("POST /api/oauth/register", () => {
  let recent: number;
  let inserted: Record<string, unknown> | null;
  beforeEach(() => {
    recent = 0;
    inserted = null;
    h.admin = fakeDb((q) => {
      const ins = op(q, "insert");
      if (ins) {
        inserted = ins[1] as Record<string, unknown>;
        return { data: null };
      }
      return { count: recent };
    }) as unknown as typeof h.admin;
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  const register = async (body: unknown) => {
    const { POST } = await import("@/app/api/oauth/register/route");
    return POST(await call("/api/oauth/register", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
  };

  it("registra un cliente público con sus redirect_uris", async () => {
    const res = await register({ client_name: "Grok Bot", redirect_uris: [REDIRECT] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ client_name: "Grok Bot", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code"] });
    expect(body.client_id).toMatch(/^kcli_[A-Za-z0-9_-]{22}$/);
    expect(body).not.toHaveProperty("client_secret");
    expect(inserted).toMatchObject({ client_id: body.client_id, client_name: "Grok Bot", redirect_uris: [REDIRECT] });
  });

  it("rechaza lo inválido, y pasado el tope por hora contesta 429 sin guardar", async () => {
    expect((await register("{nope")).status).toBe(400);
    const bad = await register({ redirect_uris: ["http://evil.com/cb"] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_redirect_uri" });
    recent = OAUTH_REGISTRATIONS_PER_HOUR;
    expect((await register({ redirect_uris: [REDIRECT] })).status).toBe(429);
    expect(inserted).toBeNull();
  });

  it("sin la 0319: 503 que lo dice", async () => {
    h.admin = fakeDb(() => ({ error: { code: "PGRST205", message: "Could not find the table 'public.agent_oauth_clients'" } })) as unknown as typeof h.admin;
    const res = await register({ redirect_uris: [REDIRECT] });
    expect(res.status).toBe(503);
    expect((await res.json()).error_description).toContain("0319");
  });
});

describe("POST /api/oauth/token", () => {
  const CODE = "c".repeat(43);
  const codeRow = {
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    user_id: USER,
    org_id: ORG,
    store_ids: [KENKU],
    scopes: ["pedidos.leer", "politicas.leer"],
    label: "Grok Bot (OAuth)",
    used_at: null,
    token_id: null,
  };
  let consumable: boolean;
  let priorUse: { token_id: string; used_at: string } | null;
  let tokenInsert: Record<string, unknown> | null;
  let revoked: string | null;
  beforeEach(() => {
    consumable = true;
    priorUse = null;
    tokenInsert = null;
    revoked = null;
    h.admin = fakeDb((q) => {
      if (q.table === "agent_oauth_codes" && op(q, "update") && has(q, "is", "used_at", null)) {
        return { data: consumable ? [codeRow] : [] };
      }
      if (q.table === "agent_oauth_codes" && op(q, "select") && !op(q, "update")) return { data: priorUse ? [priorUse] : [] };
      if (q.table === "agent_tokens" && op(q, "insert")) {
        tokenInsert = op(q, "insert")![1] as Record<string, unknown>;
        return { data: [{ id: "tok-oauth" }] };
      }
      if (q.table === "agent_tokens" && op(q, "update")) {
        revoked = q.ops.find(([m, c]) => m === "eq" && c === "id")?.[2] as string;
        return { data: null };
      }
      return { data: null };
    }) as unknown as typeof h.admin;
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  const exchange = async (fields: Record<string, string>, json = false) => {
    const { POST } = await import("@/app/api/oauth/token/route");
    return POST(
      await call("/api/oauth/token", {
        method: "POST",
        headers: { "content-type": json ? "application/json" : "application/x-www-form-urlencoded" },
        body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
      }),
    );
  };
  const good = { grant_type: "authorization_code", code: CODE, code_verifier: VERIFIER, client_id: CLIENT, redirect_uri: REDIRECT };

  it("canjea el código una vez por un token del conector, con lo que aprobó la persona", async () => {
    const res = await exchange(good);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ token_type: "Bearer", scope: "pedidos.leer politicas.leer" });
    expect(body.access_token).toMatch(/^kagt_/);
    expect(tokenInsert).toMatchObject({
      org_id: ORG,
      created_by: USER,
      label: "Grok Bot (OAuth)",
      store_ids: [KENKU],
      scopes: ["pedidos.leer", "politicas.leer"],
      oauth_client_id: CLIENT,
      token_hash: hashAgentToken(body.access_token),
    });
    // Se consume por su hash, vigente y sin usar.
    const consume = h.admin.queries.find((q) => (q as Query).table === "agent_oauth_codes" && op(q as Query, "update")) as Query;
    expect(has(consume, "eq", "code_hash", hashAuthCode(CODE))).toBe(true);
    expect(has(consume, "is", "used_at", null)).toBe(true);
    expect(op(consume, "gt")?.[1]).toBe("expires_at");
    // El registro no lleva el token.
    expect(vi.mocked(console.info).mock.calls.map((c) => String(c[0])).join("\n")).not.toContain(body.access_token);
  });

  it("también en JSON", async () => {
    expect((await exchange(good, true)).status).toBe(200);
  });

  it("PKCE, cliente o redirect_uri distintos: invalid_grant y sin token", async () => {
    for (const bad of [{ code_verifier: "w".repeat(50) }, { client_id: "kcli_BBBBBBBBBBBBBBBBBBBBBB" }, { redirect_uri: "https://evil.example/cb" }]) {
      const res = await exchange({ ...good, ...bad });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    }
    expect(tokenInsert).toBeNull();
  });

  it("un código ya usado revoca el token que se dio con él", async () => {
    consumable = false;
    priorUse = { token_id: "tok-first", used_at: "2026-11-08T10:00:00Z" };
    const res = await exchange(good);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    expect(revoked).toBe("tok-first");
    expect(tokenInsert).toBeNull();
  });

  it("otro grant, faltantes u otro recurso", async () => {
    expect(await (await exchange({ ...good, grant_type: "refresh_token" })).json()).toMatchObject({ error: "unsupported_grant_type" });
    expect(await (await exchange({ grant_type: "authorization_code", code: CODE })).json()).toMatchObject({ error: "invalid_request" });
    expect(await (await exchange({ ...good, resource: "https://otro.example/api/mcp" })).json()).toMatchObject({ error: "invalid_target" });
  });
});

// ---------------------------------------------------------------------------
// «Permitir» y «Cancelar»
// ---------------------------------------------------------------------------

describe("approveAgentAuthorization y denyAgentAuthorization", () => {
  let codeInsert: Record<string, unknown> | null;
  let clientExists: boolean;
  beforeEach(() => {
    h.allowed = true;
    codeInsert = null;
    clientExists = true;
    h.admin = fakeDb((q) => {
      if (q.table === "agent_oauth_clients") return { data: clientExists ? [{ client_id: CLIENT, client_name: "Grok Bot", redirect_uris: [REDIRECT] }] : [] };
      if (q.table === "agent_oauth_codes" && op(q, "insert")) {
        codeInsert = op(q, "insert")![1] as Record<string, unknown>;
        return { data: null };
      }
      return { data: [] };
    }) as unknown as typeof h.admin;
    h.server = fakeDb((q) => {
      if (q.table !== "stores") return { data: [] };
      const ids = (q.ops.find(([m, c]) => m === "in" && c === "id")?.[2] ?? []) as string[];
      const visible = [{ id: KENKU, org_id: ORG }, { id: AURELA, org_id: ORG }, { id: OTHER_ORG_STORE, org_id: "otra" }];
      return { data: visible.filter((s) => ids.includes(s.id)) };
    }, { id: USER }) as unknown as typeof h.server;
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  function consent(extra: Record<string, string | string[]> = {}) {
    const f = new FormData();
    const base: Record<string, string | string[]> = {
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: "xyz",
      label: "Grok Bot (OAuth)",
      store_ids: [KENKU, AURELA],
      scopes: ["pedidos.leer", "politicas.leer"],
      ...extra,
    };
    for (const [k, v] of Object.entries(base)) for (const one of Array.isArray(v) ? v : [v]) f.append(k, one);
    return f;
  }
  async function redirectOf(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (e) {
      return (e as { to: string }).to;
    }
    throw new Error("no redirigió");
  }

  it("«Permitir»: un código de un solo uso con lo elegido, y vuelve al agente con code y state", async () => {
    const { approveAgentAuthorization } = await import("@/app/oauth/authorize/actions");
    const to = new URL(await redirectOf(approveAgentAuthorization({}, consent())));
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get("state")).toBe("xyz");
    const code = to.searchParams.get("code")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeInsert).toMatchObject({
      code_hash: hashAuthCode(code),
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      user_id: USER,
      org_id: ORG,
      store_ids: [KENKU, AURELA],
      scopes: ["pedidos.leer", "politicas.leer"],
      label: "Grok Bot (OAuth)",
    });
    const ttl = Date.parse(codeInsert!.expires_at as string) - Date.parse(codeInsert!.created_at as string);
    expect(ttl).toBe(10 * 60_000);
    // El código en claro no se guarda.
    expect(JSON.stringify(codeInsert)).not.toContain(code);
  });

  it("sin automations.manage, con una tienda que no ve o de dos organizaciones, o con herramientas de escritura: no hay código", async () => {
    const { approveAgentAuthorization } = await import("@/app/oauth/authorize/actions");
    h.allowed = false;
    expect(await approveAgentAuthorization({}, consent())).toMatchObject({ error: expect.stringContaining("dueño") });
    h.allowed = true;
    expect(await approveAgentAuthorization({}, consent({ store_ids: [KENKU, "no-la-veo"] }))).toEqual({ error: "Elegiste una tienda que no ves." });
    expect(await approveAgentAuthorization({}, consent({ store_ids: [KENKU, OTHER_ORG_STORE] }))).toEqual({ error: "Elige tiendas de una sola organización." });
    expect(await approveAgentAuthorization({}, consent({ scopes: ["pedidos.leer", "whatsapp.enviar"] }))).toEqual({ error: "Hay una herramienta que no existe." });
    expect(await approveAgentAuthorization({}, consent({ store_ids: [] }))).toEqual({ error: "Elige al menos una tienda." });
    expect(codeInsert).toBeNull();
  });

  it("un cliente desconocido o una redirect_uri cambiada en el formulario no redirigen", async () => {
    const { approveAgentAuthorization, denyAgentAuthorization } = await import("@/app/oauth/authorize/actions");
    expect(await approveAgentAuthorization({}, consent({ redirect_uri: "https://evil.example/cb" }))).toMatchObject({ error: expect.stringContaining("dirección de vuelta") });
    expect(await denyAgentAuthorization({}, consent({ redirect_uri: "https://evil.example/cb" }))).toMatchObject({ error: expect.stringContaining("dirección de vuelta") });
    clientExists = false;
    expect(await approveAgentAuthorization({}, consent())).toMatchObject({ error: expect.stringContaining("no está registrado") });
    expect(codeInsert).toBeNull();
  });

  it("«Cancelar»: vuelve al agente con access_denied y su state", async () => {
    const { denyAgentAuthorization } = await import("@/app/oauth/authorize/actions");
    const to = new URL(await redirectOf(denyAgentAuthorization({}, consent())));
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("xyz");
    expect(to.searchParams.has("code")).toBe(false);
    expect(codeInsert).toBeNull();
  });
});
