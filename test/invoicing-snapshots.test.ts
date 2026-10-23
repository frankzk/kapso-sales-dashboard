// La foto de los pedidos de Shopify para sus boletas (MOM §35.10, owner
// 23-10-2026): el barrido (lib/invoicing/snapshots.ts), su ruta
// (app/api/cron/invoice-snapshots/route.ts) y su lugar en vercel.json.
//
// Lo que se fija: que guarda EXACTAMENTE lo que contesta ORDER_FOR_INVOICE_QUERY,
// solo de las tiendas que facturan, desde el piso del 29-08-2026; que deja cupo
// de Shopify para lo demás y se corta a tiempo; que una falla de Shopify corta
// la tienda sin marcar nada; que con `dry` no llama a Shopify ni escribe; que sin
// la 0274 no se ve rojo; y que la línea de log solo lleva conteos. La base y la
// red son falsas: nunca se llama a Shopify.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ORDER_FOR_INVOICE_QUERY } from "@/lib/invoicing/shopify-order";
import {
  INVOICE_SNAPSHOT_BUDGET_MS,
  INVOICE_SNAPSHOT_MAX_PER_STORE,
  INVOICE_SNAPSHOT_SINCE,
  InvoiceSnapshotMigrationMissingError,
  SHOPIFY_SHUTDOWN_AT,
  isInvoiceSnapshotMigrationMissing,
  runInvoiceSnapshotSweep,
  snapshotWaitMs,
  type InvoiceSnapshotDeps,
  type InvoiceSnapshotReport,
} from "@/lib/invoicing/snapshots";

const TOKEN = "shpat_prueba_no_es_real";
const KENKU = "11111111-1111-4111-8111-111111111111";
const AURELA = "22222222-2222-4222-8222-222222222222";
const CLIENTE = "33333333-3333-4333-8333-333333333333";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: unknown };

interface Call {
  fn: string;
  args: Row;
}

interface World {
  issuers: Row[];
  stores: Row[];
  candidates: Record<string, Row[]>;
  candidatesError?: unknown;
  putResult?: (args: Row) => Result;
  rpcs: Call[];
  storeFilters: [string, string, unknown][];
}

function world(over: Partial<World> = {}): World {
  return {
    issuers: [{ org_id: "org-gf" }],
    stores: [
      { id: KENKU, org_id: "org-gf", status: "active" },
      { id: AURELA, org_id: "org-gf", status: "active" },
      { id: CLIENTE, org_id: "org-cliente", status: "active" },
    ],
    candidates: {},
    rpcs: [],
    storeFilters: [],
    ...over,
  };
}

