// MOM §37.7 (25-10-2026): «Pedidos antes» de Leads también mira el historial
// de Shopify importado (`shopify_history_orders`). Antes solo leía `orders`, que
// en Kenku empieza en 07-2024 y en Aurela en 05-2024, y a la clienta que compró
// antes le salía «Ninguno: es cliente nuevo». Nada aquí toca una base de verdad.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({ createServerSupabaseMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ createServerSupabase: createServerSupabaseMock }));

import { combinePriorOrders, firstProductTitle, historyNetAmount } from "@/lib/customer-history-merge";
import { getCustomerHistory } from "@/lib/leads-access";
import { mergePriorOrders } from "@/lib/order-admin-url";

const read = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8");

type Row = Record<string, unknown>;

const local = (id: string, name: string, created_at: string, extra: Row = {}) => ({
  id,
  name,
  created_at,
  cancelled_at: null as string | null,
  line_items: [{ title: `Producto ${name}` }],
  ...extra,
});
const hist = (order_name: string, created_at: string, extra: Row = {}) => ({
  order_name,
  created_at,
  total: 120,
  refunded_amount: 20,
  line_items: [{ name: `Producto ${order_name}` }],
  ...extra,
});

describe("combinePriorOrders: Kapta + historial de Shopify, sin repetir", () => {
  it("una clienta solo del historial deja de ser nueva", () => {
    const r = combinePriorOrders([], [hist("#KP100", "2023-08-01T10:00:00Z"), hist("#KP50", "2023-05-01T10:00:00Z")]);
    expect(r.count).toBe(2);
    expect(r.entries.map((e) => e.kind)).toEqual(["history", "history"]);
  });

  it("el mismo número en `orders` y en el historial cuenta una vez (manda Kapta)", () => {
    const r = combinePriorOrders(
      [local("o1", "#KP900", "2025-01-10T10:00:00Z")],
      [hist("#KP900", "2025-01-10T10:00:00Z"), hist("#KP100", "2023-08-01T10:00:00Z")],
      { historyTotal: 2 },
    );
    expect(r.count).toBe(2);
    expect(r.entries.map((e) => [e.kind, e.kind === "local" ? e.row.name : e.row.order_name])).toEqual([
      ["local", "#KP900"],
      ["history", "#KP100"],
    ]);
  });

  it("el anulado en Kapta no vuelve por su copia del historial", () => {
    const r = combinePriorOrders(
      [local("o1", "#KP900", "2025-01-10T10:00:00Z", { cancelled_at: "2025-01-11T10:00:00Z" })],
      [hist("#KP900", "2025-01-10T10:00:00Z")],
    );
    expect(r.count).toBe(0);
  });

  it("el pedido propio del lead no cuenta, ni por id ni por su copia en el historial", () => {
    const r = combinePriorOrders(
      [local("own", "#KP999", "2026-10-20T10:00:00Z")],
      [hist("#KP999", "2026-10-20T10:00:00Z")],
      { excludeOrderId: "own", currentOrderName: "#KP999" },
    );
    expect(r.count).toBe(0);
  });

  it("los del historial que el límite no leyó se suman al conteo", () => {
    const r = combinePriorOrders([], [hist("#KP3", "2023-03-01T00:00:00Z")], { historyTotal: 40 });
    expect(r.entries).toHaveLength(1);
    expect(r.count).toBe(40);
  });

  it("producto y neto del historial", () => {
    expect(firstProductTitle([{ name: "Faja" }])).toBe("Faja");
    expect(firstProductTitle([{ title: "Collar" }])).toBe("Collar");
    expect(firstProductTitle([])).toBeNull();
    expect(historyNetAmount({ total: 120, refunded_amount: 20 })).toBe(100);
    expect(historyNetAmount({ total: null, refunded_amount: null })).toBe(0);
  });
});

