// Envíos → «Catálogo de productos» en una tienda que ya crea en WooCommerce
// (MOM §38.12, «Envíos → Catálogo de productos en WooCommerce»): la lista y la
// siembra del mapeo de Aliclik salen del catálogo publicado de WooCommerce,
// paginado y acotado, con el historial de pedidos de respaldo; con Shopify nada
// cambia. Sin red: WooCommerce y Shopify son falsos y la base, un objeto.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

vi.mock("@/lib/aliclik", () => ({
  listAllProducts: async () => ({
    ok: true,
    data: [
      {
        id: 1,
        name: "Fat-Burn Shorts",
        skus: [{ sku: "SXOW1", ean: "111", stockVirtual: 10, warehouseId: 7, warehouseName: "GRUPO GF" }],
      },
    ],
  }),
  listAgencies: async () => ({ ok: true, data: [] }),
  listPackageSizes: async () => ({ ok: true, data: [] }),
}));

import { encrypt } from "@/lib/crypto";
import { WooError } from "@/lib/woocommerce";
import {
  WOO_CATALOG_CONCURRENCY,
  WOO_CATALOG_PER_PAGE,
  listWooCatalogVariants,
} from "@/lib/woocommerce-orders";
import {
  clearWooCatalogCache,
  loadShopifySkuDetails,
  loadShopifySkuNames,
  loadSkuCatalogSource,
  skuSourceErrorText,
  syncAliclikCatalog,
  type SkuCatalogSource,
} from "@/lib/aliclik-catalog";
import {
  catalogSkusPhrase,
  catalogSourceIn,
  catalogSourceNotice,
  catalogSourceTag,
} from "@/lib/catalog-source";

const SITE = "https://aurela.pe";
const CK = "ck_test_1234567890";
const CS = "cs_test_abcdefghij";
const STORE = "22222222-2222-4222-8222-222222222222";

// ── WooCommerce falso, con páginas ──────────────────────────────────────────

interface P {
  id: number;
  name: string;
  type: "simple" | "variable" | "grouped" | "external";
  sku: string;
  status?: string;
  stock?: number | null;
}
interface V {
  id: number;
  parent: number;
  sku: string;
  options: string[];
  status?: string;
}

type Call = { method: string; path: string; query: URLSearchParams; auth: string | null };