/** Admin falso: lee emisores y tiendas, y contesta las dos funciones de la 0274. */
function adminOf(w: World): SupabaseClient {
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    const q: Record<string, unknown> = {
      select: () => q,
      in: (col: string, vals: unknown) => {
        filters.push([`in:${col}`, vals]);
        return q;
      },
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return q;
      },
      then(ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) {
        let result: Result = { data: [], error: null };
        if (table === "invoice_issuers") result = { data: w.issuers, error: null };
        if (table === "stores") {
          for (const [c, v] of filters) w.storeFilters.push([table, c, v]);
          const orgIds = (filters.find(([c]) => c === "in:org_id")?.[1] ?? []) as string[];
          const status = filters.find(([c]) => c === "status")?.[1];
          const id = filters.find(([c]) => c === "id")?.[1];
          result = {
            data: w.stores.filter(
              (s) => orgIds.includes(s.org_id as string) && (!status || s.status === status) && (!id || s.id === id),
            ),
            error: null,
          };
        }
        return Promise.resolve(result).then(ok, fail);
      },
    };
    return q;
  };
  const rpc = async (fn: string, args: Row): Promise<Result> => {
    w.rpcs.push({ fn, args });
    if (fn === "invoice_snapshot_candidates") {
      if (w.candidatesError) return { data: null, error: w.candidatesError };
      return { data: w.candidates[args.p_store as string] ?? [], error: null };
    }
    if (fn === "invoice_snapshot_put") return w.putResult ? w.putResult(args) : { data: true, error: null };
    return { data: null, error: { message: `rpc ${fn}` } };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const cand = (n: number, refresh = false): Row => ({
  order_id: `ord-${n}`,
  shopify_order_id: `61000000000${String(n).padStart(2, "0")}`,
  refresh,
});
const gidOf = (c: Row) => `gid://shopify/Order/${c.shopify_order_id as string}`;

/** Un nodo de Shopify cualquiera: la foto no lo mira, lo guarda tal cual. */
const nodeFor = (gid: string): Row => ({ id: gid, name: "#KP140001", test: false, lineItems: { nodes: [] } });

const COST = (available: number, requested = 400) => ({
  requestedQueryCost: requested,
  actualQueryCost: 30,
  throttleStatus: { maximumAvailable: 1000, currentlyAvailable: available, restoreRate: 50 },
});

interface Sent {
  url: string;
  token: string;
  body: { query: string; variables: { id: string } };
  signal: unknown;
}

/** Shopify falso: contesta cada gid con `respond`. */
function shopify(respond: (gid: string, n: number) => { status?: number; payload: unknown }) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const i = init as { headers: Record<string, string>; body: string; signal?: unknown };
    const body = JSON.parse(i.body) as Sent["body"];
    sent.push({ url: String(url), token: i.headers["X-Shopify-Access-Token"]!, body, signal: i.signal });
    const { status = 200, payload } = respond(body.variables.id, sent.length);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

/** Reloj falso: `sleep` lo adelanta. */
function deps(fetchImpl: typeof fetch, over: Partial<InvoiceSnapshotDeps> = {}) {
  const clock = { t: Date.parse("2026-10-24T15:04:00.000Z") };
  const sleeps: number[] = [];
  const d: InvoiceSnapshotDeps = {
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    conn: async (storeId) => ({ domain: `${storeId.slice(0, 4)}.myshopify.com`, token: TOKEN }),
    fetchImpl,
    ...over,
  };
  return { d, clock, sleeps };
}

const puts = (w: World) => w.rpcs.filter((c) => c.fn === "invoice_snapshot_put").map((c) => c.args);

describe("runInvoiceSnapshotSweep: qué guarda", () => {
  it("lo que contesta ORDER_FOR_INVOICE_QUERY, tal cual, con la hora en que se pidió", async () => {
    const w = world({ candidates: { [KENKU]: [cand(1), cand(2, true)] } });
    const { fetchImpl, sent } = shopify((gid) => ({ payload: { data: { order: nodeFor(gid) }, extensions: { cost: COST(990) } } }));
    const { d } = deps(fetchImpl);

    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, d);

    // La misma llamada que la boleta: la consulta, el gid, el token y su tope.
    expect(sent.map((s) => s.body)).toEqual([
      { query: ORDER_FOR_INVOICE_QUERY, variables: { id: gidOf(cand(1)) } },
      { query: ORDER_FOR_INVOICE_QUERY, variables: { id: gidOf(cand(2)) } },
    ]);
    expect(sent.every((s) => s.token === TOKEN && s.signal instanceof AbortSignal)).toBe(true);
    expect(puts(w)).toEqual([
      {
        p_order: "ord-1",
        p_store: KENKU,
        p_gid: gidOf(cand(1)),
        p_payload: { order: nodeFor(gidOf(cand(1))) },
        p_fetched_at: "2026-10-24T15:04:00.000Z",
      },
      {
        p_order: "ord-2",
        p_store: KENKU,
        p_gid: gidOf(cand(2)),
        p_payload: { order: nodeFor(gidOf(cand(2))) },
        p_fetched_at: "2026-10-24T15:04:00.000Z",
      },
    ]);
    expect(report.stores).toEqual([
      { storeId: KENKU, candidates: 2, saved: 1, refreshed: 1, notFound: 0, skipped: 0, pending: 0, stopped: null },
    ]);
    expect(report.errors).toEqual([]);
  });

  it("pide los candidatos desde el 29-08-2026, el cierre menos los 60 días del barrido de boletas", async () => {
    expect(INVOICE_SNAPSHOT_SINCE).toBe("2026-08-29T00:00:00.000Z");
    expect(Date.parse(SHOPIFY_SHUTDOWN_AT) - Date.parse(INVOICE_SNAPSHOT_SINCE)).toBe(60 * 86_400_000);
    const w = world();
    const { fetchImpl } = shopify(() => ({ payload: {} }));
    await runInvoiceSnapshotSweep(adminOf(w), {}, deps(fetchImpl).d);
    expect(w.rpcs).toEqual([
      { fn: "invoice_snapshot_candidates", args: { p_store: KENKU, p_since: INVOICE_SNAPSHOT_SINCE, p_limit: INVOICE_SNAPSHOT_MAX_PER_STORE } },
      { fn: "invoice_snapshot_candidates", args: { p_store: AURELA, p_since: INVOICE_SNAPSHOT_SINCE, p_limit: INVOICE_SNAPSHOT_MAX_PER_STORE } },
    ]);
  });

  it("solo las tiendas activas de una organización que factura: una tienda cliente no se toca", async () => {
    const w = world({ candidates: { [CLIENTE]: [cand(9)] } });
    const { fetchImpl, sent } = shopify(() => ({ payload: {} }));
    const report = await runInvoiceSnapshotSweep(adminOf(w), {}, deps(fetchImpl).d);
    expect(report.stores.map((s) => s.storeId)).toEqual([KENKU, AURELA].sort());
    expect(sent).toEqual([]);
    expect(w.storeFilters).toEqual(
      expect.arrayContaining([
        ["stores", "in:org_id", ["org-gf"]],
        ["stores", "status", "active"],
      ]),
    );
    // Con ?storeId de una tienda cliente, nada.
    const solo = await runInvoiceSnapshotSweep(adminOf(world()), { storeId: CLIENTE }, deps(fetchImpl).d);
    expect(solo.stores).toEqual([]);
  });

  it("un pedido que Shopify no devolvió se guarda como `{ order: null }`: no vuelve a ocupar la cola", async () => {
    const w = world({ candidates: { [KENKU]: [cand(1)] } });
    const { fetchImpl } = shopify(() => ({ payload: { data: { order: null } } }));
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(fetchImpl).d);
    expect(puts(w)[0]!.p_payload).toEqual({ order: null });
    expect(report.stores[0]).toMatchObject({ saved: 1, notFound: 1, stopped: null });
  });

  it("lo que la base no guarda (una foto más nueva, o el pedido ya no es de Shopify) se cuenta aparte", async () => {
    const w = world({ candidates: { [KENKU]: [cand(1)] }, putResult: () => ({ data: false, error: null }) });
    const { fetchImpl } = shopify((gid) => ({ payload: { data: { order: nodeFor(gid) } } }));
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(fetchImpl).d);
    expect(report.stores[0]).toMatchObject({ saved: 0, skipped: 1, stopped: null });
  });

  it("con `dry` solo cuenta: no llama a Shopify ni escribe", async () => {
    const w = world({ candidates: { [KENKU]: [cand(1), cand(2)] } });
    const { fetchImpl, sent } = shopify(() => ({ payload: {} }));
    const conn = vi.fn(async () => ({ domain: "x", token: TOKEN }));
    const report = await runInvoiceSnapshotSweep(adminOf(w), { dry: true, storeId: KENKU }, deps(fetchImpl, { conn }).d);
    expect(sent).toEqual([]);
    expect(conn).not.toHaveBeenCalled();
    expect(puts(w)).toEqual([]);
    expect(report).toMatchObject({ dry: true, stores: [{ storeId: KENKU, candidates: 2, pending: 2, stopped: null }] });
  });
});

