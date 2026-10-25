// El emparejamiento automático de la cola «Revisión» (lib/shipment-auto-match.ts)
// cuando la búsqueda en Shopify falla (23-10-2026, salida de Kenku y Aurela de
// Shopify).
//
// EL DEFECTO. Una búsqueda que fallaba —tienda caída, sin permiso, un 5xx— se
// tomaba como «no hay pedido»: el envío quedaba revisado (`suggestion_checked_at`)
// y no se volvía a buscar nunca. Ahora se queda sin marcar y entra en la próxima
// pasada; y como el cliente (components/import-review.tsx) pide tandas hasta
// `done`, una tanda que no avanzó termina el bucle en vez de pedir lo mismo para
// siempre. Con Shopify bien, todo igual.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrderRow, StoreSummary } from "@/lib/types";

const h = vi.hoisted(() => ({
  search: vi.fn(),
  fetchOrder: vi.fn(),
}));

vi.mock("@/lib/ingest", () => ({
  getStoreCreds: async (id: string) => ({ id, shopify_domain: `${id}.myshopify.com`, shopify_token: "t" }),
}));
vi.mock("@/lib/shopify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shopify")>()),
  searchOrdersLive: (...args: unknown[]) => h.search(...args),
  fetchOrderById: (...args: unknown[]) => h.fetchOrder(...args),
}));

import { runSuggestionBatch } from "@/lib/shipment-auto-match";

type Row = Record<string, unknown>;

interface Update {
  table: string;
  values: Row;
  ids: string[];
}

/** Admin falso: la cola de Revisión y lo que se escribe. */
function fakeAdmin(rows: Row[], pend: Row[] = []) {
  const updates: Update[] = [];
  const from = (table: string) => {
    const ctx: { op: "select" | "update" | "upsert"; cols: string; values: Row; ids: string[] } = {
      op: "select",
      cols: "",
      values: {},
      ids: [],
    };
    const q: Record<string, unknown> = {
      select(cols: string) {
        ctx.cols = cols;
        return q;
      },
      update(values: Row) {
        ctx.op = "update";
        ctx.values = values;
        return q;
      },
      upsert() {
        ctx.op = "upsert";
        return q;
      },
      in(col: string, vals: string[]) {
        if (ctx.op === "update" && col === "id") ctx.ids = vals;
        return q;
      },
      eq(col: string, val: string) {
        if (ctx.op === "update" && col === "id") ctx.ids = [val];
        return q;
      },
      not: () => q,
      is: () => q,
      // La búsqueda en la base local (pedidos de WooCommerce, MOM §38.12): aquí
      // no encuentra nada, como antes de que existiera.
      ilike: () => q,
      or: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: table === "orders" ? { id: "ord-1" } : null, error: null }),
      then(ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) {
        let result: unknown;
        if (ctx.op === "update") {
          updates.push({ table, values: ctx.values, ids: ctx.ids });
          result = { error: null };
        } else if (ctx.op === "upsert") {
          result = { error: null };
        } else if (table === "shipments" && ctx.cols.startsWith("id,suggested_order_gid")) {
          result = { data: pend, error: null };
        } else if (table === "shipments") {
          result = { data: rows, error: null };
        } else {
          result = { data: [], error: null };
        }
        return Promise.resolve(result).then(ok, fail);
      },
    };
    return q;
  };
  return { admin: { from } as unknown as SupabaseClient, updates };
}

const STORES = [
  { id: "kenku", name: "Kenku Peru" },
  { id: "aurela", name: "Aurela" },
] as unknown as StoreSummary[];

function order(over: Partial<OrderRow> = {}): OrderRow {
  return {
    store_id: "kenku",
    shopify_order_id: "6100000000001",
    name: "#KP140001",
    customer_phone: "51930295803",
    raw: { id: "gid://shopify/Order/6100000000001" },
    ...over,
  } as OrderRow;
}

/** Lo que se marcó como revisado, por id de envío. */
function checked(updates: Update[]): string[] {
  return updates.filter((u) => u.table === "shipments" && "suggestion_checked_at" in u.values).flatMap((u) => u.ids);
}

