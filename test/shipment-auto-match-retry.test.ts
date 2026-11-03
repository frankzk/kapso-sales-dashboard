// El emparejamiento automático de la cola «Revisión» (lib/shipment-auto-match.ts)
// cuando la base de Kapta falla (23-10-2026; desde el 25-10-2026 la búsqueda
// es solo en `orders`, MOM §38.12, y nunca se le pregunta a Shopify).
//
// EL DEFECTO. Una búsqueda que fallaba se tomaba como «no hay pedido»: el envío
// quedaba revisado (`suggestion_checked_at`) y no se volvía a buscar nunca.
// Ahora se queda sin marcar y entra en la próxima pasada; y como el cliente
// (components/import-review.tsx) pide tandas hasta `done`, una tanda que no
// avanzó termina el bucle en vez de pedir lo mismo para siempre. Con la base
// bien, todo igual.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHONE, STORES, checked, fakeAdmin, links, savedSuggestions, type LocalOrder } from "./shipment-auto-match-fake";

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

import { runSuggestionBatch } from "@/lib/shipment-auto-match";

function order(over: Partial<LocalOrder> = {}): LocalOrder {
  return {
    id: "ord-1",
    store_id: "kenku",
    platform: "shopify",
    shopify_order_id: "6100000000001",
    name: "#KP140001",
    customer_phone: PHONE,
    ...over,
  };
}

beforeEach(() => {
  h.shopify.mockClear();
});

afterEach(() => {
  expect(h.shopify).not.toHaveBeenCalled();
});

describe("runSuggestionBatch: la base falló en la búsqueda", () => {
  it("el envío no queda revisado y la tanda termina si nada avanzó", async () => {
    const { admin, updates } = fakeAdmin({
      rows: [
        { id: "g1", order_name: "#KP140001", customer_phone: PHONE },
        { id: "g2", order_name: "#KP140002", customer_phone: "51930295804" },
      ],
      orders: [order()],
      ordersErrorStores: ["*"],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 2);

    expect(updates).toEqual([]);
    // Antes: { processed: 2, linked: 0, done: false } y los dos revisados para
    // siempre. Con `done: false` y nada marcado, el bucle del cliente pediría
    // la misma tanda sin fin.
    expect(r).toEqual({ processed: 0, linked: 0, done: true, retry: 2 });
  });

  it("los que sí se buscaron quedan revisados; el que falló, no", async () => {
    const { admin, updates } = fakeAdmin({
      rows: [
        { id: "g1", order_name: "#AUR140001", customer_phone: PHONE },
        { id: "g2", order_name: "#KP140002", customer_phone: "51930295804" },
      ],
      ordersErrorStores: ["aurela"],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 2);

    expect(checked(updates)).toEqual(["g2"]);
    // Avanzó: el cliente pide otra tanda.
    expect(r).toEqual({ processed: 1, linked: 0, done: false, retry: 1 });
  });

  it("si la base falló en una de dos tiendas, no se vincula con lo que dijo la otra", async () => {
    // Sin prefijo se busca en las dos tiendas. Aurela tiene un candidato con el
    // mismo celular, pero la búsqueda en Kenku falló: podía no ser único.
    const { admin, updates } = fakeAdmin({
      rows: [{ id: "g1", order_name: "178000", customer_phone: PHONE }],
      orders: [order({ id: "ord-aur", store_id: "aurela", platform: "woocommerce", name: "#AUR178000" })],
      ordersErrorStores: ["kenku"],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(updates).toEqual([]);
    expect(r).toEqual({ processed: 0, linked: 0, done: true, retry: 1 });
  });

  it("si no se pudo escribir el vínculo: ni sugerencia ni revisado, se vuelve a buscar", async () => {
    const { admin, updates } = fakeAdmin({
      rows: [{ id: "g1", order_name: "#KP140001", customer_phone: PHONE }],
      orders: [order()],
      linkUpdateError: true,
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 0, linked: 0, done: true, retry: 1 });
    expect(savedSuggestions(updates)).toEqual([]);
    // Solo el intento de vínculo, que falló; nada lo marca revisado.
    expect(updates.filter((u) => !("order_id" in u.values))).toEqual([]);
  });
});

describe("runSuggestionBatch: con la base bien, como siempre", () => {
  it("sin coincidencias, todos quedan revisados y no aparece `retry`", async () => {
    const { admin, updates } = fakeAdmin({
      rows: [
        { id: "g1", order_name: "#KP140001", customer_phone: PHONE },
        { id: "g2", order_name: "#KP140002", customer_phone: "51930295804" },
      ],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 2);

    expect(checked(updates).sort()).toEqual(["g1", "g2"]);
    expect(r).toEqual({ processed: 2, linked: 0, done: false });
  });

  it("un solo candidato con el mismo celular se vincula con su fila", async () => {
    const { admin, updates } = fakeAdmin({
      rows: [{ id: "g1", order_name: "#KP140001", customer_phone: PHONE }],
      orders: [order()],
    });

    const r = await runSuggestionBatch(admin, ["kenku", "aurela"], STORES, 25);

    expect(r).toEqual({ processed: 1, linked: 1, done: true });
    expect(links(updates)).toEqual([
      expect.objectContaining({
        table: "shipments",
        ids: ["g1"],
        values: expect.objectContaining({ order_id: "ord-1", matched: true, match_method: "auto" }),
      }),
    ]);
  });

  it("un envío sin referencia queda revisado sin buscar", async () => {
    const { admin, updates, queries } = fakeAdmin({
      rows: [{ id: "g9", order_name: null, customer_phone: PHONE }],
      orders: [order()],
    });
    const r = await runSuggestionBatch(admin, ["kenku"], STORES, 25);
    expect(queries).toEqual([]);
    expect(checked(updates)).toEqual(["g9"]);
    expect(r).toEqual({ processed: 1, linked: 0, done: true });
  });
});
