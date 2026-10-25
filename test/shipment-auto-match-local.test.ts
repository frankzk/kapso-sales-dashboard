// El auto-vínculo de la cola «Revisión» con la base local (25-10-2026, MOM
// §38.12 «Envíos: el auto-vínculo y la búsqueda con pedidos de WooCommerce»).
//
// EL DEFECTO. El auto-vínculo solo buscaba en Shopify: una guía de un pedido de
// WooCommerce (#AUR900006, #KP200001) nunca encontraba su pedido, y desde el
// cierre de Shopify (402 y compañía) ninguna guía se revisaba nunca.
//
// LA REGLA. Los pedidos de WooCommerce se buscan en `orders`, siempre. Los de
// Shopify, en Shopify mientras tenga token y conteste (como siempre); sin
// token o con la tienda que ya no está, en `orders`. Un fallo pasajero deja el
// envío sin revisar, como antes. El candidato se elige igual: uno solo con el
// mismo celular.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrderRow, StoreSummary } from "@/lib/types";

const h = vi.hoisted(() => ({
  search: vi.fn(),
  fetchOrder: vi.fn(),
  tokens: new Map<string, string | null>(),
}));

vi.mock("@/lib/ingest", () => ({
  getStoreCreds: async (id: string) => ({
    id,
    shopify_domain: `${id}.myshopify.com`,
    shopify_token: h.tokens.has(id) ? h.tokens.get(id) : "t",
  }),
}));
vi.mock("@/lib/shopify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shopify")>()),
  searchOrdersLive: (...args: unknown[]) => h.search(...args),
  fetchOrderById: (...args: unknown[]) => h.fetchOrder(...args),
}));

import { localOrderReference, runSuggestionBatch, searchLocalOrderCandidates } from "@/lib/shipment-auto-match";

type Row = Record<string, unknown>;

interface Update {
  table: string;
  values: Row;
  ids: string[];
}

/** Una consulta a `orders` de la búsqueda local: sus filtros. */
interface OrdersQuery {
  store_id?: string;
  platform?: string;
  ilike?: string;
  or?: string;
}

interface LocalOrder {
  id: string;
  store_id: string;
  platform: "shopify" | "woocommerce";
  shopify_order_id: string;
  name: string;
  customer_phone: string | null;
}

/**
 * Admin falso: la cola de Revisión, los pedidos de Kapta y lo que se escribe.
 * La búsqueda local se resuelve contra `orders` con sus filtros (ilike sin
 * comodines = igual sin mayúsculas; `%x%` = contiene).
 */
function fakeAdmin(opts: {
  rows: Row[];
  orders?: LocalOrder[];
  ordersError?: boolean;
  shipmentUpdateError?: boolean;
}) {
  const updates: Update[] = [];
  const queries: OrdersQuery[] = [];
  const like = (value: string, pattern: string) => {
    const p = pattern.toLowerCase();
    const v = value.toLowerCase();
    if (p.startsWith("%") && p.endsWith("%")) return v.includes(p.slice(1, -1));
    return v === p;
  };
  const from = (table: string) => {
    const ctx: { op: "select" | "update" | "upsert"; cols: string; values: Row; ids: string[]; f: OrdersQuery } = {
      op: "select",
      cols: "",
      values: {},
      ids: [],
      f: {},
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
        if (col === "store_id") ctx.f.store_id = val;
        if (col === "platform") ctx.f.platform = val;
        return q;
      },
      ilike(_col: string, pattern: string) {
        ctx.f.ilike = pattern;
        return q;
      },
      or(filter: string) {
        ctx.f.or = filter;
        return q;
      },
      not: () => q,
      is: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: table === "orders" ? { id: "ord-shopify" } : null, error: null }),
      then(ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) {
        let result: unknown;
        if (ctx.op === "update") {
          updates.push({ table, values: ctx.values, ids: ctx.ids });
          result = { error: table === "shipments" && opts.shipmentUpdateError && "order_id" in ctx.values ? { message: "x" } : null };
        } else if (ctx.op === "upsert") {
          result = { error: null };
        } else if (table === "shipments" && ctx.cols.startsWith("id,suggested_order_gid")) {
          result = { data: [], error: null };
        } else if (table === "shipments") {
          result = { data: opts.rows, error: null };
        } else if (table === "orders" && ctx.cols.startsWith("id,shopify_order_id")) {
          queries.push({ ...ctx.f });
          if (opts.ordersError) {
            result = { data: null, error: { message: "base caída" } };
          } else {
            const patterns = ctx.f.ilike
              ? [ctx.f.ilike]
              : (ctx.f.or ?? "").split(",").map((c) => c.replace(/^name\.ilike\./, ""));
            const data = (opts.orders ?? [])
              .filter((o) => o.store_id === ctx.f.store_id)
              .filter((o) => !ctx.f.platform || o.platform === ctx.f.platform)
              .filter((o) => patterns.some((p) => like(o.name, p)))
              .map(({ id, shopify_order_id, name, customer_phone }) => ({ id, shopify_order_id, name, customer_phone }));
            result = { data, error: null };
          }
        } else {
          result = { data: [], error: null };
        }
        return Promise.resolve(result).then(ok, fail);
      },
    };
    return q;
  };
  return { admin: { from } as unknown as SupabaseClient, updates, queries };
}