beforeEach(() => {
  h.search.mockReset();
  h.fetchOrder.mockReset();
});

describe("runSuggestionBatch: Shopify falló en la búsqueda", () => {
  it("el envío no queda revisado y la tanda termina si nada avanzó", async () => {
    // Un mal momento de Shopify (5xx). Un 402 de tienda que ya no está se busca
    // en la base local (test/shipment-auto-match-local.test.ts).
    h.search.mockRejectedValue(new Error("Shopify GraphQL HTTP 503: Service Unavailable"));
    const { admin, updates } = fakeAdmin([
      { id: "g1", order_name: "#KP140001", customer_phone: "51930295803" },
      { id: "g2", order_name: "#KP140002", customer_phone: "51930295804" },
    ]);

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 2);

    expect(checked(updates)).toEqual([]);
    // Antes: { processed: 2, linked: 0, done: false } y los dos revisados para
    // siempre. Con `done: false` y nada marcado, el bucle del cliente pediría
    // la misma tanda sin fin.
    expect(r).toEqual({ processed: 0, linked: 0, done: true, retry: 2 });
  });

  it("los que sí se buscaron quedan revisados; el que falló, no", async () => {
    h.search.mockImplementation(async (opts: { query: string }) => {
      if (opts.query === "#KP140001") throw new TypeError("fetch failed");
      return [];
    });
    const { admin, updates } = fakeAdmin([
      { id: "g1", order_name: "#KP140001", customer_phone: "51930295803" },
      { id: "g2", order_name: "#KP140002", customer_phone: "51930295804" },
    ]);

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 2);

    expect(checked(updates)).toEqual(["g2"]);
    // Avanzó: el cliente pide otra tanda.
    expect(r).toEqual({ processed: 1, linked: 0, done: false, retry: 1 });
  });

  it("si una de dos tiendas falló, no se vincula con lo que dijo la otra", async () => {
    // Sin prefijo se busca en las dos tiendas. Aurela tiene un candidato con el
    // mismo celular, pero Kenku no contestó: el candidato podía no ser único.
    h.search.mockImplementation(async (opts: { storeId: string }) => {
      if (opts.storeId === "kenku") throw new Error("Shopify GraphQL HTTP 503: down");
      return [order({ store_id: "aurela", name: "#AUR178000" })];
    });
    const { admin, updates } = fakeAdmin([{ id: "g1", order_name: "178000", customer_phone: "51930295803" }]);

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(h.fetchOrder).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(r).toEqual({ processed: 0, linked: 0, done: true, retry: 1 });
  });
});

describe("runSuggestionBatch: con Shopify bien, como siempre", () => {
  it("sin coincidencias, todos quedan revisados y no aparece `retry`", async () => {
    h.search.mockResolvedValue([]);
    const { admin, updates } = fakeAdmin([
      { id: "g1", order_name: "#KP140001", customer_phone: "51930295803" },
      { id: "g2", order_name: "#KP140002", customer_phone: "51930295804" },
    ]);

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 2);

    expect(checked(updates).sort()).toEqual(["g1", "g2"]);
    expect(r).toEqual({ processed: 2, linked: 0, done: false });
  });

  it("un solo candidato con el mismo celular se vincula", async () => {
    h.search.mockResolvedValue([order()]);
    h.fetchOrder.mockResolvedValue(order());
    const { admin, updates } = fakeAdmin([{ id: "g1", order_name: "#KP140001", customer_phone: "51930295803" }]);

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 1, linked: 1, done: true });
    expect(updates).toEqual([
      expect.objectContaining({
        table: "shipments",
        ids: ["g1"],
        values: expect.objectContaining({ order_id: "ord-1", matched: true, match_method: "auto" }),
      }),
    ]);
  });

  it("un envío sin referencia queda revisado sin buscar", async () => {
    const { admin, updates } = fakeAdmin([{ id: "g9", order_name: null, customer_phone: "51930295803" }]);
    const r = await runSuggestionBatch(admin, ["kenku"], STORES, 25);
    expect(h.search).not.toHaveBeenCalled();
    expect(checked(updates)).toEqual(["g9"]);
    expect(r).toEqual({ processed: 1, linked: 0, done: true });
  });
});
