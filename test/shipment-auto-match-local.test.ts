// El auto-vínculo de la cola «Revisión» busca en la base de Kapta (MOM §38.12
// «Envíos: el auto-vínculo y la búsqueda con pedidos de WooCommerce»).
//
// LA REGLA (decisión del owner del 25-10-2026). El auto-vínculo busca siempre
// en `orders` de Kapta, que ya tiene los pedidos de Shopify y los de
// WooCommerce de la tienda: nunca le pregunta a Shopify. Primero el nombre
// exacto, luego el que contiene la referencia o sus dígitos. Se vincula solo
// con un único candidato con el mismo celular, con su fila de Kapta. Una
// sugerencia vieja guardada con un gid de Shopify se vincula con la fila de ese
// pedido en `orders`; si no está, la sugerencia se limpia.
//
// Antes (9857c60c) los de Shopify se buscaban en Shopify mientras contestara.
// Cada prueba de abajo falla si se vuelve a eso o si se rompe la regla.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PHONE,
  STORES,
  checked,
  fakeAdmin,
  links,
  savedSuggestions,
  type LocalOrder,
} from "./shipment-auto-match-fake";

// Nunca se llama a Shopify: cualquier llamada falla la prueba (afterEach).
const h = vi.hoisted(() => ({
  shopify: vi.fn((what: string) => {
    throw new Error(`no se debe llamar a Shopify (${what})`);
  }),
}));
vi.mock("@/lib/shopify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shopify")>()),
  searchOrdersLive: () => h.shopify("searchOrdersLive"),
  fetchOrderById: () => h.shopify("fetchOrderById"),
  updateOrderShippingAddress: () => h.shopify("updateOrderShippingAddress"),
}));
vi.mock("@/lib/ingest", () => ({
  getStoreCreds: () => h.shopify("getStoreCreds"),
}));
vi.mock("@/lib/shipment-order-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shipment-order-capture")>()),
  captureShopifyOrderForLink: () => h.shopify("captureShopifyOrderForLink"),
}));

import {
  localOrderReference,
  runSuggestionBatch,
  searchLocalOrderCandidates,
  shopifyOrderIdFromGid,
} from "@/lib/shipment-auto-match";

const WOO_AUR: LocalOrder = {
  id: "ord-woo-aur",
  store_id: "aurela",
  platform: "woocommerce",
  shopify_order_id: "wc-aur-1210",
  name: "#AUR900006",
  customer_phone: PHONE,
};

const SHOPIFY_KP: LocalOrder = {
  id: "ord-shopify-kp",
  store_id: "kenku",
  platform: "shopify",
  shopify_order_id: "6100000000001",
  name: "#KP143600",
  customer_phone: PHONE,
};

beforeEach(() => {
  h.shopify.mockClear();
});

afterEach(() => {
  expect(h.shopify).not.toHaveBeenCalled();
});