const STORES = [
  { id: "kenku", name: "Kenku Peru" },
  { id: "aurela", name: "Aurela" },
] as unknown as StoreSummary[];

const PHONE = "51930295803";

const WOO_AUR: LocalOrder = {
  id: "ord-woo-aur",
  store_id: "aurela",
  platform: "woocommerce",
  shopify_order_id: "wc-aur-1210",
  name: "#AUR900006",
  customer_phone: PHONE,
};

const SHOPIFY_KP_LOCAL: LocalOrder = {
  id: "ord-shopify-kp",
  store_id: "kenku",
  platform: "shopify",
  shopify_order_id: "6100000000001",
  name: "#KP143600",
  customer_phone: PHONE,
};

function shopifyOrder(over: Partial<OrderRow> = {}): OrderRow {
  return {
    store_id: "kenku",
    shopify_order_id: "6100000000001",
    name: "#KP143600",
    customer_phone: PHONE,
    raw: { id: "gid://shopify/Order/6100000000001" },
    ...over,
  } as OrderRow;
}

/** Lo que se marcó como revisado, por id de envío. */
function checked(updates: Update[]): string[] {
  return updates.filter((u) => u.table === "shipments" && "suggestion_checked_at" in u.values).flatMap((u) => u.ids);
}

function links(updates: Update[]) {
  return updates.filter((u) => u.table === "shipments" && "order_id" in u.values);
}

beforeEach(() => {
  h.search.mockReset();
  h.fetchOrder.mockReset();
  h.tokens.clear();
});