describe("runInvoiceSnapshotSweep: cuando Shopify falla, la tienda para y nada se marca", () => {
  const run = async (respond: Parameters<typeof shopify>[0]) => {
    const w = world({ candidates: { [KENKU]: [cand(1), cand(2), cand(3)] } });
    const { fetchImpl, sent } = shopify(respond);
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(fetchImpl).d);
    return { w, sent, report, store: report.stores[0]! };
  };

  it("la tienda dada de baja (HTTP 402): para con su motivo, sin rojo", async () => {
    const { w, sent, report, store } = await run(() => ({ status: 402, payload: { errors: "Unavailable Shop" } }));
    expect(sent).toHaveLength(1);
    expect(puts(w)).toEqual([]);
    expect(store).toMatchObject({ stopped: "tienda_caida", detail: "Shopify contestó HTTP 402.", pending: 3, saved: 0 });
    expect(report.errors).toEqual([]);
  });

  it("un 5xx a mitad: lo guardado queda y el resto entra la próxima vez", async () => {
    const { w, store } = await run((gid, n) => (n === 2 ? { status: 503, payload: {} } : { payload: { data: { order: nodeFor(gid) } } }));
    expect(puts(w).map((p) => p.p_order)).toEqual(["ord-1"]);
    expect(store).toMatchObject({ saved: 1, stopped: "shopify", detail: "Shopify contestó HTTP 503.", pending: 2 });
  });

  it("THROTTLED: para por cupo", async () => {
    const { store } = await run(() => ({
      payload: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: COST(10) } },
    }));
    expect(store).toMatchObject({ stopped: "cuota", pending: 3 });
  });

  it("una respuesta sin `order`, o con otro pedido, no se guarda", async () => {
    const sinOrder = await run(() => ({ payload: { data: {} } }));
    expect(puts(sinOrder.w)).toEqual([]);
    expect(sinOrder.store).toMatchObject({ stopped: "shopify", detail: "Shopify contestó sin el pedido." });

    const otro = await run(() => ({ payload: { data: { order: nodeFor("gid://shopify/Order/1") } } }));
    expect(puts(otro.w)).toEqual([]);
    expect(otro.store).toMatchObject({ stopped: "shopify", detail: "Shopify devolvió otro pedido." });
  });

  it("una tienda sin token no tiene a quién preguntar", async () => {
    const w = world({ candidates: { [KENKU]: [cand(1)] } });
    const { fetchImpl, sent } = shopify(() => ({ payload: {} }));
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(fetchImpl, { conn: async () => null }).d);
    expect(sent).toEqual([]);
    expect(report.stores[0]).toMatchObject({ stopped: "sin_shopify", pending: 1 });
    expect(report.errors).toEqual([]);
  });

  it("el token no aparece en el reporte", async () => {
    const { report } = await run(() => ({ status: 401, payload: { errors: TOKEN } }));
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });
});

