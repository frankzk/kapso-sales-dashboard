// La foto de los pedidos de Shopify para sus boletas (MOM §35.10, owner
// 23-10-2026): el barrido (lib/invoicing/snapshots.ts), su ruta
// (app/api/cron/invoice-snapshots/route.ts) y su lugar en vercel.json.
//
// Lo que se fija: que guarda EXACTAMENTE lo que contestaría
// ORDER_FOR_INVOICE_QUERY (varios pedidos por llamada con los mismos campos, y
// de a uno con la consulta de la boleta lo que el lote no trae completo), solo
// de las tiendas que facturan, desde el piso del 29-08-2026; que deja a la
// tienda un cuarto del balde y de la reposición; que una falla de la tienda la
// para y una de un pedido no tapa la cola; que dos pasadas no se pisan; que con
// `dry` no llama a Shopify ni escribe; que sin la 0275 no se ve rojo; y que la
// línea de log lleva el ritmo y solo conteos. La base y la red son falsas:
// nunca se llama a Shopify.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ORDER_FOR_INVOICE_QUERY, SHOPIFY_READ_TIMEOUT_MS } from "@/lib/invoicing/shopify-order";
import {
  INVOICE_SNAPSHOT_ALERT_FAILS,
  INVOICE_SNAPSHOT_BATCH_PAGES,
  INVOICE_SNAPSHOT_BUDGET_MS,
  INVOICE_SNAPSHOT_KEPT_DETAIL,
  INVOICE_SNAPSHOT_LEASE_S,
  INVOICE_SNAPSHOT_MAX_BATCH,
  INVOICE_SNAPSHOT_MAX_CONSECUTIVE_FAILS,
  INVOICE_SNAPSHOT_MAX_DURATION_S,
  INVOICE_SNAPSHOT_MAX_PER_STORE,
  INVOICE_READ_POINTS,
  INVOICE_SNAPSHOT_RESERVE,
  INVOICE_SNAPSHOT_SINCE,
  InvoiceSnapshotMigrationMissingError,
  ORDERS_FOR_INVOICE_BATCH_QUERY,
  SHOPIFY_MAX_QUERY_COST,
  SHOPIFY_SHUTDOWN_AT,
  batchSelection,
  isCompleteBatchNode,
  isInvoiceSnapshotMigrationMissing,
  orderForInvoiceSelection,
  runInvoiceSnapshotSweep,
  snapshotBatchSize,
  snapshotReservePoints,
  snapshotWaitMs,
  type InvoiceSnapshotDeps,
  type InvoiceSnapshotReport,
  type InvoiceSnapshotStoreReport,
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
  /** Lo que contesta `invoice_snapshot_lease` (por defecto, el turno libre). */
  lease?: (args: Row) => Result;
  /** Lo que contesta `invoice_snapshot_failed` (por defecto, 0 alertas). */
  failedResult?: (args: Row) => Result;
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

/** Admin falso: lee emisores y tiendas, y contesta las funciones de la 0275. */
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
    if (fn === "invoice_snapshot_lease") return w.lease ? w.lease(args) : { data: true, error: null };
    if (fn === "invoice_snapshot_release") return { data: null, error: null };
    if (fn === "invoice_snapshot_failed") return w.failedResult ? w.failedResult(args) : { data: 0, error: null };
    return { data: null, error: { message: `rpc ${fn}` } };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const cand = (n: number, refresh = false): Row => ({
  order_id: `ord-${n}`,
  shopify_order_id: `61000000000${String(n).padStart(2, "0")}`,
  refresh,
});
const cands = (from: number, to: number): Row[] => Array.from({ length: to - from + 1 }, (_, k) => cand(from + k));
const gidOf = (c: Row) => `gid://shopify/Order/${c.shopify_order_id as string}`;

/** Un nodo completo de Shopify: la foto no lo mapea, lo guarda tal cual. */
const nodeFor = (gid: string, over: Row = {}): Row => ({
  id: gid,
  name: "#KP140001",
  test: false,
  transactions: [],
  lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: "gid://shopify/LineItem/1", title: "Faja" }] },
  shippingLines: { nodes: [{ title: "Envío" }] },
  ...over,
});

const COST = (available: number, requested = 400, actual: number | null = 30, max = 1000, restore = 50) => ({
  requestedQueryCost: requested,
  actualQueryCost: actual,
  throttleStatus: { maximumAvailable: max, currentlyAvailable: available, restoreRate: restore },
});

interface Sent {
  url: string;
  token: string;
  body: { query: string; variables: { id?: string; ids?: string[] } };
  signal: unknown;
}

interface Ask {
  /** Los gids del lote, o null si es la consulta de un pedido. */
  ids: string[] | null;
  /** El gid de la consulta de un pedido, o null si es un lote. */
  id: string | null;
  n: number;
}

type Reply = { status?: number; payload: unknown; throws?: unknown };

/** Shopify falso. Por defecto contesta todo bien, con nodos completos. */
function shopify(respond?: (ask: Ask) => Reply) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const i = init as { headers: Record<string, string>; body: string; signal?: unknown };
    const body = JSON.parse(i.body) as Sent["body"];
    sent.push({ url: String(url), token: i.headers["X-Shopify-Access-Token"]!, body, signal: i.signal });
    const ask: Ask = { ids: body.variables.ids ?? null, id: body.variables.id ?? null, n: sent.length };
    const reply: Reply = respond
      ? respond(ask)
      : ask.ids
        ? { payload: { data: { nodes: ask.ids.map((g) => nodeFor(g)) } } }
        : { payload: { data: { order: nodeFor(ask.id!) } } };
    if (reply.throws) throw reply.throws;
    const { status = 200, payload } = reply;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

/** Lo que contesta un lote: cada gid con su nodo. */
const batchOf = (ids: string[], cost?: unknown, nodeOver: (gid: string) => Row | null = (g) => nodeFor(g)): Reply => ({
  payload: { data: { nodes: ids.map(nodeOver) }, ...(cost ? { extensions: { cost } } : {}) },
});

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
    holder: () => "pasada-1",
    ...over,
  };
  return { d, clock, sleeps };
}