function fakeWoo(opts: {
  products: P[];
  variations?: V[];
  fail?: (path: string, page: number) => { status: number; body: unknown } | null;
  stripAuthHeader?: boolean;
  onCall?: () => void;
}) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    opts.onCall?.();
    const url = new URL(String(input));
    const path = url.pathname.replace("/wp-json/wc/v3", "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? "GET", path, query: url.searchParams, auth: headers.Authorization ?? null });
    if (opts.stripAuthHeader && !url.searchParams.get("consumer_key")) {
      return json({ code: "woocommerce_rest_cannot_view", message: "Lo siento, no puedes listar los recursos." }, 401);
    }
    const page = Number(url.searchParams.get("page") ?? "1");
    const per = Number(url.searchParams.get("per_page") ?? "10");
    const failure = opts.fail?.(path, page);
    if (failure) return json(failure.body, failure.status);
    const paged = <T,>(list: T[]) => {
      const totalPages = Math.max(1, Math.ceil(list.length / per));
      return json(list.slice((page - 1) * per, page * per), 200, {
        "x-wp-total": String(list.length),
        "x-wp-totalpages": String(totalPages),
      });
    };
    if (path === "/products") {
      const status = url.searchParams.get("status");
      return paged(
        opts.products
          .filter((p) => !status || (p.status ?? "publish") === status)
          .sort((a, b) => a.id - b.id)
          .map((p) => ({ id: p.id, name: p.name, type: p.type, status: p.status ?? "publish", sku: p.sku, stock_quantity: p.stock ?? null })),
      );
    }
    const m = path.match(/^\/products\/(\d+)\/variations$/);
    if (m) {
      const parent = opts.products.find((p) => p.id === Number(m[1]));
      return paged(
        (opts.variations ?? [])
          .filter((v) => v.parent === Number(m[1]))
          .map((v) => ({
            id: v.id,
            // WooCommerce muestra el SKU del padre en una variación sin SKU propio.
            sku: v.sku || parent?.sku || "",
            status: v.status ?? "publish",
            stock_quantity: null,
            attributes: v.options.map((o) => ({ name: "Talla", option: o })),
          })),
      );
    }
    return json({ code: "rest_no_route" }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const client = (fetchImpl: typeof fetch) => ({ siteUrl: SITE, consumerKey: CK, consumerSecret: CS, fetchImpl });

const CATALOGO: P[] = [
  { id: 10, name: "Fat-Burn Shorts", type: "simple", sku: "818531465", stock: 4 },
  { id: 11, name: "Polo &amp; Short", type: "variable", sku: "POLO" },
  { id: 12, name: "Astaxantina", type: "simple", sku: "" },
  { id: 13, name: "Pack regalo", type: "grouped", sku: "PACK" },
  { id: 14, name: "Borrador", type: "simple", sku: "DRAFT-1", status: "draft" },
];
const VARIACIONES: V[] = [
  { id: 111, parent: 11, sku: "POLO-M", options: ["M", "Negro"] },
  { id: 112, parent: 11, sku: "", options: ["L", "Negro"] },
  { id: 113, parent: 11, sku: "POLO-XL", options: ["XL"], status: "private" },
];

// ── listWooCatalogVariants ──────────────────────────────────────────────────

describe("listWooCatalogVariants: todo el catálogo publicado, solo leyendo", () => {
  it("un simple es una fila; un variable, una por variación publicada; sin SKU propio va sin SKU", async () => {
    const shop = fakeWoo({ products: CATALOGO, variations: VARIACIONES });
    const r = await listWooCatalogVariants(client(shop.fetchImpl));

    expect(r.complete).toBe(true);
    expect(r.incompleteReason).toBeNull();
    expect(r.variants).toEqual([
      { productId: "woo:10", productTitle: "Fat-Burn Shorts", variantId: "woo:10", variantTitle: null, sku: "818531465", inventory: 4 },
      { productId: "woo:11", productTitle: "Polo & Short", variantId: "woo:111", variantTitle: "M / Negro", sku: "POLO-M", inventory: null },
      { productId: "woo:11", productTitle: "Polo & Short", variantId: "woo:112", variantTitle: "L / Negro", sku: null, inventory: null },
      { productId: "woo:12", productTitle: "Astaxantina", variantId: "woo:12", variantTitle: null, sku: null, inventory: null },
    ]);
    // Solo lectura, solo lo publicado, 100 por página y en orden estable.
    expect(shop.calls.every((c) => c.method === "GET")).toBe(true);
    const list = shop.calls.find((c) => c.path === "/products")!;
    expect(list.query.get("status")).toBe("publish");
    expect(list.query.get("per_page")).toBe(String(WOO_CATALOG_PER_PAGE));
    expect(list.query.get("orderby")).toBe("id");
    expect(shop.calls.find((c) => c.path === "/products/11/variations")!.query.get("status")).toBe("publish");
    // Las claves van en la cabecera, nunca en la URL (con Basic).
    expect(list.auth).toMatch(/^Basic /);
    expect(list.query.get("consumer_key")).toBeNull();
  });

  it("pagina los productos con X-WP-TotalPages (Aurela: ~1.000 variantes)", async () => {
    const products: P[] = Array.from({ length: 250 }, (_, i) => ({
      id: 1000 + i,
      name: `Producto ${i}`,
      type: "simple",
      sku: `SKU-${i}`,
    }));
    const shop = fakeWoo({ products });
    const r = await listWooCatalogVariants(client(shop.fetchImpl));
    expect(r.complete).toBe(true);
    expect(r.variants).toHaveLength(250);
    expect(shop.calls.filter((c) => c.path === "/products").map((c) => c.query.get("page"))).toEqual(["1", "2", "3"]);
  });

  it("pide las variaciones de a WOO_CATALOG_CONCURRENCY, no todas a la vez", async () => {
    const products: P[] = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, name: `V${i}`, type: "variable", sku: "" }));
    const variations: V[] = products.map((p, i) => ({ id: 5000 + i, parent: p.id, sku: `V-${i}`, options: ["U"] }));
    let inFlight = 0;
    let peak = 0;
    const shop = fakeWoo({ products, variations });
    const slow = (async (input: string | URL, init?: RequestInit) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      try {
        return await shop.fetchImpl(input, init);
      } finally {
        inFlight--;
      }
    }) as unknown as typeof fetch;
    const r = await listWooCatalogVariants(client(slow));
    expect(r.variants).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(WOO_CATALOG_CONCURRENCY);
  });

  it("el tope de páginas deja la lectura «en parte» y dice por qué", async () => {
    const products: P[] = Array.from({ length: 150 }, (_, i) => ({ id: 1 + i, name: `P${i}`, type: "simple", sku: `S${i}` }));
    const shop = fakeWoo({ products });
    const r = await listWooCatalogVariants(client(shop.fetchImpl), { maxPages: 1 });
    expect(r.variants).toHaveLength(100);
    expect(r.complete).toBe(false);
    expect(r.incompleteReason).toBe("más de 100 productos");
  });

  it("el reloj corta: lo que no llegó queda fuera y la lectura queda «en parte»", async () => {
    const products: P[] = Array.from({ length: 12 }, (_, i) => ({ id: 1 + i, name: `V${i}`, type: "variable", sku: "" }));
    const variations: V[] = products.map((p, i) => ({ id: 900 + i, parent: p.id, sku: `X${i}`, options: ["U"] }));
    let t = 0;
    const shop = fakeWoo({ products, variations, onCall: () => (t += 3_000) });
    const r = await listWooCatalogVariants(client(shop.fetchImpl), { now: () => t, budgetMs: 10_000 });
    expect(r.complete).toBe(false);
    expect(r.incompleteReason).toContain("se acabó el tiempo");
    expect(r.variants.length).toBeLessThan(12);
    // No sigue llamando después del reloj (más lo que ya estaba en vuelo).
    expect(shop.calls.length).toBeLessThanOrEqual(1 + WOO_CATALOG_CONCURRENCY);
  });

  it("si falla la primera página lanza un WooError (sin secretos); si fallan unas variaciones, sigue «en parte»", async () => {
    const down = fakeWoo({ products: CATALOGO, fail: () => ({ status: 500, body: { code: "x", message: CK } }) });
    const err = await listWooCatalogVariants(client(down.fetchImpl)).catch((e) => e);
    expect(err).toBeInstanceOf(WooError);
    expect(String(err.message)).not.toContain(CK);

    const half = fakeWoo({
      products: CATALOGO,
      variations: VARIACIONES,
      fail: (path) => (path === "/products/11/variations" ? { status: 500, body: {} } : null),
    });
    const r = await listWooCatalogVariants(client(half.fetchImpl));
    expect(r.complete).toBe(false);
    expect(r.incompleteReason).toBe("no se pudieron leer las variaciones de 1 producto(s)");
    expect(r.variants.map((v) => v.variantId)).toEqual(["woo:10", "woo:12"]);
  });

  it("un hosting que borra la cabecera Authorization: reintenta con la query string y sigue así", async () => {
    const shop = fakeWoo({ products: CATALOGO, variations: VARIACIONES, stripAuthHeader: true });
    const r = await listWooCatalogVariants(client(shop.fetchImpl));
    expect(r.complete).toBe(true);
    expect(r.variants).toHaveLength(4);
    // Una sola llamada con Basic (la que falló); las demás, por query string.
    expect(shop.calls.filter((c) => !c.query.get("consumer_key"))).toHaveLength(1);
  });
});

