import { describe, expect, it } from "vitest";
import {
  citedProductIds,
  productGid,
  productIdFromGid,
  syncShopifyProductImages,
} from "@/lib/shopify-product-images";

/**
 * El espejo de la foto de catálogo.
 *
 * Shopify no manda imagen en el line item de un pedido —0 de 15.726 ítems
 * medidos el 14-09-2026—, así que el desglose de productos dibujaba el hueco de
 * una miniatura que nadie podía llenar.
 *
 * Se espeja en vez de pedirla en vivo porque el catálogo vendido es diminuto:
 * 331 productos distintos en 180 días sobre 21.789 ítems. Pedirla al abrir cada
 * cajón sería una llamada de red por apertura para releer valores casi siempre
 * iguales.
 */

/**
 * Un Supabase de mentira con las tres cadenas que usa el sincronizador.
 * `orders` devuelve pedidos; `shopify_product_images` devuelve lo ya espejado y
 * recoge los upserts.
 */
function fakeAdmin(opts: {
  orders?: { line_items: unknown }[];
  /** Ya espejados, con cuántos días tiene su `synced_at`. */
  espejados?: { id: string; diasDeAntiguedad: number }[];
  errorAlLeerEspejo?: boolean;
}) {
  const upserts: Record<string, unknown>[][] = [];
  const admin = {
    from(table: string) {
      if (table === "orders") {
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "eq", "gte"]) chain[m] = () => chain;
        chain.range = async (from: number) =>
          from === 0 ? { data: opts.orders ?? [], error: null } : { data: [], error: null };
        return chain;
      }
      // El simulacro HONRA el corte del TTL. Ignorarlo haría que la prueba de
      // `ttlDays: 0` pasara por el simulacro y no por la regla.
      let cutoff = "";
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) chain[m] = () => chain;
      chain.gte = (_col: string, value: string) => {
        cutoff = value;
        return chain;
      };
      chain.in = async () => {
        if (opts.errorAlLeerEspejo) return { data: null, error: { message: "boom" } };
        const frescos = (opts.espejados ?? []).filter((e) => {
          const syncedAt = new Date(Date.now() - e.diasDeAntiguedad * 86400_000).toISOString();
          return syncedAt >= cutoff;
        });
        return { data: frescos.map((e) => ({ product_id: e.id })), error: null };
      };
      chain.upsert = async (rows: Record<string, unknown>[]) => {
        upserts.push(rows);
        return { error: null };
      };
      return chain;
    },
  };
  return { admin, upserts };
}

/** Una respuesta de Shopify para `nodes(ids:)`. `null` = producto borrado. */
function fakeShopify(porGid: Record<string, unknown>) {
  return {
    domain: "t.myshopify.com",
    token: "TOK",
    fetchImpl: (async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const ids: string[] = body?.variables?.ids ?? [];
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { nodes: ids.map((id) => porGid[id] ?? null) } }),
        text: async () => "",
      };
    }) as unknown as typeof fetch,
  };
}

describe("los dos idiomas del id de producto", () => {
  it("el pedido lo guarda numérico; GraphQL lo quiere como gid", () => {
    expect(productGid("10020077175079")).toBe("gid://shopify/Product/10020077175079");
    expect(productIdFromGid("gid://shopify/Product/10020077175079")).toBe("10020077175079");
  });

  it("ida y vuelta", () => {
    expect(productIdFromGid(productGid("42"))).toBe("42");
  });
});

describe("qué productos se espejan", () => {
  it("los que los PEDIDOS citan, sin repetir", () => {
    // El catálogo entero puede tener miles que nunca se vendieron, y de esos no
    // hay pedido que mostrar.
    const { admin } = fakeAdmin({
      orders: [
        { line_items: [{ product_id: "1" }, { product_id: "2" }] },
        { line_items: [{ product_id: "2" }, { product_id: "3" }] },
      ],
    });
    return citedProductIds("s1", admin as never).then((ids) => {
      expect(ids.sort()).toEqual(["1", "2", "3"]);
    });
  });

  it("un `line_items` que no es una lista no rompe la pasada", async () => {
    const { admin } = fakeAdmin({
      orders: [{ line_items: null }, { line_items: "vaya" }, { line_items: [{ product_id: 7 }] }],
    });
    expect(await citedProductIds("s1", admin as never)).toEqual(["7"]);
  });

  it("si alguna vez llegara un gid, se normaliza al entrar", async () => {
    const { admin } = fakeAdmin({
      orders: [{ line_items: [{ product_id: "gid://shopify/Product/99" }, { product_id: "99" }] }],
    });
    expect(await citedProductIds("s1", admin as never)).toEqual(["99"]);
  });
});