const puts = (w: World) => w.rpcs.filter((c) => c.fn === "invoice_snapshot_put").map((c) => c.args);
const failedCalls = (w: World) => w.rpcs.filter((c) => c.fn === "invoice_snapshot_failed").map((c) => c.args);
const sizes = (sent: Sent[]) => sent.map((s) => (s.body.variables.ids ? s.body.variables.ids.length : `1:${s.body.variables.id}`));

describe("la consulta del lote: los campos de la boleta", () => {
  it("es ORDER_FOR_INVOICE_QUERY con páginas más cortas: mismos campos, mismo orden", () => {
    const sel = orderForInvoiceSelection();
    const batch = batchSelection(sel);
    expect(INVOICE_SNAPSHOT_BATCH_PAGES).toEqual({ lineItems: 10, transactions: 10, shippingLines: 5 });
    expect(batch).toContain("transactions(first: 10)");
    expect(batch).toContain("lineItems(first: 10)");
    expect(batch).toContain("shippingLines(first: 5, includeRemovals: true)");
    // Devolviéndole las páginas de la boleta, es la boleta, letra por letra.
    expect(
      batch
        .replace("transactions(first: 10)", "transactions(first: 20)")
        .replace("lineItems(first: 10)", "lineItems(first: 100)")
        .replace("shippingLines(first: 5,", "shippingLines(first: 10,"),
    ).toBe(sel);
    expect(ORDERS_FOR_INVOICE_BATCH_QUERY).toContain("nodes(ids: $ids)");
    expect(ORDERS_FOR_INVOICE_BATCH_QUERY).toContain(`... on Order {${batch}}`);
    // Nada de la clienta, igual que la boleta.
    expect(ORDERS_FOR_INVOICE_BATCH_QUERY).not.toMatch(/customer|email|phone|address/i);
  });

  it("un nodo es completo solo si ninguna página corta se llenó", () => {
    const g = "gid://shopify/Order/1";
    expect(isCompleteBatchNode(nodeFor(g))).toBe(true);
    expect(isCompleteBatchNode(nodeFor(g, { lineItems: { pageInfo: { hasNextPage: true }, nodes: [] } }))).toBe(false);
    expect(isCompleteBatchNode(nodeFor(g, { transactions: Array.from({ length: 9 }, () => ({})) }))).toBe(true);
    expect(isCompleteBatchNode(nodeFor(g, { transactions: Array.from({ length: 10 }, () => ({})) }))).toBe(false);
    expect(isCompleteBatchNode(nodeFor(g, { shippingLines: { nodes: Array.from({ length: 4 }, () => ({})) } }))).toBe(true);
    expect(isCompleteBatchNode(nodeFor(g, { shippingLines: { nodes: Array.from({ length: 5 }, () => ({})) } }))).toBe(false);
    expect(isCompleteBatchNode(nodeFor(g, { lineItems: undefined }))).toBe(false);
    expect(isCompleteBatchNode(null)).toBe(false);
  });
});

