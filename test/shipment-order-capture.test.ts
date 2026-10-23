// Envíos sin Shopify (23-10-2026, salida de Kenku y Aurela de Shopify el
// 28-10-2026): vincular una guía con un pedido de Shopify, armar una guía
// directa desde él y corregir la dirección de un envío contestaban «La tienda
// no tiene Shopify conectado» aunque el pedido ya estuviera en Kapta. Ahora usan
// la fila de Kapta cuando Shopify no está o no contesta
// (lib/shipment-order-capture.ts). Con Shopify bien, todo igual. Nunca se
// llama a Shopify: la red y la base son falsas.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrderRow } from "@/lib/types";

// lib/ingest arrastra el módulo de ingesta entero; aquí las dependencias se inyectan.
vi.mock("@/lib/ingest", () => ({ getStoreCreds: async () => null }));

import {
  captureShopifyOrderForLink,
  orderPlatformOf,
  pushShippingAddressToShopify,
  type ShipmentShopifyDeps,
} from "@/lib/shipment-order-capture";

const GID = "gid://shopify/Order/6100000000001";

interface Read {
  table: string;
  filters: [string, unknown][];
}

/** Admin falso: `orders` tiene (o no) la fila local; registra lecturas y upserts. */
function fakeAdmin(opts: { localId?: string | null; upsertError?: unknown; afterUpsertId?: string | null } = {}) {
  const reads: Read[] = [];
  const upserts: unknown[] = [];
  let upserted = false;
  const from = (table: string) => {
    const read: Read = { table, filters: [] };
    const q = {
      select: () => {
        reads.push(read);
        return q;
      },
      eq: (col: string, val: unknown) => {
        read.filters.push([col, val]);
        return q;
      },
      upsert: async (rows: unknown[]) => {
        upserts.push(...rows);
        upserted = true;
        return { error: opts.upsertError ?? null };
      },
      maybeSingle: async () => {
        const id = upserted ? (opts.afterUpsertId === undefined ? "ord-shopify" : opts.afterUpsertId) : opts.localId;
        return { data: id ? { id } : null, error: null };
      },
    };
    return q;
  };
  return { admin: { from } as unknown as SupabaseClient, reads, upserts };
}

function deps(over: Partial<ShipmentShopifyDeps> = {}): ShipmentShopifyDeps {
  return {
    getCreds: async () => ({ shopify_domain: "kenku.myshopify.com", shopify_token: "t" }),
    fetchOrder: vi.fn(async () => ({ store_id: "kenku", shopify_order_id: "6100000000001", name: "#KP140001" }) as OrderRow),
    updateAddress: vi.fn(async () => {}),
    ...over,
  };
}

const sinToken = (): Partial<ShipmentShopifyDeps> => ({
  getCreds: async () => ({ shopify_domain: "kenku.myshopify.com", shopify_token: null }),
});