describe("runInvoiceSnapshotSweep: el cupo de Shopify y el tiempo", () => {
  it("espera a que la tienda tenga el cupo de la consulta más la reserva", () => {
    const bucket = { requested: 400, available: 500, max: 1000, restore: 50, at: 0 };
    // Necesita 400 + 25 % de 1000 = 650; tiene 500: faltan 150 a 50 por segundo.
    expect(snapshotWaitMs(bucket, 0)).toBe(3_000);
    expect(snapshotWaitMs(bucket, 3_000)).toBe(0);
    // Una consulta que pide casi todo el cupo espera al cupo lleno, no para siempre.
    expect(snapshotWaitMs({ ...bucket, requested: 950, available: 900 }, 0)).toBe(2_000);
    expect(snapshotWaitMs(null, 0)).toBe(0);
    expect(snapshotWaitMs({ ...bucket, restore: 0 }, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("entre pedidos duerme lo que falta; con cupo de sobra, no", async () => {
    const w = world({ candidates: { [KENKU]: [cand(1), cand(2), cand(3)] } });
    const { fetchImpl } = shopify((gid, n) => ({
      payload: { data: { order: nodeFor(gid) }, extensions: { cost: COST(n === 1 ? 970 : 600) } },
    }));
    const { d, sleeps } = deps(fetchImpl);
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, d);
    // Tras el 1.º quedan 970 (≥ 650): sigue. Tras el 2.º quedan 600: 1 s.
    expect(sleeps).toEqual([1_000]);
    expect(report.stores[0]).toMatchObject({ saved: 3, stopped: null });
  });

  it("si esperar el cupo se pasa del tiempo de la pasada, para por cupo", async () => {
    const w = world({ candidates: { [KENKU]: [cand(1), cand(2)] } });
    const { fetchImpl } = shopify((gid) => ({ payload: { data: { order: nodeFor(gid) }, extensions: { cost: COST(0) } } }));
    const { d, sleeps } = deps(fetchImpl);
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, d);
    // Faltan 650 a 50 por segundo: 13 s, dentro de los 20 s. Cada pedido deja
    // el cupo en 0 otra vez, así que el tercero ya no cabría; aquí hay dos.
    expect(sleeps).toEqual([13_000]);
    expect(report.stores[0]).toMatchObject({ saved: 2, stopped: null });

    const w3 = world({ candidates: { [KENKU]: [cand(1), cand(2), cand(3)] } });
    const third = deps(fetchImpl);
    const r3 = await runInvoiceSnapshotSweep(adminOf(w3), { storeId: KENKU }, third.d);
    expect(third.sleeps).toEqual([13_000]);
    expect(r3.stores[0]).toMatchObject({ saved: 2, stopped: "cuota", pending: 1 });
  });

  it(`no empieza otro pedido pasados ${INVOICE_SNAPSHOT_BUDGET_MS / 1000} s`, async () => {
    const w = world({ candidates: { [KENKU]: [cand(1), cand(2)] } });
    const box: { clock?: { t: number } } = {};
    const { fetchImpl } = shopify((gid) => {
      box.clock!.t += INVOICE_SNAPSHOT_BUDGET_MS + 1; // la lectura tardó
      return { payload: { data: { order: nodeFor(gid) } } };
    });
    const { d, clock } = deps(fetchImpl);
    box.clock = clock;
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, d);
    expect(report.stores[0]).toMatchObject({ saved: 1, stopped: "presupuesto", pending: 1 });
  });

  it("dos tiendas en la misma pasada, cada una con su reporte", async () => {
    const w = world({ candidates: { [KENKU]: [cand(1)], [AURELA]: [cand(2)] } });
    const { fetchImpl, sent } = shopify((gid) => ({ payload: { data: { order: nodeFor(gid) } } }));
    const report = await runInvoiceSnapshotSweep(adminOf(w), {}, deps(fetchImpl).d);
    expect(sent).toHaveLength(2);
    expect(report.stores.map((s) => [s.storeId, s.saved])).toEqual([
      [KENKU, 1],
      [AURELA, 1],
    ]);
  });
});

describe("runInvoiceSnapshotSweep: la base", () => {
  it("si no puede guardar, lo dice (rojo) sin repetir valores de la base", async () => {
    const w = world({
      candidates: { [KENKU]: [cand(1), cand(2)] },
      putResult: () => ({ data: null, error: { code: "23503", message: "Key (order_id)=(ord-1) is not present" } }),
    });
    const { fetchImpl } = shopify((gid) => ({ payload: { data: { order: nodeFor(gid) } } }));
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(fetchImpl).d);
    expect(report.errors).toEqual(["No se pudo guardar la foto de un pedido (23503)."]);
    expect(report.stores[0]).toMatchObject({ stopped: "base", pending: 2 });
  });

  it("sin la 0274 lanza `InvoiceSnapshotMigrationMissingError`; otra cosa que falta, no", async () => {
    const missing = { code: "PGRST202", message: "Could not find the function public.invoice_snapshot_candidates(p_limit, p_since, p_store) in the schema cache" };
    const w = world({ candidatesError: missing });
    const { fetchImpl } = shopify(() => ({ payload: {} }));
    const err = await runInvoiceSnapshotSweep(adminOf(w), {}, deps(fetchImpl).d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceSnapshotMigrationMissingError);
    expect(isInvoiceSnapshotMigrationMissing(err)).toBe(true);
    expect(isInvoiceSnapshotMigrationMissing(missing)).toBe(true);
    expect(isInvoiceSnapshotMigrationMissing({ code: "42P01", message: 'relation "orders" does not exist' })).toBe(false);
    expect(isInvoiceSnapshotMigrationMissing({ code: "42703", message: "invoice_snapshot_put" })).toBe(false);
  });
});