describe("runInvoiceSnapshotSweep: qué guarda", () => {
  it("varios pedidos por llamada (la primera de la pasada, uno); guarda `{ order: nodo }` tal cual, con la hora en que se pidió", async () => {
    const w = world({ candidates: { [KENKU]: [cand(1), cand(2, true), cand(3)] } });
    // Cada pedido del lote pide 40 puntos; balde de 2000 lleno.
    const { fetchImpl, sent } = shopify((ask) => batchOf(ask.ids!, COST(2000, ask.ids!.length * 40, 0, 2000, 100)));
    const { d } = deps(fetchImpl);

    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, d);

    expect(sent.map((s) => s.body)).toEqual([
      { query: ORDERS_FOR_INVOICE_BATCH_QUERY, variables: { ids: [gidOf(cand(1))] } },
      { query: ORDERS_FOR_INVOICE_BATCH_QUERY, variables: { ids: [gidOf(cand(2)), gidOf(cand(3))] } },
    ]);
    expect(sent.every((s) => s.token === TOKEN && s.signal instanceof AbortSignal)).toBe(true);
    const at = "2026-10-24T15:04:00.000Z";
    expect(puts(w)).toEqual([
      { p_order: "ord-1", p_store: KENKU, p_gid: gidOf(cand(1)), p_payload: { order: nodeFor(gidOf(cand(1))) }, p_fetched_at: at },
      { p_order: "ord-2", p_store: KENKU, p_gid: gidOf(cand(2)), p_payload: { order: nodeFor(gidOf(cand(2))) }, p_fetched_at: at },
      { p_order: "ord-3", p_store: KENKU, p_gid: gidOf(cand(3)), p_payload: { order: nodeFor(gidOf(cand(3))) }, p_fetched_at: at },
    ]);
    expect(report.stores).toEqual([
      {
        storeId: KENKU,
        candidates: 3,
        saved: 2,
        refreshed: 1,
        notFound: 0,
        skipped: 0,
        kept: 0,
        failed: 0,
        pending: 0,
        stopped: null,
        calls: 2,
        batch: 2,
        // Lo que pidieron las dos llamadas (40 + 80) y lo que gastaron.
        points: { requested: 120, actual: 0 },
        ms: 0,
        quota: { max: 2000, restore: 100, available: 2000 },
      },
    ]);
    expect(report).toMatchObject({ orders: 3, errors: [] });
  });

  it("nunca pisa una foto buena con `{ order: null }`: la base la conserva, se cuenta en `kept` y el pedido espera, sin rojo", async () => {
    // ord-1 ya tenía foto con el pedido (refresh) y Shopify ahora no lo
    // devuelve; ord-2 es nuevo y Shopify tampoco lo devuelve: esa foto sí se
    // guarda (dice que Shopify no lo tenía).
    const w = world({
      candidates: { [KENKU]: [cand(1, true), cand(2)] },
      // La base (0275) no pisa una foto con el pedido con una sin él.
      putResult: (args) => ({ data: !(args.p_order === "ord-1" && (args.p_payload as Row).order === null), error: null }),
      // Aunque el pedido llevara ya varias anotaciones, conservar no es rojo.
      failedResult: () => ({ data: 1, error: null }),
    });
    const { fetchImpl } = shopify((ask) =>
      ask.ids ? batchOf(ask.ids, undefined, () => null) : { payload: { data: { order: null } } },
    );
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(fetchImpl).d);

    expect(puts(w).map((p) => [p.p_order, p.p_payload])).toEqual([
      ["ord-1", { order: null }],
      ["ord-2", { order: null }],
    ]);
    expect(failedCalls(w)).toEqual([
      { p_store: KENKU, p_orders: ["ord-1"], p_detail: INVOICE_SNAPSHOT_KEPT_DETAIL, p_alert: 2_147_483_647 },
    ]);
    expect(report.stores[0]).toMatchObject({ saved: 1, notFound: 1, refreshed: 0, skipped: 1, kept: 1, failed: 0, pending: 0, stopped: null });
    expect(report.errors).toEqual([]);
  });

  it("la 0275 guarda la regla: `{ order: null }` no pisa una foto con el pedido", () => {
    const sql = readFileSync(resolve(process.cwd(), "db/migrations/0275_invoice_snapshots.sql"), "utf8").replace(/\s+/g, " ");
    expect(sql).toContain(
      "where s.fetched_at < excluded.fetched_at and not (jsonb_typeof(s.payload->'order') = 'object' and jsonb_typeof(excluded.payload->'order') = 'null');",
    );
  });

  it("lo que el lote no trae completo, o no trae, se pide solo con la consulta de la boleta", async () => {
    const w = world({ candidates: { [KENKU]: cands(1, 4) } });
    const [c1, c2, c3, c4] = cands(1, 4).map(gidOf) as [string, string, string, string];
    const { fetchImpl, sent } = shopify((ask) => {
      if (ask.ids) {
        return batchOf(ask.ids, undefined, (g) =>
          g === c1
            ? nodeFor(g, { lineItems: { pageInfo: { hasNextPage: true }, nodes: [] } }) // más de 10 líneas
            : g === c2
              ? null // no volvió
              : g === c3
                ? nodeFor(g, { transactions: Array.from({ length: 10 }, () => ({ kind: "SALE" })) }) // puede tener más
                : nodeFor(g),
        );
      }
      return ask.id === c2 ? { payload: { data: { order: null } } } : { payload: { data: { order: nodeFor(ask.id!, { name: "completo" }) } } };
    });
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(fetchImpl).d);

    // Los lotes con la consulta del lote; los de a uno, con la de la boleta.
    expect(sent.filter((s) => s.body.query === ORDERS_FOR_INVOICE_BATCH_QUERY).map((s) => s.body.variables)).toEqual([
      { ids: [c1] },
      { ids: [c2, c3, c4] },
    ]);
    expect(sent.filter((s) => s.body.query === ORDER_FOR_INVOICE_QUERY).map((s) => s.body.variables)).toEqual([
      { id: c1 },
      { id: c2 },
      { id: c3 },
    ]);
    const byOrder = Object.fromEntries(puts(w).map((p) => [p.p_order, p.p_payload]));
    expect(byOrder).toEqual({
      "ord-4": { order: nodeFor(c4) },
      "ord-1": { order: nodeFor(c1, { name: "completo" }) },
      "ord-2": { order: null },
      "ord-3": { order: nodeFor(c3, { name: "completo" }) },
    });
    expect(report.stores[0]).toMatchObject({ saved: 4, notFound: 1, failed: 0, pending: 0, stopped: null, calls: 5 });
  });

  it("pide los candidatos desde el 29-08-2026, el cierre menos los 60 días del barrido de boletas", async () => {
    expect(INVOICE_SNAPSHOT_SINCE).toBe("2026-08-29T00:00:00.000Z");
    expect(Date.parse(SHOPIFY_SHUTDOWN_AT) - Date.parse(INVOICE_SNAPSHOT_SINCE)).toBe(60 * 86_400_000);
    const w = world();
    await runInvoiceSnapshotSweep(adminOf(w), {}, deps(shopify().fetchImpl).d);
    expect(w.rpcs).toEqual([
      { fn: "invoice_snapshot_candidates", args: { p_store: KENKU, p_since: INVOICE_SNAPSHOT_SINCE, p_limit: INVOICE_SNAPSHOT_MAX_PER_STORE } },
      { fn: "invoice_snapshot_candidates", args: { p_store: AURELA, p_since: INVOICE_SNAPSHOT_SINCE, p_limit: INVOICE_SNAPSHOT_MAX_PER_STORE } },
    ]);
  });

  it("solo las tiendas activas de una organización que factura: una tienda cliente no se toca", async () => {
    const w = world({ candidates: { [CLIENTE]: [cand(9)] } });
    const { fetchImpl, sent } = shopify();
    const report = await runInvoiceSnapshotSweep(adminOf(w), {}, deps(fetchImpl).d);
    expect(report.stores.map((s) => s.storeId)).toEqual([KENKU, AURELA].sort());
    expect(sent).toEqual([]);
    expect(w.storeFilters).toEqual(
      expect.arrayContaining([
        ["stores", "in:org_id", ["org-gf"]],
        ["stores", "status", "active"],
      ]),
    );
    const solo = await runInvoiceSnapshotSweep(adminOf(world()), { storeId: CLIENTE }, deps(fetchImpl).d);
    expect(solo.stores).toEqual([]);
  });

  it("lo que la base no guarda (una foto más nueva, o el pedido ya no es de Shopify) se cuenta aparte", async () => {
    const w = world({ candidates: { [KENKU]: [cand(1)] }, putResult: () => ({ data: false, error: null }) });
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(shopify().fetchImpl).d);
    expect(report.stores[0]).toMatchObject({ saved: 0, skipped: 1, stopped: null, pending: 0 });
  });

  it("con `dry` solo cuenta: no toma el turno, no llama a Shopify ni escribe", async () => {
    const w = world({ candidates: { [KENKU]: [cand(1), cand(2)] } });
    const { fetchImpl, sent } = shopify();
    const conn = vi.fn(async () => ({ domain: "x", token: TOKEN }));
    const report = await runInvoiceSnapshotSweep(adminOf(w), { dry: true, storeId: KENKU }, deps(fetchImpl, { conn }).d);
    expect(sent).toEqual([]);
    expect(conn).not.toHaveBeenCalled();
    expect(w.rpcs.map((c) => c.fn)).toEqual(["invoice_snapshot_candidates"]);
    expect(report).toMatchObject({ dry: true, orders: 0, stores: [{ storeId: KENKU, candidates: 2, pending: 2, stopped: null }] });
  });
});