// ── La base falsa: la tienda, los pedidos y los upserts ─────────────────────

function fakeAdmin(opts: { store?: Record<string, unknown> | null; storeError?: string; orders?: unknown[] } = {}) {
  const upserts: { table: string; rows: Record<string, unknown>[] }[] = [];
  const admin = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const self = () => q;
      Object.assign(q, {
        select: self,
        eq: self,
        gte: self,
        order: self,
        maybeSingle: async () =>
          table === "stores"
            ? opts.storeError
              ? { data: null, error: { message: opts.storeError } }
              : { data: opts.store ?? null, error: null }
            : { data: null, error: null },
        range: async (from: number) => ({
          data: table === "orders" && from === 0 ? (opts.orders ?? []) : [],
          error: null,
        }),
        upsert: async (rows: Record<string, unknown>[]) => {
          upserts.push({ table, rows });
          return { error: null, count: rows.length };
        },
      });
      return q;
    },
  };
  return { admin: admin as unknown as SupabaseClient, upserts };
}

const storeRow = (over: Record<string, unknown> = {}) => ({
  id: STORE,
  status: "active",
  timezone: "America/Lima",
  platform: "woocommerce",
  woo_site_url: SITE,
  woo_site_key: "aur",
  woo_consumer_key_enc: encrypt(CK),
  woo_consumer_secret_enc: encrypt(CS),
  woo_webhook_secret_enc: null,
  woo_last_error: null,
  ...over,
});

/** Un pedido guardado (de cualquiera de las dos plataformas) que vendió FB-M. */
const PEDIDO = {
  created_at: "2026-10-20T15:00:00Z",
  line_items: [{ sku: "FB-M", title: "Fat-Burn Shorts", variant_title: "M" }],
  raw_line_items: null,
  raw_graphql_line_items: null,
};