describe("los pedidos de Shopify y de WooCommerce se encuentran en `orders`", () => {
  it("uno de WooCommerce con el mismo celular se vincula con su fila", async () => {
    const { admin, updates, queries } = fakeAdmin({
      rows: [{ id: "g1", order_name: "#AUR900006", customer_phone: PHONE }],
      orders: [WOO_AUR],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 1, linked: 1, done: true });
    expect(links(updates)).toEqual([
      expect.objectContaining({
        ids: ["g1"],
        values: expect.objectContaining({
          order_id: "ord-woo-aur",
          store_id: "aurela",
          order_name: "#AUR900006",
          matched: true,
          match_method: "auto",
          suggested_order_gid: null,
        }),
      }),
    ]);
    // `#AUR…` va solo a Aurela, sin filtrar por plataforma.
    expect(queries).toEqual([{ store_id: "aurela", ilike: "#AUR900006" }]);
  });

  it("uno de Shopify con el mismo celular se vincula con su fila de Kapta, sin preguntarle a Shopify", async () => {
    const { admin, updates, queries } = fakeAdmin({
      rows: [{ id: "g1", order_name: "#KP143600", customer_phone: PHONE }],
      orders: [SHOPIFY_KP],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 1, linked: 1, done: true });
    expect(links(updates)).toEqual([
      expect.objectContaining({
        ids: ["g1"],
        values: expect.objectContaining({ order_id: "ord-shopify-kp", store_id: "kenku", order_name: "#KP143600" }),
      }),
    ]);
    // La base no se limita a WooCommerce: trae las dos plataformas.
    expect(queries.every((q) => q.platform === undefined)).toBe(true);
  });

  it("con otro celular no se vincula: queda revisado", async () => {
    const { admin, updates } = fakeAdmin({
      rows: [{ id: "g1", order_name: "#AUR900006", customer_phone: "51999999999" }],
      orders: [WOO_AUR],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 1, linked: 0, done: true });
    expect(links(updates)).toEqual([]);
    expect(checked(updates)).toEqual(["g1"]);
  });

  it("uno de Shopify y uno de WooCommerce con el mismo celular: no hay uno solo, no se vincula", async () => {
    // Sin prefijo, la referencia va a las dos tiendas.
    const { admin, updates } = fakeAdmin({
      rows: [{ id: "g1", order_name: "200001", customer_phone: PHONE }],
      orders: [
        { ...SHOPIFY_KP, name: "#KP200001" },
        { ...WOO_AUR, name: "#AUR200001" },
      ],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 1, linked: 0, done: true });
    expect(links(updates)).toEqual([]);
    expect(savedSuggestions(updates)).toEqual([]);
    expect(checked(updates)).toEqual(["g1"]);
  });

  it("un pedido que todavía no está en `orders` no se encuentra: el envío queda revisado sin vínculo", async () => {
    const { admin, updates } = fakeAdmin({
      rows: [{ id: "g1", order_name: "#KP143600", customer_phone: PHONE }],
      orders: [],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 1, linked: 0, done: true });
    expect(links(updates)).toEqual([]);
    expect(checked(updates)).toEqual(["g1"]);
  });
});

describe("el orden de la búsqueda: nombre exacto primero, luego contiene o dígitos", () => {
  it("con un nombre exacto no se mira el que solo lo contiene (aunque tenga el mismo celular)", async () => {
    const { admin, updates, queries } = fakeAdmin({
      rows: [{ id: "g1", order_name: "#KP1436", customer_phone: PHONE }],
      orders: [
        { ...SHOPIFY_KP, id: "ord-exacto", name: "#KP1436" },
        { ...SHOPIFY_KP, id: "ord-contiene", shopify_order_id: "6100000000002", name: "#KP143600" },
      ],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 1, linked: 1, done: true });
    expect(links(updates)[0]!.values).toEqual(expect.objectContaining({ order_id: "ord-exacto" }));
    expect(queries).toEqual([{ store_id: "kenku", ilike: "#KP1436" }]);
  });

  it("sin nombre exacto, el que contiene la referencia o sus dígitos", async () => {
    const { admin, updates, queries } = fakeAdmin({
      rows: [{ id: "g1", order_name: "AUR-900006", customer_phone: PHONE }],
      orders: [WOO_AUR],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 1, linked: 1, done: true });
    expect(queries).toEqual([
      { store_id: "aurela", ilike: "#AUR-900006" },
      { store_id: "aurela", or: "name.ilike.%AUR-900006%,name.ilike.%900006%" },
    ]);
    expect(links(updates)[0]!.values).toEqual(expect.objectContaining({ order_id: "ord-woo-aur" }));
  });

  it("searchLocalOrderCandidates devuelve las filas de las dos plataformas, con su id de Kapta", async () => {
    const { admin } = fakeAdmin({
      orders: [
        { ...SHOPIFY_KP, name: "#KP900006" },
        { ...WOO_AUR, store_id: "kenku", name: "#KP9000061" },
      ],
    });
    const found = await searchLocalOrderCandidates(admin, "kenku", "900006");
    expect(found).toEqual([
      { gid: "6100000000001", storeId: "kenku", name: "#KP900006", customer_phone: PHONE, orderId: "ord-shopify-kp" },
      { gid: "wc-aur-1210", storeId: "kenku", name: "#KP9000061", customer_phone: PHONE, orderId: "ord-woo-aur" },
    ]);
  });
});