describe("runInvoiceSnapshotSweep: el tamaño del lote y el tope de costo", () => {
  it("snapshotBatchSize: lo que cabe en el tope de la consulta y en el balde menos la reserva", () => {
    expect(SHOPIFY_MAX_QUERY_COST).toBe(1000);
    expect(INVOICE_SNAPSHOT_RESERVE).toBe(0.25);
    expect(INVOICE_READ_POINTS).toBe(850);
    // Sin saber nada del balde (Shopify no lo informó): 750 / 160 = 4.
    expect(snapshotBatchSize(null, 160, INVOICE_SNAPSHOT_MAX_BATCH, 100)).toBe(4);
    // Balde de 1000: la reserva es una boleta (850) y quedan 150: de a un pedido.
    expect(snapshotBatchSize({ max: 1000 }, 120, 25, 100)).toBe(1);
    // Balde de 2000: quedan 1150, pero el tope es el de UNA consulta (1000).
    expect(snapshotBatchSize({ max: 2000 }, 120, 25, 100)).toBe(8);
    // Nunca más que el máximo, ni que los que quedan, ni menos de uno.
    expect(snapshotBatchSize({ max: 20_000 }, 10, 25, 100)).toBe(25);
    expect(snapshotBatchSize({ max: 2000 }, 40, 25, 3)).toBe(3);
    expect(snapshotBatchSize({ max: 1000 }, 5000, 25, 100)).toBe(1);
  });

  it("la reserva: un cuarto del balde y nunca menos que la lectura de una boleta (sin pasar del balde)", () => {
    expect(snapshotReservePoints(1000)).toBe(850);
    expect(snapshotReservePoints(2000)).toBe(850);
    expect(snapshotReservePoints(3400)).toBe(850);
    expect(snapshotReservePoints(4000)).toBe(1000);
    expect(snapshotReservePoints(20_000)).toBe(5000);
    expect(snapshotReservePoints(600)).toBe(600);
  });

  it("aprende de Shopify cuánto pide cada pedido y arma lotes más grandes", async () => {
    const w = world({ candidates: { [KENKU]: cands(1, 30) } });
    // Cada pedido del lote pide 40 puntos; balde de 2000 lleno.
    const { fetchImpl, sent } = shopify((ask) => batchOf(ask.ids!, COST(2000, ask.ids!.length * 40, 0, 2000, 100)));
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(fetchImpl).d);
    // Uno para saber; después 1000 / 40 = 25 (el máximo); y los que quedan.
    expect(sizes(sent)).toEqual([1, 25, 4]);
    expect(report.stores[0]).toMatchObject({ saved: 30, pending: 0, calls: 3, batch: 4 });
  });

  it("si Shopify dice que el lote pasa el tope (MAX_COST_EXCEEDED), lo achica y no pierde pedidos", async () => {
    const w = world({ candidates: { [KENKU]: cands(1, 6) } });
    const { fetchImpl, sent } = shopify((ask) => {
      if (ask.ids && ask.ids.length > 2) {
        return {
          payload: {
            errors: [
              {
                message: `Query cost is ${ask.ids.length * 450}, which exceeds the single query max cost limit (1000).`,
                extensions: { code: "MAX_COST_EXCEEDED", cost: ask.ids.length * 450, maxCost: 1000 },
              },
            ],
          },
        };
      }
      return batchOf(ask.ids!);
    });
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(fetchImpl).d);
    // Uno para saber; 4 (lo supuesto) no cabe (1800): 450 por pedido, de a uno.
    expect(sizes(sent).slice(0, 3)).toEqual([1, 4, 1]);
    expect(sizes(sent).slice(2).every((n) => n === 1)).toBe(true);
    expect(puts(w).map((p) => p.p_order).sort()).toEqual(cands(1, 6).map((c) => c.order_id).sort());
    expect(report.stores[0]).toMatchObject({ saved: 6, failed: 0, pending: 0, stopped: null });
    expect(failedCalls(w)).toEqual([]);
  });

  it("si ni un lote de UN pedido cabe, el resto de la pasada va de a uno con la consulta de la boleta (sin una llamada rechazada por pedido)", async () => {
    const w = world({ candidates: { [KENKU]: cands(1, 5) } });
    const { fetchImpl, sent } = shopify((ask) =>
      ask.ids
        ? {
            payload: {
              errors: [
                {
                  message: "Query cost is 1350, which exceeds the single query max cost limit (1000).",
                  extensions: { code: "MAX_COST_EXCEEDED" },
                },
              ],
            },
          }
        : { payload: { data: { order: nodeFor(ask.id!) } } },
    );
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(fetchImpl).d);
    expect(sizes(sent)).toEqual([1, ...cands(1, 5).map((c) => `1:${gidOf(c)}`)]);
    expect(report.stores[0]).toMatchObject({ saved: 5, failed: 0, pending: 0, stopped: null, calls: 6 });
  });
});

