// MOM §37.8 (owner, 30-10-2026): un pedido que entra sin dirección (#KP144042,
// Catálogo de WhatsApp, «Por revisar») sugiere el último destino conocido de la
// clienta por su celular, en las dos tiendas de la organización. Caso real: el
// mismo celular tiene #KP200293 (Kenku, 27-10-2026) con dirección en Sullana.
// Nada aquí toca una base de verdad; los datos son inventados.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({ createServerSupabaseMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ createServerSupabase: createServerSupabaseMock }));

import {
  destinationNote,
  needsDestinationSuggestion,
  phoneLookupVariants,
  pickLastKnownDestinations,
  type KaptaDestinationRow,
  type ShopifyHistoryDestinationRow,
} from "@/lib/last-known-destination";
import { loadLastKnownDestinations } from "@/app/dashboard/pedidos/last-destination-actions";

const read = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8");

const KENKU = "store-kenku";
const AURELA = "store-aurela";
const names = { [KENKU]: "Kenku Peru", [AURELA]: "Aurela" };

const kapta = (over: Partial<KaptaDestinationRow>): KaptaDestinationRow => ({
  order_id: "o-prev",
  order_name: "#KP200293",
  store_id: KENKU,
  order_created_at: "2026-10-27T12:31:46Z",
  general_status: "entregado",
  address: "Calle Ficticia 123",
  reference: "Frente al parque",
  district: "Sullana",
  province: "Sullana",
  region: "Piura",
  latitude: -4.9,
  longitude: -80.68,
  ...over,
});

const hist = (over: Partial<ShopifyHistoryDestinationRow>): ShopifyHistoryDestinationRow => ({
  order_name: "#KP9001",
  store_id: KENKU,
  created_at: "2025-03-01T10:00:00Z",
  cancelled_at: null,
  fulfilled_at: "2025-03-02T10:00:00Z",
  shipping_address1: "Jr. Inventado 45",
  shipping_address2: "Casa azul",
  shipping_city: "Castilla",
  shipping_province: "Piura",
  ...over,
});

describe("needsDestinationSuggestion: solo «Por revisar» y sin región, distrito o dirección", () => {
  it("el pedido sin dirección del Catálogo de WhatsApp necesita sugerencia", () => {
    expect(needsDestinationSuggestion({ coverage: "por_revisar", region: null, district: null, address: null })).toBe(
      true,
    );
    expect(needsDestinationSuggestion({ coverage: null })).toBe(true);
    expect(needsDestinationSuggestion({ coverage: "por_revisar", region: "Piura", district: "Sullana", address: " " })).toBe(
      true,
    );
  });

  it("con cobertura resuelta o la ubicación completa, no", () => {
    expect(needsDestinationSuggestion({ coverage: "provincia_cod", region: null, district: null, address: null })).toBe(
      false,
    );
    expect(
      needsDestinationSuggestion({ coverage: "por_revisar", region: "Piura", district: "Sullana", address: "Calle 1" }),
    ).toBe(false);
  });
});

describe("phoneLookupVariants: por el índice de teléfono, en sus formas guardadas", () => {
  it("normalizado, nacional y tal cual", () => {
    expect(phoneLookupVariants("51987654321").sort()).toEqual(["51987654321", "987654321"].sort());
    expect(phoneLookupVariants("987 654 321").sort()).toEqual(["51987654321", "987 654 321", "987654321"].sort());
    expect(phoneLookupVariants(null)).toEqual([]);
  });
});