describe("la sincronización", () => {
  it("guarda la foto de los productos citados", async () => {
    const { admin, upserts } = fakeAdmin({ orders: [{ line_items: [{ product_id: "1" }] }] });
    const shopify = fakeShopify({
      "gid://shopify/Product/1": {
        id: "gid://shopify/Product/1",
        title: "Pulsera Magnética",
        featuredImage: { url: "https://cdn.shopify.com/p1.jpg", altText: "Pulsera" },
      },
    });
    const r = await syncShopifyProductImages("s1", shopify, admin as never);
    expect(r.ok).toBe(true);
    expect(r.citados).toBe(1);
    expect(r.guardados).toBe(1);
    expect(upserts[0]?.[0]).toMatchObject({
      store_id: "s1",
      product_id: "1",
      image_url: "https://cdn.shopify.com/p1.jpg",
      image_alt: "Pulsera",
      catalog_title: "Pulsera Magnética",
    });
  });

  it("un producto SIN foto se guarda igual, en nulo", async () => {
    // «No tiene foto» y «todavía no lo miramos» son distintos: el segundo es la
    // fila ausente. Guardar el nulo evita volver a preguntar cada día.
    const { admin, upserts } = fakeAdmin({ orders: [{ line_items: [{ product_id: "1" }] }] });
    const shopify = fakeShopify({
      "gid://shopify/Product/1": { id: "gid://shopify/Product/1", title: "Sin foto", featuredImage: null },
    });
    await syncShopifyProductImages("s1", shopify, admin as never);
    expect(upserts[0]?.[0]).toMatchObject({ product_id: "1", image_url: null });
  });

  it("un producto borrado del catálogo se cuenta, no se inventa", async () => {
    const { admin, upserts } = fakeAdmin({ orders: [{ line_items: [{ product_id: "404" }] }] });
    const r = await syncShopifyProductImages("s1", fakeShopify({}), admin as never);
    expect(r.no_encontrados).toBe(1);
    expect(r.guardados).toBe(0);
    expect(upserts).toHaveLength(0);
  });

  it("lo espejado y fresco no se vuelve a preguntar", async () => {
    const { admin, upserts } = fakeAdmin({
      orders: [{ line_items: [{ product_id: "1" }, { product_id: "2" }] }],
      espejados: [{ id: "1", diasDeAntiguedad: 1 }],
    });
    const shopify = fakeShopify({
      "gid://shopify/Product/2": { id: "gid://shopify/Product/2", title: "Dos", featuredImage: null },
    });
    const r = await syncShopifyProductImages("s1", shopify, admin as never);
    expect(r.citados).toBe(2);
    expect(r.pedidos_a_shopify).toBe(1);
    expect(upserts[0]?.map((f) => f.product_id)).toEqual(["2"]);
  });

  it("con `ttlDays: 0` se refresca todo — es el primer llenado", async () => {
    const { admin } = fakeAdmin({
      orders: [{ line_items: [{ product_id: "1" }] }],
      espejados: [{ id: "1", diasDeAntiguedad: 1 }],
    });
    const shopify = fakeShopify({
      "gid://shopify/Product/1": { id: "gid://shopify/Product/1", title: "Uno", featuredImage: null },
    });
    // Con TTL 0 nada cuenta como fresco, así que igual se pregunta.
    const r = await syncShopifyProductImages("s1", shopify, admin as never, { ttlDays: 0 });
    expect(r.pedidos_a_shopify).toBe(1);
  });

  it("sin pedidos no llama a Shopify", async () => {
    const { admin, upserts } = fakeAdmin({ orders: [] });
    const r = await syncShopifyProductImages("s1", fakeShopify({}), admin as never);
    expect(r).toMatchObject({ ok: true, citados: 0, pedidos_a_shopify: 0 });
    expect(upserts).toHaveLength(0);
  });

  it("un lote que falla no cancela la pasada", async () => {
    const { admin } = fakeAdmin({ orders: [{ line_items: [{ product_id: "1" }] }] });
    const rompe = {
      domain: "t.myshopify.com",
      token: "TOK",
      fetchImpl: (async () => {
        throw new Error("red caída");
      }) as unknown as typeof fetch,
    };
    // La próxima pasada lo reintenta: sigue sin fila.
    const r = await syncShopifyProductImages("s1", rompe, admin as never);
    expect(r.ok).toBe(true);
    expect(r.guardados).toBe(0);
  });
});
