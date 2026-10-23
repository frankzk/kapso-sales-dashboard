import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// La sincronización completa con la API de Aliclik simulada: lo que importa es
// QUÉ columnas llegan al upsert de `aliclik_skus` cuando la pasada de agencia
// falla, porque solo las columnas enviadas se sobrescriben.

const api = vi.hoisted(() => ({
  agencyFails: false,
}));

vi.mock("@/lib/aliclik", () => ({
  listAllProducts: async (_opts: unknown, p: { isAgency?: boolean }) => {
    if (p.isAgency && api.agencyFails) {
      return { ok: false, error: "Aliclik respondió HTTP 502.", status: 502 };
    }
    return {
      ok: true,
      data: [
        {
          id: 1,
          name: "Fat-Burn Shorts",
          skus: [
            {
              sku: "FB-L",
              ean: "111",
              stockVirtual: 121,
              warehouseId: 7,
              warehouseName: "GRUPO GF",
              ...(p.isAgency ? { formatTimeAgency: "13:00" } : {}),
            },
          ],
        },
      ],
    };
  },
  listAgencies: async () => ({ ok: true, data: [] }),
  listPackageSizes: async () => ({ ok: true, data: [] }),
}));

import { loadShopifySkuDetails, syncAliclikCatalog } from "@/lib/aliclik-catalog";

/** Admin falso: guarda cada upsert y responde vacío a las lecturas. */
function fakeAdmin() {
  const upserts: { table: string; rows: Record<string, unknown>[] }[] = [];
  const read = {
    select: () => read,
    eq: () => read,
    gte: () => read,
    order: () => read,
    range: async () => ({ data: [], error: null }),
  };
  const admin = {
    from: (table: string) => ({
      ...read,
      upsert: async (rows: Record<string, unknown>[]) => {
        upserts.push({ table, rows });
        return { error: null, count: 0 };
      },
    }),
  };
  return { admin: admin as unknown as SupabaseClient, upserts };
}

describe("syncAliclikCatalog — pasada de agencia", () => {
  beforeEach(() => {
    api.agencyFails = false;
  });

  it("si la pasada de agencia falla, el upsert no toca la elegibilidad y avisa", async () => {
    api.agencyFails = true;
    const { admin, upserts } = fakeAdmin();

    const report = await syncAliclikCatalog("store-1", { apiToken: "t" }, admin);

    const skus = upserts.find((u) => u.table === "aliclik_skus");
    expect(skus?.rows).toHaveLength(1);
    expect(skus!.rows[0]).not.toHaveProperty("is_agency_eligible");
    expect(skus!.rows[0]).not.toHaveProperty("format_time_agency");
    expect(skus!.rows[0]).toMatchObject({ ean: "111", stock_virtual: 121, store_id: "store-1" });
    // El catálogo normal sí se guardó: el sync no se da por fallido...
    expect(report.ok).toBe(true);
    // ...pero el aviso dice qué pasó con la elegibilidad.
    expect(report.errors.join(" ")).toMatch(/agencia.*se conserva la elegibilidad/i);
  });

  it("con la pasada de agencia completa, la elegibilidad se escribe", async () => {
    const { admin, upserts } = fakeAdmin();

    const report = await syncAliclikCatalog("store-1", { apiToken: "t" }, admin);

    const skus = upserts.find((u) => u.table === "aliclik_skus");
    expect(skus!.rows[0]).toMatchObject({ ean: "111", is_agency_eligible: true, format_time_agency: "13:00" });
    expect(report.errors).toEqual([]);
  });
});

// ── Shopify caído o con la tienda dada de baja (23-10-2026) ──────────────────
//
// Kenku y Aurela salen de Shopify el 28-10-2026. Antes, un error del catálogo
// activo de Shopify subía sin atrapar: el sync se cortaba después de guardar los
// SKU de Aliclik y sin mapeo automático, agencias ni tamaños, y la pantalla de
// mapeo no cargaba. Ahora sigue con el historial de pedidos y lo avisa.

function shopifyRespondiendo(respond: () => { status: number; payload: unknown }) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    const { status, payload } = respond();
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as unknown as typeof fetch;
  return { opts: { domain: "kenku.myshopify.com", token: "t", fetchImpl }, calls: () => calls };
}