describe("pickLastKnownDestinations", () => {
  it("caso #KP144042: sugiere la dirección de #KP200293 con tienda, fecha y coordenada", () => {
    const r = pickLastKnownDestinations({
      kapta: [kapta({})],
      storeNames: names,
      excludeOrderId: "o-open",
      excludeOrderName: "#KP144042",
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      source: "kapta",
      orderName: "#KP200293",
      storeName: "Kenku Peru",
      district: "Sullana",
      province: "Sullana",
      region: "Piura",
      latitude: -4.9,
      longitude: -80.68,
      delivered: true,
      cancelled: false,
    });
  });

  it("nunca se sugiere el propio pedido", () => {
    const r = pickLastKnownDestinations({ kapta: [kapta({ order_id: "o-open" })], excludeOrderId: "o-open" });
    expect(r).toEqual([]);
  });

  it("busca en las dos tiendas, la más reciente primero, sin repetir la misma dirección, hasta 3", () => {
    const r = pickLastKnownDestinations({
      kapta: [
        kapta({ order_id: "a", order_name: "#AUR1", store_id: AURELA, order_created_at: "2026-09-01T00:00:00Z", address: "Av. Uno 1" }),
        kapta({ order_id: "b", order_created_at: "2026-10-27T00:00:00Z" }),
        kapta({ order_id: "c", order_name: "#KP3", order_created_at: "2026-08-01T00:00:00Z", address: "CALLE FICTICIA, 123" }),
        kapta({ order_id: "d", order_name: "#KP4", order_created_at: "2026-07-01T00:00:00Z", address: "Av. Dos 2" }),
        kapta({ order_id: "e", order_name: "#KP5", order_created_at: "2026-06-01T00:00:00Z", address: "Av. Tres 3" }),
      ],
      storeNames: names,
      excludeOrderId: "o-open",
    });
    expect(r.map((d) => [d.orderName, d.storeName])).toEqual([
      ["#KP200293", "Kenku Peru"],
      ["#AUR1", "Aurela"],
      ["#KP4", "Kenku Peru"],
    ]);
  });

  it("un anulado entra solo si su dirección sirve, y se marca", () => {
    const r = pickLastKnownDestinations({
      kapta: [
        kapta({ order_id: "x", general_status: "anulado", address: null }),
        kapta({ order_id: "y", general_status: "anulado", order_created_at: "2026-05-01T00:00:00Z", address: "Av. Real 9" }),
      ],
      excludeOrderId: "o-open",
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ address: "Av. Real 9", cancelled: true, delivered: false });
  });

  it("sin calle o sin distrito ni región, no sirve", () => {
    const r = pickLastKnownDestinations({
      kapta: [kapta({ address: "Calle 1", district: null, region: null }), kapta({ order_id: "z", address: "" })],
      excludeOrderId: "o-open",
    });
    expect(r).toEqual([]);
  });

  it("si Kapta no tiene ninguna que sirva, usa el historial de Shopify (región = province, distrito = city)", () => {
    const r = pickLastKnownDestinations({
      kapta: [kapta({ address: null, order_name: "#KP200293" })],
      shopifyOrders: [
        hist({ order_name: "#KP144042", shipping_address1: "Copia del propio pedido" }),
        hist({ order_name: "#KP200293", shipping_address1: "Ya mirado en Kapta" }),
        hist({}),
      ],
      storeNames: names,
      excludeOrderId: "o-open",
      excludeOrderName: "#KP144042",
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      source: "shopify_pedido",
      orderName: "#KP9001",
      orderId: null,
      address: "Jr. Inventado 45",
      reference: "Casa azul",
      district: "Castilla",
      province: null,
      region: "Piura",
      delivered: true,
    });
  });

  it("Kapta manda sobre el historial aunque el historial sea más reciente", () => {
    const r = pickLastKnownDestinations({
      kapta: [kapta({ order_created_at: "2025-01-01T00:00:00Z" })],
      shopifyOrders: [hist({ created_at: "2026-10-01T00:00:00Z" })],
      excludeOrderId: "o-open",
    });
    expect(r.map((d) => d.source)).toEqual(["kapta"]);
  });

  it("sin pedidos con dirección, la ficha de clienta del historial", () => {
    const r = pickLastKnownDestinations({
      kapta: [],
      shopifyOrders: [],
      shopifyCustomers: [{ store_id: AURELA, address1: "Pasaje Falso 7", address2: null, city: "Piura", province: "Piura" }],
      storeNames: names,
      excludeOrderId: "o-open",
    });
    expect(r[0]).toMatchObject({ source: "shopify_clienta", storeName: "Aurela", date: null, orderName: null });
  });

  it("la nota del formulario dice de qué pedido, tienda y fecha sale", () => {
    const [d] = pickLastKnownDestinations({ kapta: [kapta({})], storeNames: names, excludeOrderId: "o-open" });
    expect(destinationNote(d!, () => "27-10-2026")).toBe(
      "Último destino conocido de la clienta (pedido #KP200293, Kenku Peru, 27-10-2026).",
    );
  });
});

// --- La acción del servidor, con una base de mentira ---------------------------

type Call = { table: string; op: string; args: unknown[] };

function fakeSupabase(tables: Record<string, unknown[] | ((calls: Call[]) => unknown)>) {
  const calls: Call[] = [];
  const builder = (table: string) => {
    const own: Call[] = [];
    const record = (op: string) => (...args: unknown[]) => {
      const c = { table, op, args };
      calls.push(c);
      own.push(c);
      return chain;
    };
    const result = () => {
      const t = tables[table];
      const data = typeof t === "function" ? t(own) : (t ?? []);
      return { data, error: null };
    };
    const chain: Record<string, unknown> = {
      select: record("select"),
      eq: record("eq"),
      neq: record("neq"),
      in: record("in"),
      order: record("order"),
      limit: record("limit"),
      maybeSingle: () => {
        const r = result();
        return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null });
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej),
    };
    for (const w of ["insert", "update", "upsert", "delete"]) {
      chain[w] = () => {
        throw new Error(`escritura prohibida en ${table}`);
      };
    }
    return chain;
  };
  return { client: { from: (t: string) => builder(t) }, calls };
}

