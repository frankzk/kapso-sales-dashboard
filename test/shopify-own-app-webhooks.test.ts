// Tiendas con su app propia de Shopify — lo que pasa al RECIBIR algo de afuera y
// el freno de la renovación al usar el token (MOM §36.3, §36.4).
//
// Lo que se fija aquí, con una tabla `stores` falsa que aplica de verdad los
// filtros de cada escritura:
//   - Un webhook de Shopify, de Shopify Flow, de Kapso, de Aliclik o de Flow.cl
//     con la firma o el secreto mal NO hace salir el Client secret a Shopify:
//     la renovación va después de autenticar, y solo donde se usa el token.
//   - La renovación al usar tiene freno: con Shopify caído o el secreto
//     revocado, muchos usos seguidos piden UN token, no uno por uso; tras un
//     fallo de red, espera 15 minutos.
//   - Un fallo viejo no pisa el «salió bien» de una renovación más nueva.
//   - Una tienda en pausa renueva; una deshabilitada, no.
//   - Tras rotar el Client secret, los webhooks firmados con el anterior se
//     aceptan 48 h SOLO en una tienda propia; Kenku, Aurela y las 'clientes'
//     se comprueban exactamente como antes.
// Sin red: `fetch` es falso.

import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
interface Write {
  table: string;
  op: string;
  payload: Row;
  filters: unknown[][];
  matched: string[];
}

const db = vi.hoisted(() => ({
  stores: {} as Record<string, Record<string, unknown>>,
  writes: [] as Write[],
  reads: [] as { table: string; cols?: string }[],
}));

/** ¿La fila cumple un filtro `or` de PostgREST («a.is.null,b.lt.2026-…»)? */
function matchesOr(row: Row, expr: string): boolean {
  return expr.split(",").some((part) => {
    const [col, op, ...rest] = part.split(".");
    const value = rest.join(".");
    const v = row[col!];
    if (op === "is" && value === "null") return v == null;
    if (v == null) return false;
    const a = Date.parse(String(v));
    const b = Date.parse(value);
    if (op === "lt") return a < b;
    if (op === "lte") return a <= b;
    if (op === "eq") return String(v) === value;
    throw new Error(`filtro no soportado: ${part}`);
  });
}

function matches(row: Row, filters: unknown[][]): boolean {
  return filters.every(([m, col, val]) => {
    if (m === "eq") return row[col as string] === val;
    if (m === "neq") return row[col as string] !== val;
    if (m === "in") return (val as unknown[]).includes(row[col as string]);
    if (m === "or") return matchesOr(row, col as string);
    if (m === "ilike") return String(row[col as string] ?? "").toLowerCase() === String(val).toLowerCase();
    if (m === "is") return row[col as string] == null;
    return true;
  });
}

