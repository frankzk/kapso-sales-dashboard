// `shopifyGraphQL` con tope de tiempo (23-10-2026, salida de Kenku y Aurela de
// Shopify). Antes no tenía ninguno: un Shopify que acepta la conexión y no
// contesta dejaba «Generar pedido» en «Generando…». Aquí se fija que toda
// llamada lleva su tope, que quien trae su propia señal la conserva (la boleta,
// 15 s), que una llamada que sale bien sale igual, y los ayudantes que dicen si
// Shopify contestó que la tienda ya no está. Nunca se llama a Shopify.

import { describe, expect, it } from "vitest";
import {
  SHOPIFY_GRAPHQL_TIMEOUT_MS,
  SHOPIFY_SHOP_GONE_STATUSES,
  isShopifyShopGone,
  shopifyFailureDetail,
  shopifyGraphQL,
  shopifyHttpStatusOf,
  type ShopifyQueryCost,
} from "@/lib/shopify";

interface Seen {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (init: RequestInit) => Promise<Response> | Response) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    seen.push({ url: String(url), init: init as RequestInit });
    return respond(init as RequestInit);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function json(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

const base = { domain: "kenku.myshopify.com", token: "shpat_prueba_no_es_real", query: "{ shop { name } }" };

describe("shopifyGraphQL: el tope de tiempo", () => {
  it("toda llamada lleva una señal con tope, de 30 s por defecto", async () => {
    expect(SHOPIFY_GRAPHQL_TIMEOUT_MS).toBe(30_000);
    const { fetchImpl, seen } = fakeFetch(() => json({ data: { shop: { name: "Kenku" } } }));
    const data = await shopifyGraphQL({ ...base, fetchImpl });
    // Lo que sale bien, sale igual.
    expect(data).toEqual({ shop: { name: "Kenku" } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.init.signal!.aborted).toBe(false);
    // El resto del pedido no cambia.
    expect(seen[0]!.url).toBe("https://kenku.myshopify.com/admin/api/2025-01/graphql.json");
    expect(seen[0]!.init.method).toBe("POST");
    expect((seen[0]!.init.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe(base.token);
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ query: base.query, variables: {} });
  });

  it("un Shopify que no contesta corta con TimeoutError, sin colgarse", async () => {
    const { fetchImpl } = fakeFetch(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const started = Date.now();
    const err = await shopifyGraphQL({ ...base, fetchImpl, timeoutMs: 30 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("TimeoutError");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(shopifyFailureDetail(err)).toBe("Shopify no respondió a tiempo.");
  });

  it("la señal de quien llama gana: la boleta conserva sus 15 s", async () => {
    const own = new AbortController().signal;
    const { fetchImpl: inner, seen } = fakeFetch(() => json({ data: {} }));
    await shopifyGraphQL({ ...base, fetchImpl: (url, init) => inner(url, { ...init, signal: own }) });
    expect(seen[0]!.init.signal).toBe(own);
  });
});

describe("shopifyGraphQL: el cupo (`onCost`)", () => {
  const cost: ShopifyQueryCost = {
    requestedQueryCost: 752,
    actualQueryCost: 31,
    throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 969, restoreRate: 50 },
  };

  it("recibe `extensions.cost` de una respuesta buena", async () => {
    const { fetchImpl } = fakeFetch(() => json({ data: { ok: 1 }, extensions: { cost } }));
    const got: ShopifyQueryCost[] = [];
    await shopifyGraphQL({ ...base, fetchImpl, onCost: (c) => got.push(c) });
    expect(got).toEqual([cost]);
  });

  it("también cuando Shopify contesta THROTTLED, y el error sale igual", async () => {
    const throttled = { ...cost, actualQueryCost: null, throttleStatus: { ...cost.throttleStatus, currentlyAvailable: 12 } };
    const { fetchImpl } = fakeFetch(() =>
      json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: throttled } }),
    );
    const got: ShopifyQueryCost[] = [];
    const err = await shopifyGraphQL({ ...base, fetchImpl, onCost: (c) => got.push(c) }).catch((e: unknown) => e);
    expect(got).toEqual([throttled]);
    expect(shopifyFailureDetail(err)).toBe("Shopify devolvió un error (THROTTLED).");
  });

  it("si quien mide lanza, la llamada no se cae", async () => {
    const { fetchImpl } = fakeFetch(() => json({ data: { ok: 1 }, extensions: { cost } }));
    const data = await shopifyGraphQL({
      ...base,
      fetchImpl,
      onCost: () => {
        throw new Error("medidor roto");
      },
    });
    expect(data).toEqual({ ok: 1 });
  });
});

describe("¿Shopify dice que la tienda ya no está?", () => {
  it.each([401, 402, 403, 404, 423])("HTTP %i sí", async (status) => {
    const { fetchImpl } = fakeFetch(() => json({ errors: "Unavailable Shop" }, status));
    const err = await shopifyGraphQL({ ...base, fetchImpl }).catch((e: unknown) => e);
    expect(shopifyHttpStatusOf(err)).toBe(status);
    expect(isShopifyShopGone(err)).toBe(true);
    expect(shopifyFailureDetail(err)).toBe(`Shopify contestó HTTP ${status}.`);
  });

  it.each([429, 500, 502, 503])("HTTP %i no: es un mal momento y se reintenta", async (status) => {
    const { fetchImpl } = fakeFetch(() => json({ errors: "boom" }, status));
    const err = await shopifyGraphQL({ ...base, fetchImpl }).catch((e: unknown) => e);
    expect(isShopifyShopGone(err)).toBe(false);
  });

  it("ni un tiempo agotado, ni una red caída, ni un error de GraphQL", () => {
    expect(isShopifyShopGone(new DOMException("timeout", "TimeoutError"))).toBe(false);
    expect(isShopifyShopGone(new TypeError("fetch failed"))).toBe(false);
    expect(isShopifyShopGone(new Error('Shopify GraphQL errors: [{"extensions":{"code":"ACCESS_DENIED"}}]'))).toBe(false);
    expect(isShopifyShopGone(null)).toBe(false);
    expect([...SHOPIFY_SHOP_GONE_STATUSES].sort()).toEqual([401, 402, 403, 404, 423]);
  });

  it("el detalle nunca repite el cuerpo de la respuesta", () => {
    const err = new Error("Shopify GraphQL HTTP 402: {\"errors\":\"shpat_secreto\"}");
    expect(shopifyFailureDetail(err)).toBe("Shopify contestó HTTP 402.");
    expect(shopifyFailureDetail(new TypeError("fetch failed shpat_secreto"))).toBe("No se pudo conectar con Shopify.");
  });
});