describe("loadLastKnownDestinations: solo lee, para el pedido abierto", () => {
  beforeEach(() => createServerSupabaseMock.mockReset());

  const openOrder = {
    order_id: "o-open",
    order_name: "#KP144042",
    store_id: KENKU,
    customer_phone: "51987654321",
    coverage: "por_revisar",
    region: null,
    district: null,
    address: null,
  };

  it("busca por celular en las tiendas de la organización y devuelve #KP200293", async () => {
    const fake = fakeSupabase({
      order_master: (own) =>
        own.some((c) => c.op === "in" && c.args[0] === "customer_phone") ? [kapta({})] : [openOrder],
      stores: (own) =>
        own.some((c) => c.op === "eq" && c.args[0] === "org_id")
          ? [
              { id: KENKU, name: "Kenku Peru" },
              { id: AURELA, name: "Aurela" },
            ]
          : [{ org_id: "org-1", name: "Kenku Peru" }],
    });
    createServerSupabaseMock.mockResolvedValue(fake.client);
    const r = await loadLastKnownDestinations("o-open");
    expect(r.map((d) => [d.orderName, d.storeName])).toEqual([["#KP200293", "Kenku Peru"]]);

    const phoneIn = fake.calls.find((c) => c.table === "order_master" && c.op === "in" && c.args[0] === "customer_phone");
    expect((phoneIn!.args[1] as string[]).sort()).toEqual(["51987654321", "987654321"]);
    const storeIn = fake.calls.find((c) => c.table === "order_master" && c.op === "in" && c.args[0] === "store_id");
    expect((storeIn!.args[1] as string[]).sort()).toEqual([AURELA, KENKU].sort());
    expect(fake.calls.some((c) => c.op === "neq" && c.args[0] === "order_id" && c.args[1] === "o-open")).toBe(true);
    // Kapta tenía dirección: el historial de Shopify ni se consulta.
    expect(fake.calls.some((c) => c.table === "shopify_history_orders")).toBe(false);
  });

  it("sin Kapta, va al historial de Shopify por (store_id, phone_norm)", async () => {
    const fake = fakeSupabase({
      order_master: (own) => (own.some((c) => c.op === "in" && c.args[0] === "customer_phone") ? [] : [openOrder]),
      stores: (own) =>
        own.some((c) => c.op === "eq" && c.args[0] === "org_id")
          ? [
              { id: KENKU, name: "Kenku Peru" },
              { id: AURELA, name: "Aurela" },
            ]
          : [{ org_id: "org-1", name: "Kenku Peru" }],
      shopify_history_orders: [hist({ store_id: AURELA, order_name: "#AUR50" })],
    });
    createServerSupabaseMock.mockResolvedValue(fake.client);
    const r = await loadLastKnownDestinations("o-open");
    expect(r[0]).toMatchObject({ source: "shopify_pedido", orderName: "#AUR50", storeName: "Aurela" });
    expect(
      fake.calls.some(
        (c) => c.table === "shopify_history_orders" && c.op === "eq" && c.args[0] === "phone_norm" && c.args[1] === "51987654321",
      ),
    ).toBe(true);
  });

  it("un pedido que no está «Por revisar» no consulta nada más", async () => {
    const fake = fakeSupabase({ order_master: [{ ...openOrder, coverage: "lima" }] });
    createServerSupabaseMock.mockResolvedValue(fake.client);
    expect(await loadLastKnownDestinations("o-open")).toEqual([]);
    expect(fake.calls.filter((c) => c.op === "select")).toHaveLength(1);
  });

  it("si la base falla, no hay sugerencia (y no revienta)", async () => {
    createServerSupabaseMock.mockResolvedValue({
      from: () => {
        throw new Error("la base no responde");
      },
    });
    expect(await loadLastKnownDestinations("o-open")).toEqual([]);
  });
});

describe("cableado: sugiere, no aplica; sin datos de la clienta en registros", () => {
  const action = read("app/dashboard/pedidos/last-destination-actions.ts");
  const drawer = read("components/order-drawer.tsx");

  it("la acción solo lee y no registra nada", () => {
    expect(action).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(action).not.toMatch(/console\./);
    expect(action).not.toMatch(/createAdminSupabase/);
  });

  it("el cajón ofrece «Usar esta dirección», que abre el formulario de «Corregir ubicación»", () => {
    expect(drawer).toContain("Último destino conocido de esta clienta");
    expect(drawer).toContain("Usar esta dirección");
    expect(drawer).toMatch(/onUse=\{\(d\) => void open\(d\)\}/);
    // No hay atajo que guarde la sugerencia sin pasar por el formulario.
    const suggestions = drawer.slice(drawer.indexOf("function LastDestinationSuggestions("), drawer.indexOf("function LabeledInput("));
    expect(suggestions).not.toContain("updateOrderGeo");
  });

  it("el MOM documenta la regla", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("### 37.8 Último destino conocido de la clienta");
    expect(mom).toMatch(/nunca se aplica sola/i);
  });
});