describe("runInvoiceSnapshotSweep: el cupo de la tienda (la reserva del balde y un cuarto de la reposición)", () => {
  it("espera a que la tienda tenga el costo de la llamada más la reserva", () => {
    const bucket = { available: 500, max: 2000, restore: 100, at: 0 };
    // Necesita 400 + 850 (una boleta) = 1250; tiene 500: faltan 750 a 100 por segundo.
    expect(snapshotWaitMs(bucket, 0, 400)).toBe(7_500);
    expect(snapshotWaitMs(bucket, 7_500, 400)).toBe(0);
    // Balde de 1000: 400 + 850 pasa del balde, así que espera el balde lleno.
    const small = { available: 500, max: 1000, restore: 50, at: 0 };
    expect(snapshotWaitMs(small, 0, 400)).toBe(10_000);
    // Una consulta que pide casi todo el cupo espera al cupo lleno, no para siempre.
    expect(snapshotWaitMs({ ...small, available: 900 }, 0, 950)).toBe(2_000);
    expect(snapshotWaitMs(null, 0, 400)).toBe(0);
    expect(snapshotWaitMs({ ...small, restore: 0 }, 0, 400)).toBe(Number.POSITIVE_INFINITY);
  });

  it("después de cobrar el lote por adelantado, a la tienda le queda al menos lo que pide una boleta (balde de 1000)", async () => {
    const w = world({ candidates: { [KENKU]: cands(1, 40) } });
    // Un balde de verdad: 1000 puntos que se reponen a 50 por segundo, con el
    // reloj de la prueba. Shopify cobra por adelantado lo que pide el lote
    // (150 por pedido) y devuelve lo que no gastó (gasta 30 por pedido). Lo que
    // queda en ese momento es lo que tienen el sync y las asesoras.
    const bucket = { available: 1000, at: 0 };
    const box: { clock?: { t: number } } = {};
    const left: number[] = [];
    const { fetchImpl } = shopify((ask) => {
      const now = box.clock!.t;
      bucket.available = Math.min(1000, bucket.available + ((now - bucket.at) / 1000) * 50);
      bucket.at = now;
      const requested = ask.ids!.length * 150;
      left.push(bucket.available - requested);
      bucket.available -= ask.ids!.length * 30;
      return batchOf(ask.ids!, COST(bucket.available, requested, ask.ids!.length * 30, 1000, 50));
    });
    const { d, clock } = deps(fetchImpl);
    box.clock = clock;
    bucket.at = clock.t;
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, d);
    expect(report.stores[0]!.saved).toBe(40);
    expect(left.length).toBeGreaterThan(5);
    // Una boleta pide unos 810: el barrido o «Emitir esta boleta» entran
    // mientras corre la foto.
    for (const l of left) expect(l).toBeGreaterThanOrEqual(INVOICE_READ_POINTS);
  });

  it("gasta a lo más el 75 % de lo que se repone por segundo: entre llamadas espera lo gastado / (0,75 × reposición)", async () => {
    const w = world({ candidates: { [KENKU]: cands(1, 12) } });
    // Balde de 2000 que se repone a 100 por segundo. Uno para saber, y lotes de
    // 6 (cada pedido pide 160: 1000 / 160 = 6). Cada llamada gasta 150 de
    // verdad: 150 / 75 = 2 s entre el inicio de una llamada y el de la siguiente.
    const { fetchImpl, sent } = shopify((ask) => batchOf(ask.ids!, COST(2000, ask.ids!.length * 160, 150, 2000, 100)));
    const { d, sleeps } = deps(fetchImpl);
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, d);
    expect(sizes(sent)).toEqual([1, 6, 5]);
    expect(sleeps).toEqual([2_000, 2_000]);
    expect(report.stores[0]).toMatchObject({ saved: 12, quota: { max: 2000, restore: 100, available: 2000 } });
  });

  it("si esperar el cupo se pasa del tiempo de la pasada, para por cupo", async () => {
    const w = world({ candidates: { [KENKU]: cands(1, 8) } });
    // Después del primer lote el balde queda en 0 y se repone a 1 por segundo:
    // esperar no cabe en la pasada.
    const { fetchImpl, sent } = shopify((ask) => batchOf(ask.ids!, COST(0, ask.ids!.length * 160, 0, 1000, 1)));
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(fetchImpl).d);
    expect(sent).toHaveLength(1);
    expect(report.stores[0]).toMatchObject({ saved: 1, stopped: "cuota", pending: 7 });
    expect(report.errors).toEqual([]);
  });

  it("THROTTLED: la tienda para por cupo, sin anotar nada ni ponerse roja", async () => {
    const w = world({ candidates: { [KENKU]: cands(1, 3) } });
    const { fetchImpl } = shopify(() => ({
      payload: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: COST(10, 480, null) } },
    }));
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(fetchImpl).d);
    expect(report.stores[0]).toMatchObject({ stopped: "cuota", pending: 3, failed: 0 });
    expect(failedCalls(w)).toEqual([]);
    expect(report.errors).toEqual([]);
  });
});