/** Shopify falso que cuenta llamadas: con WooCommerce no debe llamarse nunca. */
function shopifyContado() {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify({ data: { productVariants: { nodes: [], pageInfo: { hasNextPage: false } } } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { creds: { shopify_domain: "aurela.myshopify.com", shopify_token: "shpat_x" }, fetchImpl, calls: () => calls };
}

// ── loadSkuCatalogSource: stores.platform decide ────────────────────────────

describe("loadSkuCatalogSource: de dónde sale la lista (stores.platform, MOM §38.1)", () => {
  it("woocommerce con las claves: WooCommerce, aunque la tienda conserve su token de Shopify", async () => {
    const { admin } = fakeAdmin({ store: storeRow() });
    const s = await loadSkuCatalogSource(admin, STORE, shopifyContado().creds);
    expect(s).toMatchObject({ platform: "woocommerce", woo: { siteUrl: SITE, consumerKey: CK, consumerSecret: CS } });
  });

  it("shopify: Shopify con su token, exactamente como antes", async () => {
    const { admin } = fakeAdmin({ store: storeRow({ platform: "shopify" }) });
    expect(await loadSkuCatalogSource(admin, STORE, shopifyContado().creds)).toEqual({
      platform: "shopify",
      shopify: { domain: "aurela.myshopify.com", token: "shpat_x" },
    });
    expect(await loadSkuCatalogSource(admin, STORE, null)).toEqual({ platform: "shopify", shopify: undefined });
  });

  it("sin la 0274 (la columna no existe): Shopify, como siempre", async () => {
    const { admin } = fakeAdmin({ storeError: 'column stores.platform does not exist' });
    expect(await loadSkuCatalogSource(admin, STORE, shopifyContado().creds)).toMatchObject({ platform: "shopify" });
  });

  it("woocommerce sin claves usables: ni WooCommerce ni Shopify, y dice por qué", async () => {
    const { admin } = fakeAdmin({ store: storeRow({ woo_consumer_secret_enc: null }) });
    const s = await loadSkuCatalogSource(admin, STORE, shopifyContado().creds);
    expect(s).toEqual({
      platform: "woocommerce",
      woo: null,
      problem: "Sus claves de la API no se pueden usar: revísalas en Ajustes → WooCommerce.",
    });
  });

  it("la tienda no se pudo leer: solo el historial, sin adivinar la plataforma", async () => {
    const { admin } = fakeAdmin({ storeError: "timeout" });
    expect(await loadSkuCatalogSource(admin, STORE, shopifyContado().creds)).toEqual({
      platform: null,
      problem: "No se pudo leer la plataforma de la tienda.",
    });
  });
});

// ── loadShopifySkuDetails con WooCommerce: la pantalla ──────────────────────

describe("la lista de la pantalla con WooCommerce", () => {
  beforeEach(() => clearWooCatalogCache());

  const woo = (fetchImpl: typeof fetch): SkuCatalogSource => ({ platform: "woocommerce", woo: client(fetchImpl) });

  it("sale del catálogo de WooCommerce (con los que no tienen SKU) y el historial completa", async () => {
    const shop = fakeWoo({ products: CATALOGO, variations: VARIACIONES });
    const { admin } = fakeAdmin({ orders: [PEDIDO] });
    const avisos: string[] = [];
    const details = await loadShopifySkuDetails(STORE, admin, 365, woo(shop.fetchImpl), {
      onSourceError: (d) => avisos.push(d),
    });
    expect([...details.values()].map((d) => [d.shopifySku, d.title, d.variantTitle])).toEqual([
      ["818531465", "Fat-Burn Shorts", null],
      ["POLO-M", "Polo & Short", "M / Negro"],
      [null, "Polo & Short", "L / Negro"],
      [null, "Astaxantina", null],
      ["FB-M", "Fat-Burn Shorts", "M"],
    ]);
    expect(details.get("POLO-M")).toMatchObject({ productId: "woo:11", variantId: "woo:111" });
    expect(avisos).toEqual([]);
  });

  it("si WooCommerce falla, carga igual con el historial y el aviso es de WooCommerce, nunca de Shopify", async () => {
    const shop = fakeWoo({ products: CATALOGO, fail: () => ({ status: 503, body: {} }) });
    const { admin } = fakeAdmin({ orders: [PEDIDO] });
    const avisos: string[] = [];
    const deShopify: string[] = [];
    const details = await loadShopifySkuDetails(STORE, admin, 365, woo(shop.fetchImpl), {
      onSourceError: (d) => avisos.push(d),
      onShopifyError: (d) => deShopify.push(d),
    });
    expect([...details.keys()]).toEqual(["FB-M"]);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).not.toMatch(/shopify/i);
    expect(deShopify).toEqual([]);
  });

  it("una lectura a medias se avisa y el historial completa", async () => {
    const shop = fakeWoo({
      products: CATALOGO,
      variations: VARIACIONES,
      fail: (path) => (path === "/products/11/variations" ? { status: 500, body: {} } : null),
    });
    const { admin } = fakeAdmin({ orders: [PEDIDO] });
    const avisos: string[] = [];
    const details = await loadShopifySkuDetails(STORE, admin, 365, woo(shop.fetchImpl), {
      onSourceError: (d) => avisos.push(d),
    });
    expect(details.has("818531465")).toBe(true);
    expect(details.has("FB-M")).toBe(true);
    expect(avisos).toEqual(["Se leyó en parte (no se pudieron leer las variaciones de 1 producto(s))."]);
  });

  it("en memoria unos minutos: pintar de nuevo no relee WooCommerce; «Sincronizar» (fresh) sí", async () => {
    const shop = fakeWoo({ products: CATALOGO, variations: VARIACIONES });
    const { admin } = fakeAdmin();
    await loadShopifySkuDetails(STORE, admin, 365, woo(shop.fetchImpl));
    const after1 = shop.calls.length;
    await loadShopifySkuDetails(STORE, admin, 365, woo(shop.fetchImpl));
    expect(shop.calls.length).toBe(after1);
    await loadShopifySkuDetails(STORE, admin, 365, woo(shop.fetchImpl), { fresh: true });
    expect(shop.calls.length).toBe(after1 * 2);
  });

  it("una lectura que falló no se guarda: la siguiente vuelve a intentar", async () => {
    let down = true;
    const shop = fakeWoo({ products: CATALOGO, fail: () => (down ? { status: 503, body: {} } : null) });
    const { admin } = fakeAdmin();
    await loadShopifySkuDetails(STORE, admin, 365, woo(shop.fetchImpl));
    down = false;
    const details = await loadShopifySkuDetails(STORE, admin, 365, woo(shop.fetchImpl));
    expect(details.has("818531465")).toBe(true);
  });

  it("sin claves usables: solo el historial, con el porqué", async () => {
    const { admin } = fakeAdmin({ orders: [PEDIDO] });
    const avisos: string[] = [];
    const details = await loadShopifySkuDetails(
      STORE,
      admin,
      365,
      { platform: "woocommerce", woo: null, problem: "Sus claves de la API no se pueden usar." },
      { onSourceError: (d) => avisos.push(d) },
    );
    expect([...details.keys()]).toEqual(["FB-M"]);
    expect(avisos).toEqual(["Sus claves de la API no se pueden usar."]);
  });

  it("los nombres para la siembra salen de WooCommerce (solo los que tienen SKU)", async () => {
    const shop = fakeWoo({ products: CATALOGO, variations: VARIACIONES });
    const { admin } = fakeAdmin();
    const names = await loadShopifySkuNames(STORE, admin, 365, woo(shop.fetchImpl));
    expect([...names]).toEqual([
      ["818531465", "Fat-Burn Shorts"],
      ["POLO-M", "Polo & Short"],
    ]);
  });
});

// ── La sincronización del catálogo de Aliclik ───────────────────────────────

describe("syncAliclikCatalog en una tienda en WooCommerce", () => {
  beforeEach(() => clearWooCatalogCache());

  it("siembra el mapeo por nombre con el catálogo de WooCommerce y cuenta sus SKU", async () => {
    const shop = fakeWoo({ products: CATALOGO, variations: VARIACIONES });
    const { admin, upserts } = fakeAdmin();
    const report = await syncAliclikCatalog(STORE, { apiToken: "t" }, admin, {
      platform: "woocommerce",
      woo: client(shop.fetchImpl),
    });
    expect(report.ok).toBe(true);
    expect(report.sourcePlatform).toBe("woocommerce");
    expect(report.shopifySkus).toBe(2);
    expect(report.errors).toEqual([]);
    const map = upserts.find((u) => u.table === "aliclik_sku_map")!;
    // El SKU de Aliclik se siembra a sí mismo y el de WooCommerce, por nombre.
    expect(map.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ shopify_sku: "818531465", ean: "111", source: "auto" })]),
    );
  });

  it("si WooCommerce falla, termina, siembra lo que puede y el aviso nombra WooCommerce", async () => {
    const shop = fakeWoo({ products: CATALOGO, fail: () => ({ status: 401, body: { code: "woocommerce_rest_authentication_error", message: "Clave inválida" } }) });
    const { admin, upserts } = fakeAdmin();
    const report = await syncAliclikCatalog(STORE, { apiToken: "t" }, admin, {
      platform: "woocommerce",
      woo: client(shop.fetchImpl),
    });
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(/^Catálogo de WooCommerce: .+ Se asoció con el historial de pedidos\.$/);
    expect(report.errors[0]).not.toMatch(/shopify/i);
    expect(upserts.map((u) => u.table)).toEqual(expect.arrayContaining(["aliclik_skus", "aliclik_sku_map"]));
  });

  it("sincronizar siempre relee WooCommerce, aunque la pantalla lo tenga en memoria", async () => {
    const shop = fakeWoo({ products: CATALOGO, variations: VARIACIONES });
    const { admin } = fakeAdmin();
    const src: SkuCatalogSource = { platform: "woocommerce", woo: client(shop.fetchImpl) };
    await loadShopifySkuDetails(STORE, admin, 365, src);
    const before = shop.calls.length;
    await syncAliclikCatalog(STORE, { apiToken: "t" }, admin, src);
    expect(shop.calls.length).toBe(before * 2);
  });

  it("con Shopify, el aviso de siempre (nada cambia)", () => {
    expect(skuSourceErrorText("shopify", "Shopify contestó HTTP 402.")).toBe(
      "Catálogo activo de Shopify: Shopify contestó HTTP 402. Se asoció con el historial de pedidos.",
    );
    expect(skuSourceErrorText(null, "No se pudo leer la plataforma de la tienda.")).toBe(
      "Catálogo de la tienda: No se pudo leer la plataforma de la tienda. Se asoció con el historial de pedidos.",
    );
  });
});