describe("una sugerencia guardada con un gid de Shopify", () => {
  const PEND = {
    id: "s1",
    suggested_order_gid: "gid://shopify/Order/6100000000001",
    suggested_store_id: "kenku",
    suggested_order_name: "#KP143600 (viejo)",
  };

  it("se vincula con la fila de ese pedido en `orders`, con el nombre que tiene Kapta", async () => {
    const { admin, updates, queries } = fakeAdmin({ pend: [PEND], orders: [SHOPIFY_KP] });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 1, linked: 1, done: false });
    expect(queries).toEqual([{ store_id: "kenku", shopify_order_id: "6100000000001" }]);
    expect(links(updates)).toEqual([
      expect.objectContaining({
        ids: ["s1"],
        values: expect.objectContaining({
          order_id: "ord-shopify-kp",
          store_id: "kenku",
          order_name: "#KP143600",
          match_method: "auto",
          suggested_order_gid: null,
        }),
      }),
    ]);
  });

  it("si el pedido no está en `orders`, se limpia la sugerencia y no se vincula", async () => {
    const { admin, updates } = fakeAdmin({ pend: [PEND], orders: [] });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 1, linked: 0, done: false });
    expect(links(updates)).toEqual([]);
    expect(updates).toEqual([
      {
        table: "shipments",
        ids: ["s1"],
        values: { suggested_order_gid: null, suggested_store_id: null, suggested_order_name: null },
      },
    ]);
  });

  it("si la base falla al leerlo, la sugerencia se queda como estaba y se reintenta", async () => {
    const { admin, updates } = fakeAdmin({ pend: [PEND], orders: [SHOPIFY_KP], lookupError: true });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(updates).toEqual([]);
    // Nada avanzó: se termina el bucle del cliente en vez de pedir lo mismo sin fin.
    expect(r).toEqual({ processed: 0, linked: 0, done: true, retry: 1 });
  });

  it("el gid se lee como el `shopify_order_id` de la fila", () => {
    expect(shopifyOrderIdFromGid("gid://shopify/Order/6100000000001")).toBe("6100000000001");
    expect(shopifyOrderIdFromGid(" 6100000000001 ")).toBe("6100000000001");
    expect(shopifyOrderIdFromGid("wc-aur-1210")).toBeNull();
    expect(shopifyOrderIdFromGid("gid://shopify/Product/1")).toBeNull();
  });
});

describe("la referencia para la base", () => {
  it("sin «#» ni nada que haga de comodín o rompa el filtro", () => {
    expect(localOrderReference("#KP200001")).toBe("KP200001");
    expect(localOrderReference(" kp200001 ")).toBe("kp200001");
    expect(localOrderReference("#KP%2,00(0)01_")).toBe("KP200001");
  });

  it("una referencia de menos de dos caracteres no se busca", async () => {
    const { admin, queries } = fakeAdmin({ orders: [WOO_AUR] });
    expect(await searchLocalOrderCandidates(admin, "aurela", "#%")).toEqual([]);
    expect(queries).toEqual([]);
  });
});

describe("MOM §38.12 y el código", () => {
  const MOM = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
  const code = readFileSync(resolve(process.cwd(), "lib/shipment-auto-match.ts"), "utf8");

  it("la decisión del owner está escrita, con su consecuencia", () => {
    for (const text of [
      "#### Envíos: el auto-vínculo y la búsqueda con pedidos de WooCommerce (25-10-2026)",
      "**Auto-vínculo y búsqueda de Envíos** con pedidos de WooCommerce: **hecho (25-10-2026)**",
      "**Decisión del owner (25-10-2026): el auto-vínculo busca siempre en la base de Kapta**",
      "**Lo que cuesta: un pedido que la sincronización todavía no trajo no se encuentra.**",
      "`test/shipment-auto-match-local.test.ts`",
    ]) {
      expect(MOM.includes(text), text).toBe(true);
    }
    // La regla vieja ya no está escrita como vigente.
    expect(MOM).not.toContain("**Decisión: los pedidos de Shopify se siguen buscando en Shopify");
  });

  it("el código cita la sección y no importa nada que hable con Shopify", () => {
    expect(code).toContain("MOM §38.12 «Envíos: el");
    for (const banned of [
      "searchOrdersLive",
      "fetchOrderById",
      "updateOrderShippingAddress",
      "getStoreCreds",
      "captureShopifyOrderForLink",
      "isShopifyShopGone",
      '"@/lib/ingest"',
      '"@/lib/shipment-order-capture"',
    ]) {
      expect(code.includes(banned), banned).toBe(false);
    }
  });
});