describe("getCustomerHistory lee el historial de Shopify", () => {
  let historyFilters: [string, unknown][];
  let historySelect: { cols: string; opts: unknown } | null;

  function mockDb(orders: Row[], history: { data: Row[] | null; error?: unknown; count?: number | null }) {
    historyFilters = [];
    historySelect = null;
    createServerSupabaseMock.mockResolvedValue({
      from: (table: string) => {
        const q: Record<string, unknown> = {};
        q.select = (cols: string, opts?: unknown) => {
          if (table === "shopify_history_orders") historySelect = { cols, opts };
          return q;
        };
        q.eq = (col: string, v: unknown) => {
          if (table === "shopify_history_orders") historyFilters.push([col, v]);
          return q;
        };
        q.is = (col: string, v: unknown) => {
          if (table === "shopify_history_orders") historyFilters.push([col, v]);
          return q;
        };
        for (const m of ["order", "limit"]) q[m] = () => q;
        q.then = (res: (v: unknown) => void) =>
          res(
            table === "shopify_history_orders"
              ? { data: history.data, error: history.error ?? null, count: history.count ?? null }
              : { data: orders, error: null },
          );
        return q;
      },
    });
  }

  beforeEach(() => createServerSupabaseMock.mockReset());

  it("clienta de 2023 sin pedidos en Kapta: no es cliente nueva", async () => {
    mockDb([], { data: [hist("#KP120", "2023-09-01T10:00:00-05:00"), hist("#KP80", "2023-06-01T10:00:00-05:00")], count: 2 });
    const h = await getCustomerHistory("store-kenku", "51999888777", null, "kenku.myshopify.com", null);
    expect(h!.orderCount).toBe(2);
    expect(h!.lastOrderName).toBe("#KP120");
    expect(h!.lastProduct).toBe("Producto #KP120");
    expect(h!.recentOrders).toEqual([
      { name: "#KP120", createdAt: "2023-09-01T10:00:00-05:00", amount: 100, adminUrl: null, platform: "shopify", fromHistory: true },
      { name: "#KP80", createdAt: "2023-06-01T10:00:00-05:00", amount: 100, adminUrl: null, platform: "shopify", fromHistory: true },
    ]);
  });

  it("busca por el celular normalizado, en la misma tienda, sin anulados y con conteo exacto", async () => {
    mockDb([], { data: [], count: 0 });
    await getCustomerHistory("store-kenku", "999 888 777", null, null, null);
    expect(historyFilters).toEqual([
      ["store_id", "store-kenku"],
      ["phone_norm", "51999888777"],
      ["cancelled_at", null],
    ]);
    expect(historySelect!.opts).toEqual({ count: "exact" });
  });

  it("deduplica con `orders` por número y suma los dos lados", async () => {
    mockDb(
      [
        { ...local("o1", "#KP900", "2025-02-01T10:00:00Z"), shopify_order_id: "1", total_amount: 89, total_refunded: 0, platform: "shopify" },
      ],
      { data: [hist("#KP900", "2025-02-01T10:00:00Z"), hist("#KP100", "2023-08-01T10:00:00Z")], count: 2 },
    );
    const h = await getCustomerHistory("store-kenku", "51999888777", null, null, null);
    expect(h!.orderCount).toBe(2);
    expect(h!.recentOrders.map((o) => [o.name, o.fromHistory ?? false])).toEqual([
      ["#KP900", false],
      ["#KP100", true],
    ]);
  });

  it("sin la tabla del historial (o con error) queda como antes: solo `orders`", async () => {
    mockDb([], { data: null, error: { code: "42P01", message: "relation does not exist" } });
    const h = await getCustomerHistory("store-kenku", "51999888777", null, null, null);
    expect(h!.orderCount).toBe(0);
    expect(h!.recentOrders).toEqual([]);
  });
});

describe("mergePriorOrders conserva los del historial que Shopify en vivo no trajo", () => {
  const o = (name: string, createdAt: string, extra: Record<string, unknown> = {}) => ({ name, createdAt, ...extra });

  it("Shopify en vivo trae uno; el del historial más viejo completa la lista", () => {
    const shop = [o("#KP900", "2026-10-01T10:00:00Z")];
    const local = [o("#KP100", "2023-08-01T10:00:00Z", { fromHistory: true, platform: "shopify" as const })];
    expect(mergePriorOrders(shop, local).map((x) => x.name)).toEqual(["#KP900", "#KP100"]);
  });

  it("no repite el que Shopify en vivo ya trajo", () => {
    const shop = [o("#KP900", "2026-10-01T10:00:00Z")];
    const local = [o("#KP900", "2026-10-01T10:00:00Z", { fromHistory: true })];
    expect(mergePriorOrders(shop, local)).toBe(shop);
  });
});

describe("MOM §37.7 y la regla del archivo", () => {
  const mom = read("docs/mom/master-pedidos-v1.md");

  it("el MOM documenta «Pedidos antes» con el historial", () => {
    expect(mom).toContain("### 37.7 «Pedidos antes» en Leads");
    expect(mom).toContain("del historial de Shopify");
  });

  it("la lectura del historial nunca escribe en `orders`", () => {
    const src = read("lib/leads-access.ts");
    const fn = src.slice(src.indexOf("async function readShopifyHistory"), src.indexOf("/** Valores neutros"));
    expect(fn).toContain('from("shopify_history_orders")');
    expect(fn).not.toMatch(/\.(insert|upsert|update|delete)\(/);
    expect(fn).toContain(".limit(HISTORY_PRIOR_LIMIT)");
  });

  it("las dos fichas marcan el pedido del historial", () => {
    expect(read("components/leads-drawer.tsx")).toContain("del historial de Shopify");
    expect(read("components/leads-next.tsx")).toContain("del historial de Shopify");
  });
});