// ── Los textos de la pantalla ───────────────────────────────────────────────

describe("los textos nombran la fuente correcta", () => {
  it("WooCommerce, Shopify o «la tienda»", () => {
    expect(catalogSourceIn("woocommerce")).toBe("en WooCommerce");
    expect(catalogSourceIn("shopify")).toBe("en Shopify");
    expect(catalogSourceIn(null)).toBe("en la tienda");
    expect(catalogSourceTag("woocommerce")).toBe("WooCommerce");
    expect(catalogSourceTag(null)).toBe("de la tienda");
    expect(catalogSkusPhrase(12, "shopify")).toBe("12 SKUs activos de Shopify");
    expect(catalogSkusPhrase(12, "woocommerce")).toBe("12 SKUs de WooCommerce");
    expect(catalogSourceNotice("woocommerce", [])).toBeNull();
    expect(catalogSourceNotice("woocommerce", ["WooCommerce no respondió a tiempo (10 s)."])).toMatch(
      /^Catálogo de WooCommerce: WooCommerce no respondió a tiempo \(10 s\)\. La lista se completó con el historial de pedidos/,
    );
  });

  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("la pantalla no dice «Shopify» a fuego: lo toma de la fuente", () => {
    const ui = read("components/aliclik-catalog.tsx");
    expect(ui).not.toMatch(/(SKU|Variante|Falta SKU|producto) (en )?Shopify/);
    expect(ui).toContain("catalogSourceIn(view.source)");
    expect(ui).toContain("view.sourceNotice");
  });

  it("los tres lugares que sincronizan eligen la fuente por la plataforma de la tienda", () => {
    for (const p of [
      "app/dashboard/envios/aliclik/actions.ts",
      "app/dashboard/[storeId]/settings/actions.ts",
      "app/api/cron/aliclik-catalog/route.ts",
    ]) {
      const src = read(p);
      expect(src, p).toContain("loadSkuCatalogSource(");
      expect(src, p).not.toContain("SKUs activos de Shopify");
    }
  });

  it("el MOM lo documenta en §38.12", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("#### Envíos → Catálogo de productos en WooCommerce (25-10-2026)");
    for (const name of ["loadSkuCatalogSource", "listWooCatalogVariants", "WOO_CATALOG_BUDGET_MS", "WOO_CATALOG_CACHE_MS", "test/aliclik-catalog-woo.test.ts"]) {
      expect(mom).toContain(name);
    }
  });
});