vi.mock("@/lib/db", () => {
  function from(table: string) {
    const state = { op: "select", payload: {} as Row, filters: [] as unknown[][], cols: undefined as string | undefined };
    const run = (single: boolean) => {
      if (table !== "stores") {
        if (state.op === "select") db.reads.push({ table, cols: state.cols });
        else db.writes.push({ table, op: state.op, payload: state.payload, filters: state.filters, matched: [] });
        return { data: single ? null : [], error: null };
      }
      const rows = Object.values(db.stores).filter((r) => matches(r, state.filters));
      if (state.op === "select") {
        db.reads.push({ table, cols: state.cols });
        if (single) return rows[0] ? { data: { ...rows[0] }, error: null } : { data: null, error: { message: "not found" } };
        return { data: rows.map((r) => ({ ...r })), error: null };
      }
      if (state.op === "update") {
        for (const r of rows) Object.assign(r, state.payload);
        db.writes.push({ table, op: "update", payload: state.payload, filters: state.filters, matched: rows.map((r) => String(r.id)) });
        return { data: rows.map((r) => ({ id: r.id })), error: null };
      }
      db.writes.push({ table, op: state.op, payload: state.payload, filters: state.filters, matched: [] });
      return { data: null, error: null };
    };
    const q: any = {
      select: (cols?: string) => {
        if (state.op === "select") state.cols = cols;
        return q;
      },
      maybeSingle: async () => {
        const r = run(true);
        return r.error && state.op === "select" ? { data: null, error: null } : r;
      },
      single: async () => run(true),
      then: (res: any, rej: any) => Promise.resolve().then(() => run(false)).then(res, rej),
    };
    for (const op of ["insert", "update", "upsert"]) {
      q[op] = (payload: Row) => {
        state.op = op;
        state.payload = payload;
        return q;
      };
    }
    q.delete = () => {
      state.op = "delete";
      return q;
    };
    for (const m of ["eq", "neq", "in", "is", "or", "ilike", "not", "gte", "lte", "lt", "gt", "order", "limit", "match", "range"]) {
      q[m] = (...args: unknown[]) => {
        state.filters.push([m, ...args]);
        return q;
      };
    }
    return q;
  }
  const client = { from, rpc: async () => ({ data: null, error: null }) };
  return { createAdminSupabase: () => client, createServerSupabase: async () => client };
});

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { encrypt, generateEncryptionKey } from "@/lib/crypto";
import {
  OWN_APP_ON_USE_RETRY_AFTER_RED_MS,
  OWN_APP_ON_USE_RETRY_MS,
  OWN_APP_PREV_WEBHOOK_SECRET_GRACE_MS,
  ownAppTokenForUse,
  renewOwnAppToken,
} from "@/lib/shopify-own-app";
import { getStoreCreds, ownAppCredsForUse, processShopifyWebhook } from "@/lib/ingest";
import { POST as shopifyWebhook } from "@/app/api/webhooks/shopify/[storeId]/route";
import { POST as flowWebhook } from "@/app/api/webhooks/flow/[storeId]/route";
import { POST as kapsoWebhook } from "@/app/api/webhooks/kapso/[storeId]/route";
import { GET as aliclikPing, POST as aliclikWebhook } from "@/app/api/webhooks/aliclik/[storeId]/route";
import { POST as flowclWebhook } from "@/app/api/webhooks/flowcl/[storeId]/route";

process.env.ENCRYPTION_KEY = generateEncryptionKey();

const SHOP = "super-human-peru.myshopify.com";
const SECRET = "shpss_secreto-de-prueba-0123456789";
const OLD_SECRET = "shpss_secreto-anterior-9876543210";
const OLD_TOKEN = "shpat_token-viejo-0000000000";
const NEW_TOKEN = "shpat_token-nuevo-1111111111";
const SCOPES = "read_orders,read_draft_orders,write_draft_orders,read_products,read_customers,write_orders";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const admin = createAdminSupabase() as unknown as SupabaseClient;

function propia(over: Row = {}): Row {
  return {
    id: "store-propia",
    org_id: "org-sh",
    name: "Súper Human Perú",
    shopify_domain: SHOP,
    shopify_app: "propia",
    status: "active",
    timezone: "America/Lima",
    shopify_token_enc: encrypt(OLD_TOKEN),
    shopify_webhook_secret_enc: encrypt(SECRET),
    shopify_client_id: "client-id-0123456789",
    shopify_client_secret_enc: encrypt(SECRET),
    // Ya venció: cualquier uso querría renovar.
    shopify_token_expires_at: new Date(Date.now() - 10 * MIN).toISOString(),
    shopify_token_renewed_at: new Date(Date.now() - 25 * HOUR).toISOString(),
    shopify_token_error: null,
    shopify_token_retry_at: null,
    shopify_webhook_secret_prev_enc: null,
    shopify_webhook_secret_prev_set_at: null,
    flow_webhook_secret_enc: encrypt("flow-secreto"),
    kapso_webhook_secret_enc: encrypt("kapso-secreto"),
    aliclik_webhook_secret_enc: encrypt("aliclik-secreto"),
    flowcl_webhook_secret_enc: encrypt("flowcl-secreto"),
    ...over,
  };
}