describe("runInvoiceSnapshotSweep: una falla de la tienda la para; la de un pedido no tapa la cola", () => {
  const run = async (respond: (ask: Ask) => Reply, n = 3, over: Partial<World> = {}) => {
    const w = world({ candidates: { [KENKU]: cands(1, n) }, ...over });
    const { fetchImpl, sent } = shopify(respond);
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(fetchImpl).d);
    return { w, sent, report, store: report.stores[0]! };
  };

  it("la tienda dada de baja (HTTP 402): para con su motivo, y el cron se ve rojo", async () => {
    const { w, sent, report, store } = await run(() => ({ status: 402, payload: { errors: "Unavailable Shop" } }));
    expect(sent).toHaveLength(1);
    expect(puts(w)).toEqual([]);
    expect(store).toMatchObject({ stopped: "tienda_caida", detail: "Shopify contestó HTTP 402.", pending: 3, saved: 0 });
    expect(report.errors).toEqual([`Tienda ${KENKU}: Shopify falló (tienda_caida): Shopify contestó HTTP 402.`]);
  });

  it("un 5xx a mitad: lo guardado queda, la tienda para (rojo) y lo que estaba en vuelo va detrás la próxima vez", async () => {
    const { w, store, report } = await run(
      (ask) => (ask.n === 2 ? { status: 503, payload: {} } : batchOf(ask.ids!)),
      6,
    );
    expect(puts(w).map((p) => p.p_order)).toEqual(["ord-1"]);
    expect(store).toMatchObject({ saved: 1, failed: 0, stopped: "shopify", detail: "Shopify contestó HTTP 503.", pending: 5 });
    expect(failedCalls(w)).toEqual([
      {
        p_store: KENKU,
        p_orders: ["ord-2", "ord-3", "ord-4", "ord-5"],
        p_detail: "Shopify contestó HTTP 503.",
        p_alert: INVOICE_SNAPSHOT_ALERT_FAILS,
      },
    ]);
    expect(report.errors).toHaveLength(1);
  });

  it("un pedido que Shopify no puede leer (error de GraphQL) se anota y la pasada sigue con los demás", async () => {
    const bad = gidOf(cand(2));
    const { w, sent, store, report } = await run((ask) => {
      if (ask.ids) {
        return ask.ids.includes(bad)
          ? { payload: { errors: [{ message: "Internal error", extensions: { code: "INTERNAL_SERVER_ERROR" } }] } }
          : batchOf(ask.ids);
      }
      return ask.id === bad
        ? { payload: { errors: [{ message: "Internal error", extensions: { code: "INTERNAL_SERVER_ERROR" } }] } }
        : { payload: { data: { order: nodeFor(ask.id!) } } };
    }, 6);
    // El lote con el malo se pide de a uno para saber cuál es; el siguiente lote, normal.
    expect(sizes(sent)).toEqual([1, 4, `1:${bad}`, `1:${gidOf(cand(3))}`, `1:${gidOf(cand(4))}`, `1:${gidOf(cand(5))}`, 1]);
    expect(puts(w).map((p) => p.p_order)).toEqual(["ord-1", "ord-3", "ord-4", "ord-5", "ord-6"]);
    expect(failedCalls(w)).toEqual([
      { p_store: KENKU, p_orders: ["ord-2"], p_detail: "Shopify devolvió un error (INTERNAL_SERVER_ERROR).", p_alert: INVOICE_SNAPSHOT_ALERT_FAILS },
    ]);
    expect(store).toMatchObject({ saved: 5, failed: 1, pending: 0, stopped: null });
    expect(report.errors).toEqual([]);
  });

  it("una respuesta sin `order`, o con otro pedido, se anota como falla de ese pedido y sigue", async () => {
    const { w, store } = await run((ask) =>
      ask.ids
        ? batchOf(ask.ids, undefined, () => null)
        : ask.id === gidOf(cand(1))
          ? { payload: { data: {} } }
          : ask.id === gidOf(cand(2))
            ? { payload: { data: { order: nodeFor("gid://shopify/Order/1") } } }
            : { payload: { data: { order: nodeFor(ask.id!) } } },
    );
    expect(puts(w).map((p) => p.p_order)).toEqual(["ord-3"]);
    expect(failedCalls(w).map((f) => [f.p_orders, f.p_detail])).toEqual([
      [["ord-1"], "Shopify contestó sin el pedido."],
      [["ord-2"], "Shopify devolvió otro pedido."],
    ]);
    expect(store).toMatchObject({ saved: 1, failed: 2, pending: 0, stopped: null });
  });

  it("el pedido que siempre falla no tapa la cola: va detrás de los que nunca fallaron (la base lo ordena)", () => {
    const sql = readFileSync(resolve(process.cwd(), "db/migrations/0275_invoice_snapshots.sql"), "utf8");
    const order = /order by \(s\.order_id is not null\),\s*coalesce\(a\.fail_count, 0\),/;
    expect(sql).toMatch(order);
  });

  it("un tiempo agotado sin nada bueno antes es de la tienda: para, y lo que estaba en vuelo va detrás", async () => {
    const timeout = new DOMException("timeout", "TimeoutError");
    const { w, store, report } = await run(() => ({ payload: null, throws: timeout }));
    expect(store).toMatchObject({ stopped: "shopify", detail: "Shopify no respondió a tiempo.", pending: 3, failed: 0 });
    // El primero de la cola (lo que estaba en vuelo) va detrás la próxima vez.
    expect(failedCalls(w).map((f) => f.p_orders)).toEqual([["ord-1"]]);
    expect(report.errors).toHaveLength(1);
  });

  it("un tiempo agotado después de otros buenos es de ese pedido: se anota y sigue", async () => {
    const slow = gidOf(cand(6));
    const timeout = new DOMException("timeout", "TimeoutError");
    const { w, store } = await run((ask) => {
      if (ask.ids) return ask.ids.includes(slow) ? { payload: null, throws: timeout } : batchOf(ask.ids);
      return ask.id === slow ? { payload: null, throws: timeout } : { payload: { data: { order: nodeFor(ask.id!) } } };
    }, 7);
    expect(puts(w).map((p) => p.p_order)).toEqual(["ord-1", "ord-2", "ord-3", "ord-4", "ord-5", "ord-7"]);
    expect(failedCalls(w).map((f) => [f.p_orders, f.p_detail])).toEqual([[["ord-6"], "Shopify no respondió a tiempo."]]);
    expect(store).toMatchObject({ saved: 6, failed: 1, pending: 0, stopped: null });
  });

  it(`un pedido que ya falló ${INVOICE_SNAPSHOT_ALERT_FAILS} pasadas seguidas pone el cron en rojo`, async () => {
    const { report } = await run(
      (ask) => (ask.ids ? batchOf(ask.ids, undefined, () => null) : { payload: { data: {} } }),
      1,
      { failedResult: () => ({ data: 1, error: null }) },
    );
    expect(report.errors).toEqual([
      `Tienda ${KENKU}: 1 pedido sin foto falla desde hace ${INVOICE_SNAPSHOT_ALERT_FAILS} pasadas o más (invoice_snapshot_attempts).`,
    ]);
  });

  it(`${INVOICE_SNAPSHOT_MAX_CONSECUTIVE_FAILS} pedidos seguidos que fallan solos: la tienda para`, async () => {
    const { store, sent } = await run(
      (ask) => (ask.ids ? batchOf(ask.ids, undefined, () => null) : { payload: { data: {} } }),
      8,
    );
    expect(store).toMatchObject({ stopped: "shopify", failed: INVOICE_SNAPSHOT_MAX_CONSECUTIVE_FAILS });
    expect(sent.filter((s) => !s.body.variables.ids)).toHaveLength(INVOICE_SNAPSHOT_MAX_CONSECUTIVE_FAILS);
  });

  it("una tienda sin token no tiene a quién preguntar", async () => {
    const w = world({ candidates: { [KENKU]: [cand(1)] } });
    const { fetchImpl, sent } = shopify();
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

describe("runInvoiceSnapshotSweep: el turno, el tiempo y las dos tiendas", () => {
  it("toma el turno de la tienda antes de llamar a Shopify y lo suelta al terminar", async () => {
    const w = world({ candidates: { [KENKU]: [cand(1)] } });
    await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(shopify().fetchImpl).d);
    expect(w.rpcs.map((c) => c.fn)).toEqual([
      "invoice_snapshot_candidates",
      "invoice_snapshot_lease",
      "invoice_snapshot_put",
      "invoice_snapshot_release",
    ]);
    expect(w.rpcs[1]!.args).toEqual({ p_store: KENKU, p_holder: "pasada-1", p_seconds: INVOICE_SNAPSHOT_LEASE_S });
    expect(w.rpcs[3]!.args).toEqual({ p_store: KENKU, p_holder: "pasada-1" });
  });

  it("si otra pasada tiene el turno, no llama a Shopify (sin rojo)", async () => {
    const w = world({ candidates: { [KENKU]: [cand(1)] }, lease: () => ({ data: false, error: null }) });
    const { fetchImpl, sent } = shopify();
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(fetchImpl).d);
    expect(sent).toEqual([]);
    expect(report.stores[0]).toMatchObject({ stopped: "ocupada", pending: 1 });
    expect(report.errors).toEqual([]);
  });

  it("suelta el turno aunque la pasada se caiga", async () => {
    const missing = { code: "PGRST202", message: "Could not find the function public.invoice_snapshot_put" };
    const w = world({ candidates: { [KENKU]: [cand(1)] }, putResult: () => ({ data: null, error: missing }) });
    const err = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(shopify().fetchImpl).d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceSnapshotMigrationMissingError);
    expect(w.rpcs.at(-1)!.fn).toBe("invoice_snapshot_release");
  });

  it(`no empieza otra llamada pasados ${INVOICE_SNAPSHOT_BUDGET_MS / 1000} s`, async () => {
    const w = world({ candidates: { [KENKU]: cands(1, 8) } });
    const box: { clock?: { t: number } } = {};
    const { fetchImpl } = shopify((ask) => {
      box.clock!.t += INVOICE_SNAPSHOT_BUDGET_MS + 1; // la lectura tardó
      return batchOf(ask.ids!);
    });
    const { d, clock } = deps(fetchImpl);
    box.clock = clock;
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, d);
    expect(report.stores[0]).toMatchObject({ saved: 1, stopped: "presupuesto", pending: 7 });
  });

  it("el tiempo de la pasada, una llamada y el turno caben en la ruta y antes de la próxima pasada", () => {
    expect(INVOICE_SNAPSHOT_MAX_DURATION_S).toBe(120);
    expect(INVOICE_SNAPSHOT_BUDGET_MS + SHOPIFY_READ_TIMEOUT_MS + 5_000).toBeLessThan(INVOICE_SNAPSHOT_MAX_DURATION_S * 1000);
    expect(INVOICE_SNAPSHOT_LEASE_S).toBeGreaterThan(INVOICE_SNAPSHOT_MAX_DURATION_S);
  });

  it("las dos tiendas en la misma pasada, a la vez, cada una con su reporte", async () => {
    const w = world({ candidates: { [KENKU]: [cand(1)], [AURELA]: [cand(2)] } });
    let inFlight = 0;
    let most = 0;
    const { fetchImpl: inner, sent } = shopify();
    const fetchImpl = (async (url: unknown, init: unknown) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return (inner as unknown as (u: unknown, i: unknown) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    const report = await runInvoiceSnapshotSweep(adminOf(w), {}, deps(fetchImpl).d);
    expect(sent).toHaveLength(2);
    expect(most).toBe(2);
    expect(report.stores.map((s) => [s.storeId, s.saved])).toEqual([
      [KENKU, 1],
      [AURELA, 1],
    ]);
  });

  it("el reporte lleva el ritmo: fotos de la pasada, por minuto, y por tienda llamadas, lote y cupo", async () => {
    const w = world({ candidates: { [KENKU]: cands(1, 8), [AURELA]: cands(11, 12) } });
    const { fetchImpl } = shopify((ask) => batchOf(ask.ids!, COST(1000, ask.ids!.length * 160, 120, 1000, 50)));
    const { d } = deps(fetchImpl);
    const report = await runInvoiceSnapshotSweep(adminOf(w), {}, d);
    expect(report.orders).toBe(10);
    expect(report.ms).toBeGreaterThan(0);
    expect(report.perMinute).toBe(Math.round((10 / report.ms) * 60_000));
    const kenku = report.stores.find((s) => s.storeId === KENKU) as InvoiceSnapshotStoreReport;
    // Balde de 1000: la reserva es una boleta, así que va de a un pedido; 160
    // puntos pedidos y 120 gastados por llamada.
    expect(kenku).toMatchObject({
      saved: 8,
      calls: 8,
      batch: 1,
      points: { requested: 8 * 160, actual: 8 * 120 },
      quota: { max: 1000, restore: 50, available: 1000 },
    });
  });
});

describe("runInvoiceSnapshotSweep: la base", () => {
  it("si no puede guardar, lo dice (rojo) sin repetir valores de la base", async () => {
    const w = world({
      candidates: { [KENKU]: [cand(1), cand(2)] },
      putResult: () => ({ data: null, error: { code: "23503", message: "Key (order_id)=(ord-1) is not present" } }),
    });
    const report = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(shopify().fetchImpl).d);
    expect(report.errors).toEqual(["No se pudo guardar la foto de un pedido (23503)."]);
    expect(report.stores[0]).toMatchObject({ stopped: "base", pending: 2 });
  });

  it("sin la 0275 lanza `InvoiceSnapshotMigrationMissingError`; otra cosa que falta, no", async () => {
    const missing = { code: "PGRST202", message: "Could not find the function public.invoice_snapshot_candidates(p_limit, p_since, p_store) in the schema cache" };
    const w = world({ candidatesError: missing });
    const err = await runInvoiceSnapshotSweep(adminOf(w), {}, deps(shopify().fetchImpl).d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceSnapshotMigrationMissingError);
    expect(isInvoiceSnapshotMigrationMissing(err)).toBe(true);
    expect(isInvoiceSnapshotMigrationMissing(missing)).toBe(true);
    for (const fn of ["invoice_snapshot_lease", "invoice_snapshot_release", "invoice_snapshot_failed"]) {
      expect(isInvoiceSnapshotMigrationMissing({ code: "PGRST202", message: `Could not find the function public.${fn}` })).toBe(true);
    }
    expect(isInvoiceSnapshotMigrationMissing({ code: "42P01", message: 'relation "invoice_snapshot_attempts" does not exist' })).toBe(true);
    expect(isInvoiceSnapshotMigrationMissing({ code: "42P01", message: 'relation "orders" does not exist' })).toBe(false);
    expect(isInvoiceSnapshotMigrationMissing({ code: "42703", message: "invoice_snapshot_put" })).toBe(false);
  });

  it("una 0275 a medias (sin el turno) tampoco se ve roja: sin_migracion", async () => {
    const w = world({
      candidates: { [KENKU]: [cand(1)] },
      lease: () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.invoice_snapshot_lease" } }),
    });
    const { fetchImpl, sent } = shopify();
    const err = await runInvoiceSnapshotSweep(adminOf(w), { storeId: KENKU }, deps(fetchImpl).d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceSnapshotMigrationMissingError);
    expect(sent).toEqual([]);
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
    ms: 41_000,
    orders: 3,
    perMinute: 4,
    stores: [
      {
        storeId: KENKU,
        candidates: 3,
        saved: 3,
        refreshed: 0,
        notFound: 0,
        skipped: 0,
        kept: 0,
        failed: 0,
        pending: 0,
        stopped: null,
        calls: 1,
        batch: 3,
        points: { requested: 480, actual: 105 },
        ms: 41_000,
      },
    ],
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

  it("corre en Node, sin caché y con 120 s (los de la pasada), por GET y por POST", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBe(120);
    expect(route.maxDuration).toBe(INVOICE_SNAPSHOT_MAX_DURATION_S);
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

  it("una tienda parada por cupo, por tiempo o por otra pasada no pone el cron en rojo", async () => {
    for (const stopped of ["cuota", "presupuesto", "ocupada", "sin_shopify"] as const) {
      mocks.report = routeReport({
        stores: [
          {
            storeId: KENKU,
            candidates: 3,
            saved: 0,
            refreshed: 0,
            notFound: 0,
            skipped: 0,
            kept: 0,
            failed: 0,
            pending: 3,
            stopped,
            calls: 0,
            batch: 0,
            points: { requested: 0, actual: 0 },
            ms: 10,
          },
        ],
      });
      expect((await route.GET(req())).status, stopped).toBe(200);
    }
  });

  it("una tienda que Shopify dio de baja sí: el barrido lo pone en `errors` y la ruta contesta 502", async () => {
    mocks.report = routeReport({ errors: [`Tienda ${KENKU}: Shopify falló (tienda_caida): Shopify contestó HTTP 402.`] });
    expect((await route.GET(req())).status).toBe(502);
  });

  it("sin la 0275: 200 con `sin_migracion`", async () => {
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

  it("cada 2 minutos, en los impares: casi sin pausa hasta terminar, sin que una pasada pise a la siguiente", () => {
    expect(crons).toContainEqual({ path: "/api/cron/invoice-snapshots", schedule: "1-59/2 * * * *" });
    // Nunca arranca en el minuto del barrido de boletas (6, 16, …, 56).
    const odd = Array.from({ length: 30 }, (_, k) => 2 * k + 1);
    for (const m of [6, 16, 26, 36, 46, 56]) expect(odd).not.toContain(m);
    // La pasada termina antes de que empiece la próxima (y el turno de la base
    // lo cuida si se atrasa): 95 s de trabajo + una llamada de 15 s < 120 s.
    expect(INVOICE_SNAPSHOT_BUDGET_MS + SHOPIFY_READ_TIMEOUT_MS).toBeLessThan(120_000);
  });
});

describe("la regla está escrita (MOM §35.10, DEPLOY.md)", () => {
  const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");
  const deploy = readFileSync(resolve(process.cwd(), "DEPLOY.md"), "utf8");
  const sql = readFileSync(resolve(process.cwd(), "db/migrations/0275_invoice_snapshots.sql"), "utf8");

  it("el MOM tiene la decisión del owner con su fecha y lo que cambia", () => {
    expect(mom).toContain("### 35.10 La foto del pedido para cuando Shopify ya no responde (owner, 23-10-2026)");
    expect(mom).toContain("order_invoice_snapshots");
    expect(mom).toContain("foto_shopify");
    const s3510 = mom.slice(mom.indexOf("### 35.10"), mom.indexOf("## 36."));
    expect(s3510).toContain("**Una foto con el pedido nunca se pisa con una\nque no lo trae**");
    expect(s3510).toContain("`1-59/2`");
    expect(s3510).toContain("`points.requested`, `points.actual`");
  });

  it("DEPLOY.md dice cuánto tarda (horas por balde) y cómo ver el avance sin escribir", () => {
    const s0275 = deploy.slice(deploy.indexOf("### 23-10-2026 · La foto de los pedidos de Shopify"), deploy.indexOf("### 25-10-2026"));
    expect(s0275).toContain("(`1-59/2 * * * *`)");
    expect(s0275).toContain("| Balde de la tienda (`quota.max` / `quota.restore`) |");
    expect(s0275).toContain("**El peor\n   caso razonable (balde de 1.000 y pedidos de 100 puntos) termina en ~9 h**");
    // La consulta del avance solo lee.
    const avance = s0275.slice(s0275.indexOf("**El avance, en la base**"), s0275.indexOf("Un pedido con 3 o más fallas"));
    expect(avance).toContain("horas_que_faltan");
    expect(avance).not.toMatch(/\b(insert|update|delete|truncate|alter|drop)\b/i);
  });

  it("DEPLOY.md dice cómo aplicar la 0275, después de la 0274", () => {
    expect(deploy).toContain("0275_invoice_snapshots.sql");
    expect(deploy.indexOf("0275_invoice_snapshots.sql")).toBeGreaterThan(-1);
  });

  it("la 0275 se detiene sin la 0274 y no deja a anon ni authenticated", () => {
    expect(sql).toContain("falta la 0274 (orders.platform)");
    expect(sql).toContain("revoke all on order_invoice_snapshots from anon, authenticated;");
    expect(sql).toContain("o.platform = 'shopify'");
  });
});