describe("captureShopifyOrderForLink", () => {
  it("con Shopify bien: lee, guarda lo que dijo Shopify y devuelve su fila (como siempre)", async () => {
    const { admin, upserts, reads } = fakeAdmin({ localId: "ord-local" });
    const d = deps();
    const r = await captureShopifyOrderForLink(admin, { storeId: "kenku", orderGid: GID }, d);
    expect(r).toEqual({ ok: true, orderId: "ord-shopify", from: "shopify" });
    expect(d.fetchOrder).toHaveBeenCalledWith({
      domain: "kenku.myshopify.com",
      token: "t",
      storeId: "kenku",
      orderGid: GID,
    });
    expect(upserts).toHaveLength(1);
    expect(reads).toEqual([
      { table: "orders", filters: [["store_id", "kenku"], ["shopify_order_id", "6100000000001"]] },
    ]);
  });

  it("sin token: la fila de Kapta, sin llamar a Shopify", async () => {
    const { admin, upserts, reads } = fakeAdmin({ localId: "ord-local" });
    const d = deps(sinToken());
    const r = await captureShopifyOrderForLink(admin, { storeId: "kenku", orderGid: GID }, d);
    expect(r).toEqual({ ok: true, orderId: "ord-local", from: "kapta" });
    expect(d.fetchOrder).not.toHaveBeenCalled();
    expect(upserts).toEqual([]);
    // Por la tienda y el número de Shopify: nunca un pedido de otra tienda.
    expect(reads).toEqual([
      { table: "orders", filters: [["store_id", "kenku"], ["shopify_order_id", "6100000000001"]] },
    ]);
  });

  it("sin token y sin la fila: el error de antes, que ahora dice también que no está en Kapta", async () => {
    const { admin } = fakeAdmin({ localId: null });
    const r = await captureShopifyOrderForLink(admin, { storeId: "kenku", orderGid: GID }, deps(sinToken()));
    expect(r).toEqual({ ok: false, why: "sin_shopify" });
  });

  it.each([
    ["la tienda dada de baja (HTTP 402)", new Error("Shopify GraphQL HTTP 402: Unavailable Shop")],
    ["un tiempo agotado", new DOMException("timeout", "TimeoutError")],
    ["la red caída", new TypeError("fetch failed")],
  ])("si Shopify falla por %s, la fila de Kapta", async (_label, error) => {
    const { admin, upserts } = fakeAdmin({ localId: "ord-local" });
    const r = await captureShopifyOrderForLink(
      admin,
      { storeId: "kenku", orderGid: GID },
      deps({ fetchOrder: vi.fn(async () => Promise.reject(error)) }),
    );
    expect(r).toEqual({ ok: true, orderId: "ord-local", from: "kapta" });
    expect(upserts).toEqual([]);
  });

  it("si Shopify falla y no hay fila: «No se pudo obtener el pedido de Shopify», como antes", async () => {
    const { admin } = fakeAdmin({ localId: null });
    const r = await captureShopifyOrderForLink(
      admin,
      { storeId: "kenku", orderGid: GID },
      deps({ fetchOrder: vi.fn(async () => Promise.reject(new Error("boom"))) }),
    );
    expect(r).toEqual({ ok: false, why: "shopify_fallo" });
  });

  it("si Shopify no lo devuelve: la fila de Kapta, o «no encontrado»", async () => {
    const noLoDevuelve = deps({ fetchOrder: vi.fn(async () => null) });
    expect(
      await captureShopifyOrderForLink(fakeAdmin({ localId: "ord-local" }).admin, { storeId: "kenku", orderGid: GID }, noLoDevuelve),
    ).toEqual({ ok: true, orderId: "ord-local", from: "kapta" });
    expect(
      await captureShopifyOrderForLink(fakeAdmin({ localId: null }).admin, { storeId: "kenku", orderGid: GID }, noLoDevuelve),
    ).toEqual({ ok: false, why: "no_encontrado" });
  });

  it("un id que no es de un pedido de Shopify no busca fila", async () => {
    const { admin, reads } = fakeAdmin({ localId: "ord-local" });
    const r = await captureShopifyOrderForLink(admin, { storeId: "kenku", orderGid: "wc-kp-1532" }, deps(sinToken()));
    expect(r).toEqual({ ok: false, why: "sin_shopify" });
    expect(reads).toEqual([]);
  });

  it("los errores de la base al guardar siguen siendo de la base", async () => {
    const error = { code: "23505", message: "duplicate key" };
    const r = await captureShopifyOrderForLink(fakeAdmin({ upsertError: error }).admin, { storeId: "kenku", orderGid: GID }, deps());
    expect(r).toEqual({ ok: false, why: "base", error });
    const sinFila = await captureShopifyOrderForLink(
      fakeAdmin({ afterUpsertId: null }).admin,
      { storeId: "kenku", orderGid: GID },
      deps(),
    );
    expect(sinFila).toEqual({ ok: false, why: "sin_fila" });
  });
});

describe("pushShippingAddressToShopify", () => {
  const input = {
    storeId: "kenku",
    shopifyOrderId: "6100000000001",
    address: { address1: "Av. Siempre Viva 123", city: "Miraflores", province: "Lima", country: "Peru" },
  };

  it("con Shopify bien: la escribe, como siempre", async () => {
    const d = deps();
    expect(await pushShippingAddressToShopify(input, d)).toEqual({ ok: true, wrote: true });
    expect(d.updateAddress).toHaveBeenCalledWith({
      domain: "kenku.myshopify.com",
      token: "t",
      orderGid: GID,
      address: input.address,
    });
  });

  it("sin token: sigue solo en Kapta, sin llamar a Shopify", async () => {
    const d = deps(sinToken());
    expect(await pushShippingAddressToShopify(input, d)).toEqual({ ok: true, wrote: false, why: "sin_shopify" });
    expect(d.updateAddress).not.toHaveBeenCalled();
  });

  it.each([401, 402, 403, 404, 423])("Shopify contesta HTTP %i por la tienda: sigue solo en Kapta", async (status) => {
    const d = deps({ updateAddress: vi.fn(async () => Promise.reject(new Error(`Shopify GraphQL HTTP ${status}: x`))) });
    expect(await pushShippingAddressToShopify(input, d)).toEqual({ ok: true, wrote: false, why: "tienda_caida", status });
  });

  // Integración con WooCommerce (MOM §37.12): la plataforma la dice el pedido.
  it("un pedido de WooCommerce no va a Shopify, ni con token: sigue solo en Kapta", async () => {
    const getCreds = vi.fn(async () => ({ shopify_domain: "kenku.myshopify.com", shopify_token: "t" }));
    const d = deps({ getCreds });
    expect(
      await pushShippingAddressToShopify({ ...input, shopifyOrderId: "wc-kp-1532", platform: "woocommerce" }, d),
    ).toEqual({ ok: true, wrote: false, why: "woocommerce" });
    expect(getCreds).not.toHaveBeenCalled();
    expect(d.updateAddress).not.toHaveBeenCalled();
  });

  it("con `platform: shopify` (o sin ella), lo de siempre", async () => {
    const d = deps();
    expect(await pushShippingAddressToShopify({ ...input, platform: "shopify" }, d)).toEqual({ ok: true, wrote: true });
    expect(d.updateAddress).toHaveBeenCalledTimes(1);
  });

  it("un rechazo de Shopify sigue cortando el cambio, con los mismos textos", async () => {
    const sinPermiso = deps({
      updateAddress: vi.fn(async () =>
        Promise.reject(new Error('Shopify GraphQL errors: [{"message":"Access denied for orderUpdate field."}]')),
      ),
    });
    expect(await pushShippingAddressToShopify(input, sinPermiso)).toEqual({
      ok: false,
      error: "Shopify no autorizó el cambio. La tienda necesita el permiso write_orders.",
    });
    const invalida = deps({ updateAddress: vi.fn(async () => Promise.reject(new Error("Dirección inválida."))) });
    expect(await pushShippingAddressToShopify(input, invalida)).toEqual({
      ok: false,
      error: "Shopify rechazó la dirección: Dirección inválida.",
    });
    const caido = deps({ updateAddress: vi.fn(async () => Promise.reject(new Error("Shopify GraphQL HTTP 503: x"))) });
    expect(await pushShippingAddressToShopify(input, caido)).toMatchObject({ ok: false });
  });
});