describe("un pedido de WooCommerce se encuentra en la base local", () => {
  it("Shopify contesta sin nada y el de WooCommerce con el mismo celular se vincula, sin pedirle nada a Shopify", async () => {
    h.search.mockResolvedValue([]);
    const { admin, updates, queries } = fakeAdmin({
      rows: [{ id: "g1", order_name: "#AUR900006", customer_phone: PHONE }],
      orders: [WOO_AUR],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 1, linked: 1, done: true });
    expect(h.fetchOrder).not.toHaveBeenCalled();
    expect(links(updates)).toEqual([
      expect.objectContaining({
        ids: ["g1"],
        values: expect.objectContaining({
          order_id: "ord-woo-aur",
          store_id: "aurela",
          order_name: "#AUR900006",
          matched: true,
          match_method: "auto",
        }),
      }),
    ]);
    // `#AUR…` va solo a Aurela; con Shopify contestando, la base solo trae WooCommerce.
    expect(queries[0]).toEqual({ store_id: "aurela", platform: "woocommerce", ilike: "#AUR900006" });
  });

  it("con otro celular no se vincula: queda revisado, como un candidato de Shopify", async () => {
    h.search.mockResolvedValue([]);
    const { admin, updates } = fakeAdmin({
      rows: [{ id: "g1", order_name: "#AUR900006", customer_phone: "51999999999" }],
      orders: [WOO_AUR],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 1, linked: 0, done: true });
    expect(links(updates)).toEqual([]);
    expect(checked(updates)).toEqual(["g1"]);
  });

  it("un candidato de Shopify y uno de WooCommerce con el mismo celular: no hay uno solo, no se vincula", async () => {
    h.search.mockResolvedValue([shopifyOrder({ store_id: "aurela", name: "#AUR178000" })]);
    const { admin, updates } = fakeAdmin({
      rows: [{ id: "g1", order_name: "#AUR900006", customer_phone: PHONE }],
      orders: [WOO_AUR],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 1, linked: 0, done: true });
    expect(links(updates)).toEqual([]);
    expect(h.fetchOrder).not.toHaveBeenCalled();
  });

  it("primero el nombre exacto; si no hay, el que contiene la referencia o sus dígitos", async () => {
    h.search.mockResolvedValue([]);
    const { admin, updates, queries } = fakeAdmin({
      rows: [{ id: "g1", order_name: "900006", customer_phone: PHONE }],
      orders: [WOO_AUR],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    // Sin prefijo se busca en las dos tiendas: exacto y, sin nada, por contener.
    expect(r).toEqual({ processed: 1, linked: 1, done: true });
    expect(queries).toEqual(
      expect.arrayContaining([
        { store_id: "aurela", platform: "woocommerce", ilike: "#900006" },
        { store_id: "aurela", platform: "woocommerce", or: "name.ilike.%900006%" },
      ]),
    );
    expect(links(updates)[0]!.values).toEqual(expect.objectContaining({ order_id: "ord-woo-aur" }));
  });

  it("si la base falla, el envío no queda revisado: se vuelve a buscar", async () => {
    h.search.mockResolvedValue([]);
    const { admin, updates } = fakeAdmin({
      rows: [{ id: "g1", order_name: "#AUR900006", customer_phone: PHONE }],
      ordersError: true,
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 0, linked: 0, done: true, retry: 1 });
    expect(updates).toEqual([]);
  });

  it("si no se pudo escribir el vínculo, no deja una sugerencia (solo sabe de gid de Shopify): se vuelve a buscar", async () => {
    h.search.mockResolvedValue([]);
    const { admin, updates } = fakeAdmin({
      rows: [{ id: "g1", order_name: "#AUR900006", customer_phone: PHONE }],
      orders: [WOO_AUR],
      shipmentUpdateError: true,
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 0, linked: 0, done: true, retry: 1 });
    expect(updates.some((u) => "suggested_order_gid" in u.values && u.values.suggested_order_gid)).toBe(false);
    // Solo el intento de vínculo, que falló; nada lo marca revisado.
    expect(updates.filter((u) => !("order_id" in u.values))).toEqual([]);
  });
});

describe("Shopify sin token o que ya no está: sus pedidos también se buscan en la base", () => {
  it("402 (tienda que ya no está): se busca en la base, las dos plataformas, y se vincula con la fila de Kapta", async () => {
    h.search.mockRejectedValue(new Error("Shopify GraphQL HTTP 402: Unavailable Shop"));
    const { admin, updates, queries } = fakeAdmin({
      rows: [
        { id: "g1", order_name: "#KP143600", customer_phone: PHONE },
        { id: "g2", order_name: "#KP200001", customer_phone: PHONE },
      ],
      orders: [SHOPIFY_KP_LOCAL],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 2, linked: 1, done: true });
    expect(h.fetchOrder).not.toHaveBeenCalled();
    // A Kenku se le preguntó una sola vez en la tanda: ya dijo que no está.
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(queries[0]).toEqual({ store_id: "kenku", ilike: "#KP143600" });
    expect(links(updates)).toEqual([
      expect.objectContaining({
        ids: ["g1"],
        values: expect.objectContaining({ order_id: "ord-shopify-kp", order_name: "#KP143600" }),
      }),
    ]);
    // El otro se buscó y no está: queda revisado.
    expect(checked(updates)).toContain("g2");
  });

  it("sin token de Shopify: se busca en la base en vez de darlo por revisado sin buscar", async () => {
    h.tokens.set("kenku", null);
    const { admin, updates } = fakeAdmin({
      rows: [{ id: "g1", order_name: "#KP143600", customer_phone: PHONE }],
      orders: [SHOPIFY_KP_LOCAL],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(h.search).not.toHaveBeenCalled();
    expect(r).toEqual({ processed: 1, linked: 1, done: true });
    expect(links(updates)[0]!.values).toEqual(expect.objectContaining({ order_id: "ord-shopify-kp" }));
  });

  it("un 5xx no es «ya no está»: no se busca en la base y se reintenta", async () => {
    h.search.mockRejectedValue(new Error("Shopify GraphQL HTTP 503: Service Unavailable"));
    const { admin, updates, queries } = fakeAdmin({
      rows: [{ id: "g1", order_name: "#KP143600", customer_phone: PHONE }],
      orders: [SHOPIFY_KP_LOCAL],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 0, linked: 0, done: true, retry: 1 });
    expect(queries).toEqual([]);
    expect(updates).toEqual([]);
  });
});

describe("con Shopify contestando, sus pedidos se siguen buscando en Shopify", () => {
  it("el candidato de Shopify se vincula leyéndolo de Shopify, como siempre; la base solo mira WooCommerce", async () => {
    h.search.mockResolvedValue([shopifyOrder()]);
    h.fetchOrder.mockResolvedValue(shopifyOrder());
    const { admin, updates, queries } = fakeAdmin({
      rows: [{ id: "g1", order_name: "#KP143600", customer_phone: PHONE }],
      // Está también en Kapta, pero con Shopify contestando no se usa.
      orders: [SHOPIFY_KP_LOCAL],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 1, linked: 1, done: true });
    expect(h.fetchOrder).toHaveBeenCalledTimes(1);
    expect(queries.every((q) => q.platform === "woocommerce")).toBe(true);
    expect(links(updates)[0]!.values).toEqual(expect.objectContaining({ order_id: "ord-shopify", match_method: "auto" }));
  });
});

describe("la referencia para la base", () => {
  it("sin «#» ni nada que haga de comodín o rompa el filtro", () => {
    expect(localOrderReference("#KP200001")).toBe("KP200001");
    expect(localOrderReference(" kp200001 ")).toBe("kp200001");
    expect(localOrderReference("#KP%2,00(0)01_")).toBe("KP200001");
  });

  it("una referencia de menos de dos caracteres no se busca", async () => {
    const { admin, queries } = fakeAdmin({ rows: [], orders: [WOO_AUR] });
    expect(await searchLocalOrderCandidates(admin, "aurela", "#%", "todas")).toEqual([]);
    expect(queries).toEqual([]);
  });
});

describe("MOM §38.12 y el código", () => {
  const MOM = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
  const code = readFileSync(resolve(process.cwd(), "lib/shipment-auto-match.ts"), "utf8");

  it("la decisión está escrita, con su porqué", () => {
    for (const text of [
      "#### Envíos: el auto-vínculo y la búsqueda con pedidos de WooCommerce (25-10-2026)",
      "**Auto-vínculo y búsqueda de Envíos** con pedidos de WooCommerce: **hecho (25-10-2026)**",
      "**Decisión: los pedidos de Shopify se siguen buscando en Shopify mientras la tienda tenga token y Shopify conteste**",
      "**Los pedidos de WooCommerce, en la base local, siempre**",
      "`test/shipment-auto-match-local.test.ts`",
    ]) {
      expect(MOM.includes(text), text).toBe(true);
    }
  });

  it("el código cita la sección y usa la misma regla de «la tienda ya no está» que la dirección", () => {
    expect(code).toContain("MOM §38.12 «Envíos: el auto-vínculo y la");
    expect(code).toContain("if (!isShopifyShopGone(e)) return { failed: true };");
    expect(code).toContain('if (scope === "woocommerce") q = q.eq("platform", "woocommerce");');
  });
});