const UN_VARIANTE_ACTIVA = {
  data: {
    productVariants: {
      nodes: [
        {
          id: "gid://shopify/ProductVariant/11",
          title: "L",
          sku: "FB-L",
          inventoryQuantity: 4,
          product: { id: "gid://shopify/Product/1", title: "Fat-Burn Shorts", status: "ACTIVE" },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  },
};

describe("syncAliclikCatalog — el catálogo activo de Shopify", () => {
  beforeEach(() => {
    api.agencyFails = false;
  });

  it.each([402, 404, 500])("si Shopify contesta HTTP %i, el sync termina, siembra el mapeo y avisa", async (status) => {
    const { admin, upserts } = fakeAdmin();
    const shopify = shopifyRespondiendo(() => ({ status, payload: { errors: "Unavailable Shop" } }));

    const report = await syncAliclikCatalog("store-1", { apiToken: "t" }, admin, shopify.opts);

    expect(shopify.calls()).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.shopifySkus).toBe(0);
    expect(report.errors).toEqual([
      `Catálogo activo de Shopify: Shopify contestó HTTP ${status}. Se asoció con el historial de pedidos.`,
    ]);
    // Lo de después del catálogo de Shopify también corrió: el mapeo por SKU.
    expect(upserts.map((u) => u.table)).toEqual(expect.arrayContaining(["aliclik_skus", "aliclik_sku_map"]));
    // El aviso no repite el cuerpo de la respuesta.
    expect(report.errors.join(" ")).not.toContain("Unavailable Shop");
  });

  it("con Shopify bien, cuenta sus SKU activos y no avisa nada (como siempre)", async () => {
    const { admin } = fakeAdmin();
    const shopify = shopifyRespondiendo(() => ({ status: 200, payload: UN_VARIANTE_ACTIVA }));

    const report = await syncAliclikCatalog("store-1", { apiToken: "t" }, admin, shopify.opts);

    expect(report.ok).toBe(true);
    expect(report.shopifySkus).toBe(1);
    expect(report.errors).toEqual([]);
  });
});

describe("loadShopifySkuDetails — la pantalla de mapeo", () => {
  /** Admin con un pedido guardado que vendió el SKU FB-M. */
  function adminConPedidos() {
    const rows = [
      {
        created_at: "2026-10-20T15:00:00Z",
        line_items: [{ sku: "FB-M", title: "Fat-Burn Shorts", variant_title: "M" }],
        raw_line_items: null,
        raw_graphql_line_items: null,
      },
    ];
    const q = {
      select: () => q,
      eq: () => q,
      gte: () => q,
      order: () => q,
      range: async (from: number) => ({ data: from === 0 ? rows : [], error: null }),
    };
    return { from: () => q } as unknown as SupabaseClient;
  }

  it("si Shopify falla, carga igual con el historial de pedidos y dice por qué", async () => {
    const shopify = shopifyRespondiendo(() => ({ status: 402, payload: {} }));
    const avisos: string[] = [];

    const details = await loadShopifySkuDetails("store-1", adminConPedidos(), 365, shopify.opts, {
      onShopifyError: (d) => avisos.push(d),
    });

    expect([...details.keys()]).toEqual(["FB-M"]);
    expect(avisos).toEqual(["Shopify contestó HTTP 402."]);
  });

  it("sin quien escuche el aviso, tampoco lanza", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const details = await loadShopifySkuDetails("store-1", adminConPedidos(), 365, {
      domain: "kenku.myshopify.com",
      token: "t",
      fetchImpl,
    });
    expect([...details.keys()]).toEqual(["FB-M"]);
  });

  it("con Shopify bien, el catálogo activo va primero, como siempre", async () => {
    const shopify = shopifyRespondiendo(() => ({ status: 200, payload: UN_VARIANTE_ACTIVA }));
    const avisos: string[] = [];
    const details = await loadShopifySkuDetails("store-1", adminConPedidos(), 365, shopify.opts, {
      onShopifyError: (d) => avisos.push(d),
    });
    expect([...details.keys()].sort()).toEqual(["FB-L", "FB-M"]);
    expect(details.get("FB-L")).toMatchObject({ variantId: "gid://shopify/ProductVariant/11" });
    expect(avisos).toEqual([]);
  });
});