describe("orderPlatformOf (orders.platform, 0273)", () => {
  function platformAdmin(result: { data: unknown; error: unknown }) {
    const filters: [string, unknown][] = [];
    let selected = "";
    const q = {
      select: (cols: string) => {
        selected = cols;
        return q;
      },
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return q;
      },
      maybeSingle: async () => result,
    };
    return { admin: { from: () => q } as unknown as SupabaseClient, filters, selected: () => selected };
  }

  it("lee la columna del pedido por su id", async () => {
    const f = platformAdmin({ data: { platform: "woocommerce" }, error: null });
    expect(await orderPlatformOf(f.admin, "ord-1")).toBe("woocommerce");
    expect(f.selected()).toBe("platform");
    expect(f.filters).toEqual([["id", "ord-1"]]);
  });

  it("shopify, o sin la 0273 (la columna no existe), o sin fila: shopify, lo de siempre", async () => {
    expect(await orderPlatformOf(platformAdmin({ data: { platform: "shopify" }, error: null }).admin, "x")).toBe("shopify");
    expect(
      await orderPlatformOf(
        platformAdmin({ data: null, error: { code: "42703", message: "column orders.platform does not exist" } }).admin,
        "x",
      ),
    ).toBe("shopify");
    expect(await orderPlatformOf(platformAdmin({ data: null, error: null }).admin, "x")).toBe("shopify");
  });
});

describe("las tres acciones de Envíos usan el respaldo", () => {
  const src = readFileSync(resolve(process.cwd(), "app/dashboard/envios/actions.ts"), "utf8");
  const body = (name: string) => {
    const start = src.indexOf(`export async function ${name}`);
    const next = src.indexOf("\nexport async function ", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  };

  it("ya no cortan con «La tienda no tiene Shopify conectado.» antes de mirar Kapta", () => {
    expect(src).not.toContain('return { error: "La tienda no tiene Shopify conectado." }');
  });

  it("vincular y la guía directa capturan con `captureShopifyOrderForLink`", () => {
    for (const name of ["linkShipmentToShopifyOrder", "previewDirectFenixGuide"]) {
      const b = body(name);
      expect(b, name).toContain("captureShopifyOrderForLink(");
      expect(b, name).not.toContain("fetchOrderById(");
    }
  });

  it("la dirección pasa por `pushShippingAddressToShopify` y el aviso dice si Shopify no cambió", () => {
    const b = body("updateShipmentDeliveryAddress");
    expect(b).toContain("pushShippingAddressToShopify(");
    expect(b).not.toContain("updateOrderShippingAddress(");
    expect(b).toContain("addressUpdateNotice(isRealShopifyOrder, shopifyPush)");
    const notice = src.slice(src.indexOf("function addressUpdateNotice"), src.indexOf("function addressUpdateNotice") + 1500);
    expect(notice).toContain("el pedido de Shopify no cambió");
    expect(notice).toContain("El pedido es de WooCommerce: allí no se cambió.");
    // La plataforma la dice el pedido (MOM §37.12), nunca la forma de su id.
    expect(b).toContain("platform: current.order_id ? await orderPlatformOf(admin, current.order_id)");
    // El rechazo de Shopify sigue cortando antes de tocar el envío.
    expect(b.indexOf("if (!shopifyPush.ok) return { error: shopifyPush.error };")).toBeLessThan(
      b.indexOf('.from("shipments").update(update)'),
    );
  });
});