// ── La ruta ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  admin: { soy: "admin" } as unknown,
  report: null as unknown,
  throws: null as unknown,
}));

vi.mock("@/lib/db", () => ({ createAdminSupabase: vi.fn(() => mocks.admin) }));
vi.mock("@/lib/invoicing/snapshots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/invoicing/snapshots")>();
  return {
    ...actual,
    // Las pruebas de arriba llaman al barrido de verdad con su base falsa; la
    // ruta, a este doble.
    runInvoiceSnapshotSweep: vi.fn(async (...args: Parameters<typeof actual.runInvoiceSnapshotSweep>) => {
      if (args[0] === mocks.admin) {
        if (mocks.throws) throw mocks.throws;
        return mocks.report;
      }
      return actual.runInvoiceSnapshotSweep(...args);
    }),
  };
});

const route = await import("@/app/api/cron/invoice-snapshots/route");
const { runInvoiceSnapshotSweep: sweepMock } = await import("@/lib/invoicing/snapshots");

function routeReport(over: Partial<InvoiceSnapshotReport> = {}): InvoiceSnapshotReport {
  return {
    dry: false,
    at: "2026-10-24T15:04:00.000Z",
    since: INVOICE_SNAPSHOT_SINCE,
    stores: [{ storeId: KENKU, candidates: 3, saved: 3, refreshed: 0, notFound: 0, skipped: 0, pending: 0, stopped: null }],
    errors: [],
    ...over,
  };
}