/** Kenku: app interna, sin nada de la 0271. */
function kenku(over: Row = {}): Row {
  return {
    id: "store-kenku",
    org_id: "org-kenku",
    name: "Kenku Peru",
    shopify_domain: "kenku-peru.myshopify.com",
    shopify_app: "interna",
    status: "active",
    timezone: "America/Lima",
    shopify_token_enc: encrypt(OLD_TOKEN),
    shopify_webhook_secret_enc: encrypt("secreto-interna"),
    ...over,
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;
let tokenReply: () => { status: number; body: unknown };
const logs: string[] = [];

function tokenCalls(): unknown[][] {
  return fetchSpy.mock.calls.filter((c) => String(c[0]).endsWith("/admin/oauth/access_token"));
}

beforeEach(() => {
  db.stores = {};
  db.writes = [];
  db.reads = [];
  tokenReply = () => ({ status: 200, body: { access_token: NEW_TOKEN, scope: SCOPES, expires_in: 86399 } });
  fetchSpy = vi.fn(async (url: unknown) => {
    const r = String(url).endsWith("/admin/oauth/access_token") ? tokenReply() : { status: 200, body: { data: {} } };
    const text = JSON.stringify(r.body);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(text), text: async () => text };
  });
  vi.stubGlobal("fetch", fetchSpy);
  logs.length = 0;
  for (const level of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const storeWrites = () => db.writes.filter((w) => w.table === "stores");
const ctx = (storeId: string) => ({ params: Promise.resolve({ storeId }) });
const hmac = (body: string, secret: string) => createHmac("sha256", secret).update(body, "utf8").digest("base64");

function shopifyReq(storeId: string, body: string, opts: { topic?: string; secret?: string | null } = {}) {
  return new NextRequest(`https://kapta.test/api/webhooks/shopify/${storeId}`, {
    method: "POST",
    body,
    headers: {
      "x-shopify-topic": opts.topic ?? "orders/create",
      ...(opts.secret === null ? {} : { "x-shopify-hmac-sha256": hmac(body, opts.secret ?? "otro-secreto") }),
    },
  });
}

// ── Autenticar antes de renovar ──────────────────────────────────────────────

describe("una petición falsa no hace salir el Client secret", () => {
  beforeEach(() => {
    db.stores = { "store-propia": propia() };
    // Y aunque saliera, Shopify lo rechazaría: el peor caso del hallazgo.
    tokenReply = () => ({ status: 401, body: { error: "invalid_client" } });
  });

  it("webhook de Shopify con la firma mal, cinco veces: 401, sin red y sin escribir en la tienda", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await shopifyWebhook(shopifyReq("store-propia", JSON.stringify({ id: i }), { secret: "falso" }), ctx("store-propia"));
      expect(res.status).toBe(401);
    }
    const res = await shopifyWebhook(shopifyReq("store-propia", "{}", { secret: null }), ctx("store-propia"));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storeWrites()).toEqual([]);
  });

  it("Shopify Flow con el secreto mal: sin pedir token", async () => {
    const req = new NextRequest("https://kapta.test/api/webhooks/flow/store-propia", {
      method: "POST",
      body: JSON.stringify({ source: "abandoned_browse" }),
      headers: { "x-recoverops-secret": "falso" },
    });
    expect((await flowWebhook(req, ctx("store-propia"))).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storeWrites()).toEqual([]);
  });

  it("Kapso con el secreto mal: sin pedir token", async () => {
    const req = new NextRequest("https://kapta.test/api/webhooks/kapso/store-propia?secret=falso", {
      method: "POST",
      body: JSON.stringify({ event: "x" }),
    });
    expect((await kapsoWebhook(req, ctx("store-propia"))).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storeWrites()).toEqual([]);
  });

  it("Aliclik (aviso y ping) y Flow.cl con el secreto mal: sin pedir token", async () => {
    const aliclik = new NextRequest("https://kapta.test/api/webhooks/aliclik/store-propia?secret=falso", {
      method: "POST",
      body: JSON.stringify({ orderNumber: "1" }),
    });
    expect((await aliclikWebhook(aliclik, ctx("store-propia"))).status).toBe(401);
    const ping = new NextRequest("https://kapta.test/api/webhooks/aliclik/store-propia?secret=falso");
    expect((await aliclikPing(ping, ctx("store-propia"))).status).toBe(401);
    const flowcl = new NextRequest("https://kapta.test/api/webhooks/flowcl/store-propia?secret=falso", {
      method: "POST",
      body: "token=abc",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect((await flowclWebhook(flowcl, ctx("store-propia"))).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storeWrites()).toEqual([]);
  });

  it("con el secreto BIEN, Aliclik tampoco renueva: no usa el token de Shopify", async () => {
    const ping = new NextRequest("https://kapta.test/api/webhooks/aliclik/store-propia?secret=aliclik-secreto");
    expect((await aliclikPing(ping, ctx("store-propia"))).status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("un borrador con la firma BIEN sí renueva, después de comprobarla", async () => {
    tokenReply = () => ({ status: 200, body: { access_token: NEW_TOKEN, scope: SCOPES, expires_in: 86399 } });
    const body = JSON.stringify({ id: 77, name: "#D77", line_items: [], created_at: "2026-10-23T10:00:00Z", updated_at: "2026-10-23T10:00:00Z" });
    const res = await shopifyWebhook(shopifyReq("store-propia", body, { topic: "draft_orders/update", secret: SECRET }), ctx("store-propia"));
    expect(res.status).toBe(200);
    expect(tokenCalls()).toHaveLength(1);
    expect(String(tokenCalls()[0]![0])).toBe(`https://${SHOP}/admin/oauth/access_token`);
  });

  it("un pedido con la firma BIEN no sale a pedir token (no usa Shopify)", async () => {
    const body = JSON.stringify({ id: 1 });
    const res = await shopifyWebhook(shopifyReq("store-propia", body, { topic: "shop/update", secret: SECRET }), ctx("store-propia"));
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── El freno de la renovación al usar ────────────────────────────────────────

describe("la renovación al usar tiene freno", () => {
  const NOW = new Date("2026-10-23T15:00:00.000Z");
  const at = (ms: number) => new Date(NOW.getTime() + ms);
  const expired = () => propia({ shopify_token_expires_at: at(-10 * MIN).toISOString(), shopify_token_renewed_at: at(-25 * HOUR).toISOString() });
  const use = (now: Date) =>
    ownAppTokenForUse(admin, db.stores["store-propia"] as { id: string }, OLD_TOKEN, { now, fetchImpl: fetchSpy as unknown as typeof fetch });

  it("con el secreto revocado, cinco usos seguidos piden UN token; pasados 5 minutos, otro", async () => {
    db.stores = { "store-propia": expired() };
    tokenReply = () => ({ status: 401, body: { error: "invalid_client" } });
    for (let i = 0; i < 5; i++) expect(await use(at(i * 1000))).toBeNull();
    expect(tokenCalls()).toHaveLength(1);
    expect(db.stores["store-propia"]!.shopify_token_retry_at).toBe(at(OWN_APP_ON_USE_RETRY_MS).toISOString());
    // Pasado el freno, un intento más.
    await use(at(OWN_APP_ON_USE_RETRY_MS + 1000));
    expect(tokenCalls()).toHaveLength(2);
  });

  it("si Shopify no responde bien (503 o 429), espera 15 minutos", async () => {
    db.stores = { "store-propia": expired() };
    tokenReply = () => ({ status: 503, body: "down" });
    await use(NOW);
    expect(tokenCalls()).toHaveLength(1);
    expect(db.stores["store-propia"]!.shopify_token_retry_at).toBe(at(OWN_APP_ON_USE_RETRY_AFTER_RED_MS).toISOString());
    await use(at(OWN_APP_ON_USE_RETRY_MS + 1000));
    expect(tokenCalls()).toHaveLength(1);
    tokenReply = () => ({ status: 429, body: { errors: "Throttled" } });
    await use(at(OWN_APP_ON_USE_RETRY_AFTER_RED_MS + 1000));
    expect(tokenCalls()).toHaveLength(2);
  });

  it("frenada y con el token aún vigente, usa el que tiene sin red", async () => {
    db.stores = { "store-propia": propia({ shopify_token_expires_at: at(5 * MIN).toISOString(), shopify_token_retry_at: at(3 * MIN).toISOString() }) };
    expect(await use(NOW)).toBe(OLD_TOKEN);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storeWrites()).toEqual([]);
  });

  it("si otro proceso ganó el intento (la reserva no toca filas), no sale a la red", async () => {
    // La lectura ve el freno vencido; la reserva atómica la gana otro antes.
    db.stores = { "store-propia": expired() };
    const row = db.stores["store-propia"]!;
    const original = admin.from.bind(admin);
    const racing = {
      from: (table: string) => {
        const q = original(table);
        const update = q.update;
        q.update = (payload: Row) => {
          if ("shopify_token_retry_at" in payload && Object.keys(payload).length === 1) {
            row.shopify_token_retry_at = at(OWN_APP_ON_USE_RETRY_MS).toISOString();
          }
          return update(payload);
        };
        return q;
      },
    } as unknown as SupabaseClient;
    expect(await ownAppTokenForUse(racing, row as { id: string }, OLD_TOKEN, { now: NOW, fetchImpl: fetchSpy as unknown as typeof fetch })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("«Renovar ahora» y el cron no miran el freno", async () => {
    db.stores = { "store-propia": expired() };
    db.stores["store-propia"]!.shopify_token_retry_at = at(10 * MIN).toISOString();
    const r = await renewOwnAppToken(admin, "store-propia", { now: NOW, fetchImpl: fetchSpy as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true, token: NEW_TOKEN });
    expect(tokenCalls()).toHaveLength(1);
    // Al salir bien, el freno se borra.
    expect(db.stores["store-propia"]!.shopify_token_retry_at).toBeNull();
  });

  it("Kenku: ni freno ni escritura, aunque su fila no tenga las columnas", async () => {
    db.stores = { "store-kenku": kenku() };
    expect(await ownAppTokenForUse(admin, db.stores["store-kenku"] as { id: string }, OLD_TOKEN, { now: NOW })).toBe(OLD_TOKEN);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
    expect(db.reads).toEqual([]);
  });
});

// ── Un fallo viejo no pisa un éxito nuevo ────────────────────────────────────

describe("el motivo de un fallo no pisa una renovación más nueva", () => {
  const NOW = new Date("2026-10-23T15:00:00.000Z");

  it("si mientras Shopify tardaba otro guardó un token, el fallo no se anota", async () => {
    db.stores = { "store-propia": propia({ shopify_token_expires_at: new Date(NOW.getTime() + HOUR).toISOString() }) };
    const row = db.stores["store-propia"]!;
    tokenReply = () => {
      // «Probar y guardar» terminó mientras este pedido esperaba a Shopify.
      Object.assign(row, {
        shopify_token_renewed_at: new Date(NOW.getTime() + 5000).toISOString(),
        shopify_token_expires_at: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
        shopify_token_error: null,
      });
      return { status: 401, body: { error: "invalid_client" } };
    };
    const r = await renewOwnAppToken(admin, "store-propia", { now: NOW, fetchImpl: fetchSpy as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, reason: "credenciales" });
    expect(row.shopify_token_error).toBeNull();
    const errorWrite = storeWrites().find((w) => "shopify_token_error" in w.payload)!;
    expect(errorWrite.filters).toContainEqual(["or", `shopify_token_renewed_at.is.null,shopify_token_renewed_at.lt.${NOW.toISOString()}`]);
    expect(errorWrite.matched).toEqual([]);
  });

  it("sin una renovación más nueva, el fallo sí se anota", async () => {
    db.stores = { "store-propia": propia({ shopify_token_renewed_at: new Date(NOW.getTime() - 12 * HOUR).toISOString() }) };
    tokenReply = () => ({ status: 401, body: { error: "invalid_client" } });
    await renewOwnAppToken(admin, "store-propia", { now: NOW, fetchImpl: fetchSpy as unknown as typeof fetch });
    expect(String(db.stores["store-propia"]!.shopify_token_error)).toContain("Client secret");
  });
});

// ── En pausa sí, deshabilitada no ────────────────────────────────────────────

describe("una tienda propia en pausa renueva; una deshabilitada no", () => {
  const NOW = new Date("2026-10-23T15:00:00.000Z");

  it("en pausa: renueva al usar y guarda el token", async () => {
    db.stores = { "store-propia": propia({ status: "paused", shopify_token_expires_at: new Date(NOW.getTime() - MIN).toISOString() }) };
    const token = await ownAppTokenForUse(admin, db.stores["store-propia"] as { id: string }, OLD_TOKEN, {
      now: NOW,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(token).toBe(NEW_TOKEN);
    expect(db.stores["store-propia"]!.status).toBe("paused");
    expect(db.stores["store-propia"]!.shopify_token_expires_at).toBe(new Date(NOW.getTime() + 86399 * 1000).toISOString());
  });

  it("deshabilitada: ni red ni escritura, y el guardado nunca la resucita", async () => {
    db.stores = { "store-propia": propia({ status: "disabled", shopify_token_enc: null }) };
    expect(
      await ownAppTokenForUse(admin, db.stores["store-propia"] as { id: string }, null, { now: NOW, fetchImpl: fetchSpy as unknown as typeof fetch }),
    ).toBeNull();
    expect(await renewOwnAppToken(admin, "store-propia", { now: NOW, fetchImpl: fetchSpy as unknown as typeof fetch })).toMatchObject({
      ok: false,
      reason: "inactiva",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storeWrites()).toEqual([]);
  });
});

// ── El Client secret anterior ────────────────────────────────────────────────

describe("tras rotar el Client secret, el anterior firma webhooks 48 h (solo app propia)", () => {
  const body = JSON.stringify({ id: 5 });

  it("propia con el anterior dentro del plazo: acepta los dos secretos", async () => {
    db.stores = {
      "store-propia": propia({
        shopify_webhook_secret_prev_enc: encrypt(OLD_SECRET),
        shopify_webhook_secret_prev_set_at: new Date(Date.now() - HOUR).toISOString(),
      }),
    };
    for (const secret of [SECRET, OLD_SECRET]) {
      const res = await shopifyWebhook(shopifyReq("store-propia", body, { topic: "shop/update", secret }), ctx("store-propia"));
      expect(res.status, secret).toBe(200);
    }
    expect((await shopifyWebhook(shopifyReq("store-propia", body, { topic: "shop/update", secret: "otro" }), ctx("store-propia"))).status).toBe(401);
  });

  it("pasadas las 48 h, el anterior ya no vale (y ni se descifra)", async () => {
    db.stores = {
      "store-propia": propia({
        shopify_webhook_secret_prev_enc: encrypt(OLD_SECRET),
        shopify_webhook_secret_prev_set_at: new Date(Date.now() - OWN_APP_PREV_WEBHOOK_SECRET_GRACE_MS - MIN).toISOString(),
      }),
    };
    expect((await shopifyWebhook(shopifyReq("store-propia", body, { topic: "shop/update", secret: OLD_SECRET }), ctx("store-propia"))).status).toBe(401);
    expect((await getStoreCreds("store-propia", admin, { renewOwnApp: false }))?.shopify_webhook_secret_prev).toBeNull();
  });

  it("un anterior que no se descifra no tumba la tienda", async () => {
    db.stores = {
      "store-propia": propia({ shopify_webhook_secret_prev_enc: "no-es-cifrado", shopify_webhook_secret_prev_set_at: new Date().toISOString() }),
    };
    expect((await shopifyWebhook(shopifyReq("store-propia", body, { topic: "shop/update", secret: SECRET }), ctx("store-propia"))).status).toBe(200);
  });

  it("Kenku (interna) se comprueba como siempre: un «anterior» en su fila no se mira", async () => {
    // La 0271 no deja guardarlo en una interna; aunque estuviera, no cuenta.
    db.stores = {
      "store-kenku": kenku({
        shopify_webhook_secret_prev_enc: encrypt(OLD_SECRET),
        shopify_webhook_secret_prev_set_at: new Date().toISOString(),
      }),
    };
    const creds = await getStoreCreds("store-kenku", admin, { renewOwnApp: false });
    expect(Object.keys(creds!)).not.toContain("shopify_webhook_secret_prev");
    expect(Object.keys(creds!)).not.toContain("shopify_token_expires_at");
    expect(await processShopifyWebhook({ storeId: "store-kenku", topic: "shop/update", rawBody: body, hmacHeader: hmac(body, OLD_SECRET) }, admin)).toEqual({
      status: "unauthorized",
    });
    expect(
      await processShopifyWebhook({ storeId: "store-kenku", topic: "shop/update", rawBody: body, hmacHeader: hmac(body, "secreto-interna") }, admin),
    ).toMatchObject({ status: "ok" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storeWrites()).toEqual([]);
  });

  it("ownAppCredsForUse devuelve a Kenku tal cual, sin base ni red", async () => {
    db.stores = { "store-kenku": kenku() };
    const creds = (await getStoreCreds("store-kenku", admin, { renewOwnApp: false }))!;
    db.reads = [];
    expect(await ownAppCredsForUse(admin, creds)).toBe(creds);
    expect(db.reads).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