const req = (q = "", auth: string | null = "Bearer cron") =>
  new NextRequest(`https://kapta.test/api/cron/invoice-snapshots${q}`, { headers: auth ? { authorization: auth } : {} });

describe("/api/cron/invoice-snapshots", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "cron");
    vi.stubEnv("VERCEL_ENV", "production");
    mocks.report = routeReport();
    mocks.throws = null;
    vi.mocked(sweepMock).mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("corre en Node, sin caché y con 60 s, por GET y por POST", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBe(60);
    expect(route.POST).toBe(route.GET);
  });

  it("sin el secreto del cron: 401 y no corre", async () => {
    expect((await route.GET(req("", null))).status).toBe(401);
    expect((await route.GET(req("", "Bearer otro"))).status).toBe(401);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("fuera de producción no llama a Shopify; con ?dry=1 sí corre, en prueba", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const res = await route.GET(req());
    expect(await res.json()).toEqual({ skipped: "not_production" });
    expect(sweepMock).not.toHaveBeenCalled();
    mocks.report = routeReport({ dry: true });
    const dry = await route.GET(req("?dry=1"));
    expect(dry.status).toBe(200);
    expect(sweepMock).toHaveBeenCalledWith(mocks.admin, { dry: true });
  });

  it("?storeId: solo un uuid", async () => {
    expect((await route.GET(req(`?storeId=${KENKU}`))).status).toBe(200);
    expect(sweepMock).toHaveBeenLastCalledWith(mocks.admin, { dry: false, storeId: KENKU });
    for (const bad of ["abc", `${KENKU}x`, ""]) expect((await route.GET(req(`?storeId=${bad}`))).status, bad).toBe(400);
  });

  it("una línea de log con el reporte; con errores de la base, 502", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ok = await route.GET(req());
    expect(ok.status).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(line.startsWith("[invoice-snapshots] ")).toBe(true);
    expect(JSON.parse(line.slice("[invoice-snapshots] ".length))).toEqual(mocks.report);

    mocks.report = routeReport({ errors: ["No se pudo guardar la foto de un pedido (23503)."] });
    expect((await route.GET(req())).status).toBe(502);
  });

  it("una tienda que Shopify ya dio de baja no pone el cron en rojo", async () => {
    mocks.report = routeReport({
      stores: [
        { storeId: KENKU, candidates: 3, saved: 0, refreshed: 0, notFound: 0, skipped: 0, pending: 3, stopped: "tienda_caida", detail: "Shopify contestó HTTP 402." },
      ],
    });
    expect((await route.GET(req())).status).toBe(200);
  });

  it("sin la 0274: 200 con `sin_migracion`", async () => {
    mocks.throws = new InvoiceSnapshotMigrationMissingError();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await route.GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dry: false, skipped: "sin_migracion" });
  });

  it("si la pasada lanza otra cosa: 500, sin el mensaje (puede citar valores)", async () => {
    mocks.throws = new Error("se cayó leyendo 987654321");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await route.GET(req());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("987654321");
    expect(JSON.stringify(log.mock.calls)).not.toContain("987654321");
  });
});

describe("vercel.json: la foto de los pedidos", () => {
  const crons = (
    JSON.parse(readFileSync(resolve(__dirname, "../vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] }
  ).crons;

  it("cada 10 minutos, en los minutos 4, 14, 24, 34, 44 y 54", () => {
    expect(crons).toContainEqual({ path: "/api/cron/invoice-snapshots", schedule: "4,14,24,34,44,54 * * * *" });
  });

  it("no cae en el minuto de ningún cron que corre cada hora o más seguido (ni en el :00)", () => {
    const minutesOf = (schedule: string): number[] => {
      const [minute, hour] = schedule.split(" ");
      if (hour !== "*" && !hour!.startsWith("*/")) return [];
      if (minute === "*") return Array.from({ length: 60 }, (_, i) => i);
      if (minute!.startsWith("*/")) {
        const step = Number(minute!.slice(2));
        return Array.from({ length: 60 / step }, (_, i) => i * step);
      }
      return minute!.split(",").map(Number);
    };
    const mine = new Set(minutesOf("4,14,24,34,44,54 * * * *"));
    expect(mine.has(0)).toBe(false);
    for (const c of crons.filter((x) => x.path !== "/api/cron/invoice-snapshots")) {
      for (const m of minutesOf(c.schedule)) expect(mine.has(m), `${c.path} en el minuto ${m}`).toBe(false);
    }
  });
});

describe("la regla está escrita (MOM §35.10, DEPLOY.md)", () => {
  const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");
  const deploy = readFileSync(resolve(process.cwd(), "DEPLOY.md"), "utf8");
  const sql = readFileSync(resolve(process.cwd(), "db/migrations/0274_invoice_snapshots.sql"), "utf8");

  it("el MOM tiene la decisión del owner con su fecha y lo que cambia", () => {
    expect(mom).toContain("### 35.10 La foto del pedido para cuando Shopify ya no responde (owner, 23-10-2026)");
    expect(mom).toContain("order_invoice_snapshots");
    expect(mom).toContain("foto_shopify");
  });

  it("DEPLOY.md dice cómo aplicar la 0274, después de la 0273", () => {
    expect(deploy).toContain("0274_invoice_snapshots.sql");
    expect(deploy.indexOf("0274_invoice_snapshots.sql")).toBeGreaterThan(-1);
  });

  it("la 0274 se detiene sin la 0273 y no deja a anon ni authenticated", () => {
    expect(sql).toContain("falta la 0273 (orders.platform)");
    expect(sql).toContain("revoke all on order_invoice_snapshots from anon, authenticated;");
    expect(sql).toContain("o.platform = 'shopify'");
  });
});
