import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// «Agregar producto» elige del catálogo de las tiendas (MOM §45.1): el
// catálogo VIVO de cada tienda (WooCommerce o Shopify, la fuente de Envíos →
// «Catálogo de productos») y, para los SKU que no están en ninguno, el
// historial (Costos de productos y los SKU vistos en pedidos, el catálogo de
// «Leer con IA»), ordenado por pedidos.
//
// El caso del owner (14-11-2026, «no aparece este producto»): «Bóxer Confort –
// Comodidad que se Mueve Contigo (Pack de 4)», tallas 4XL/5XL/6XL, de Aurela
// en WooCommerce, sin ventas todavía: estaba en el Catálogo de productos y no
// en el selector, que solo miraba el historial.

const h = vi.hoisted(() => ({
  history: [] as import("@/lib/compras-ia").CatalogEntry[],
  /** Por tienda: las variantes de su catálogo vivo, o el error al leerlo. */
  live: {} as Record<string, { variants: import("@/lib/aliclik-catalog").ShopifySkuDetails[]; error?: string }>,
  reads: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ createAdminSupabase: () => ({}) }));
vi.mock("@/lib/ingest", () => ({ getStoreCreds: async (id: string) => ({ id, shopify_domain: `${id}.myshopify.com`, shopify_token: null }) }));
vi.mock("@/lib/compras-server", () => ({ loadSkuCatalog: async () => h.history }));
vi.mock("@/lib/aliclik-catalog", () => ({
  loadSkuCatalogSource: async (_a: unknown, storeId: string) => ({ platform: "woocommerce", woo: { siteUrl: `https://${storeId}.pe` } }),
  loadShopifySkuDetails: async (storeId: string, _a: unknown, sinceDays: number, _s: unknown, opts: { onSourceError?: (d: string) => void }) => {
    h.reads.push(`${storeId}:${sinceDays}`);
    const store = h.live[storeId];
    if (store?.error) opts.onSourceError?.(store.error);
    return new Map((store?.variants ?? []).map((v, i) => [v.shopifySku ?? `sin-${i}`, v]));
  },
}));

import { PICKER_LIMIT, buildProductPicker, capProductPicker, pickerName, searchProductPicker, type CatalogEntry, type LiveCatalogEntry } from "@/lib/compras-ia";
import { clearPickerCatalogCache, loadPickerCatalog } from "@/lib/compras-catalogo";

const STORE_A = "11111111-1111-4111-8111-111111111111";
const STORE_B = "22222222-2222-4222-8222-222222222222";

const entries: CatalogEntry[] = [
  // Costos de productos (con tienda, sin pedidos).
  { sku: "KP-AUD-01", name: "Audífonos inalámbricos Pro", storeId: STORE_A },
  { sku: "CAB-C1", name: "Cable USB-C", storeId: STORE_A },
  { sku: "cab-c1 ", name: "Cable USB-C 1 m", storeId: STORE_B },
  // Pedidos de las tiendas (`org_shopify_products`: sin tienda, con pedidos).
  { sku: "LMP-LED", name: "Lámpara LED escritorio", storeId: null, orderCount: 40 },
  { sku: "CAB-C1", name: null, storeId: null, orderCount: 12 },
  { sku: "SER-VC30", name: "Sérum facial vitamina C", storeId: null, orderCount: 120 },
  { sku: "  ", name: "Sin SKU", storeId: null, orderCount: 999 },
];

describe("el catálogo del selector", () => {
  const list = buildProductPicker(entries);

  it("un producto por SKU (sin mayúsculas ni espacios), sin los que no tienen SKU", () => {
    expect(list.map((p) => p.sku)).toEqual(["SER-VC30", "LMP-LED", "CAB-C1", "KP-AUD-01"]);
  });

  it("ordenado por pedidos, sumados por SKU; a igual cifra, por nombre", () => {
    expect(list.map((p) => p.orderCount)).toEqual([120, 40, 12, 0]);
  });

  it("la tienda solo si el SKU se vio siempre en la misma (la regla de «Leer con IA»)", () => {
    expect(list.find((p) => p.sku === "KP-AUD-01")?.storeId).toBe(STORE_A);
    expect(list.find((p) => p.sku === "CAB-C1")?.storeId).toBeNull();
    expect(list.find((p) => p.sku === "LMP-LED")?.storeId).toBeNull();
  });

  it("el nombre, el primero que lo tenga", () => {
    expect(list.find((p) => p.sku === "CAB-C1")?.name).toBe("Cable USB-C");
  });
});

describe("buscar en el selector", () => {
  const list = buildProductPicker(entries);

  it("por nombre, sin tildes ni mayúsculas, con todas las palabras", () => {
    expect(searchProductPicker(list, "serum vitamina").map((p) => p.sku)).toEqual(["SER-VC30"]);
    expect(searchProductPicker(list, "AUDIFONOS").map((p) => p.sku)).toEqual(["KP-AUD-01"]);
  });

  it("por SKU", () => {
    expect(searchProductPicker(list, "cab-c1").map((p) => p.sku)).toEqual(["CAB-C1"]);
    expect(searchProductPicker(list, "lmp").map((p) => p.sku)).toEqual(["LMP-LED"]);
  });

  it("sin texto, los más pedidos; con tope", () => {
    expect(searchProductPicker(list, "  ", 2).map((p) => p.sku)).toEqual(["SER-VC30", "LMP-LED"]);
  });
});

describe("solo con «Compras» y sin montos", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("el catálogo se pide solo con «Compras», al abrir «Agregar producto», con las tiendas que la persona ve", () => {
    const actions = read("app/dashboard/compras/actions.ts");
    const body = actions.slice(actions.indexOf("export async function loadImportPicker("));
    expect(body.slice(0, 800)).toMatch(/authorize\(admin, importId, \{ manage: true \}\)/);
    expect(body.slice(0, 800)).toContain("(await getAccessibleStores()).filter((s) => s.org_id === a.imp.org_id)");
    // La página ya no lo lee en cada vista del detalle.
    expect(read("app/dashboard/compras/[id]/page.tsx")).not.toMatch(/loadSkuCatalog|buildProductPicker|loadPickerCatalog/);
    expect(read("components/compras/import-detail.tsx")).toContain("loadImportPicker(importId)");
  });

  it("el catálogo no trae costos ni precios", () => {
    const server = read("lib/compras-server.ts");
    expect(server).toContain('.select("sku,product_name,store_id")');
    const live = read("lib/compras-catalogo.ts");
    const mapped = live.slice(live.indexOf("const entries: LiveCatalogEntry[]"), live.indexOf("if (!problems.length)"));
    expect(mapped).not.toMatch(/price|cost|amount/i);
  });

  it("agregar desde el catálogo usa la misma acción que a mano", () => {
    const ui = read("components/compras/import-detail.tsx");
    expect((ui.match(/addImportItem\(/g) ?? []).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// El catálogo vivo de las tiendas
// ---------------------------------------------------------------------------

const AURELA = "33333333-3333-4333-8333-333333333333";
const KENKU = "44444444-4444-4444-8444-444444444444";
const BOXER = "Bóxer Confort – Comodidad que se Mueve Contigo (Pack de 4)";
const boxer = (talla: string): LiveCatalogEntry => ({ storeId: AURELA, sku: `BOXER-CONFORT-P4-${talla}`, title: BOXER, variantTitle: talla, productId: "901", variantId: `9${talla}` });

describe("el selector con el catálogo vivo", () => {
  const live: LiveCatalogEntry[] = [
    boxer("4XL"),
    boxer("5XL"),
    boxer("6XL"),
    // Ya se vendió: sus pedidos salen del historial; su tienda, del catálogo.
    { storeId: AURELA, sku: "SER-VC30", title: "Sérum facial vitamina C", variantTitle: "Default Title" },
    // El mismo SKU en otra tienda: otro producto, con su tienda.
    { storeId: KENKU, sku: "SER-VC30", title: "Sérum vitamina C", variantTitle: null },
    // Una variante sin SKU: se ve, marcada.
    { storeId: AURELA, sku: null, title: "Faja reductora", variantTitle: "M", productId: "77", variantId: "7701" },
    { storeId: AURELA, sku: null, title: "Faja reductora", variantTitle: "L", productId: "77", variantId: "7702" },
  ];
  const list = buildProductPicker(entries, live);

  it("el producto sin ventas aparece, con su tienda, «título – variante» y 0 pedidos", () => {
    const p = list.find((x) => x.sku === "BOXER-CONFORT-P4-5XL")!;
    expect(p).toMatchObject({ name: `${BOXER} – 5XL`, storeId: AURELA, orderCount: 0 });
    expect(list.filter((x) => x.sku?.startsWith("BOXER-CONFORT-P4-")).map((x) => x.name)).toEqual([
      `${BOXER} – 4XL`,
      `${BOXER} – 5XL`,
      `${BOXER} – 6XL`,
    ]);
  });

  it("se busca sin tildes y por SKU", () => {
    expect(searchProductPicker(list, "boxer").map((p) => p.sku)).toEqual(["BOXER-CONFORT-P4-4XL", "BOXER-CONFORT-P4-5XL", "BOXER-CONFORT-P4-6XL"]);
    expect(searchProductPicker(list, "Bóxer confort 6xl").map((p) => p.sku)).toEqual(["BOXER-CONFORT-P4-6XL"]);
    expect(searchProductPicker(list, "boxer-confort-p4-4xl").map((p) => p.sku)).toEqual(["BOXER-CONFORT-P4-4XL"]);
  });

  it("los pedidos de `org_shopify_products` cuando el SKU coincide; el más pedido primero", () => {
    expect(list[0]).toMatchObject({ sku: "SER-VC30", orderCount: 120 });
    expect(list.filter((p) => p.sku === "SER-VC30").map((p) => p.storeId).sort()).toEqual([AURELA, KENKU].sort());
    // «Default Title» no es una variante.
    expect(list.find((p) => p.sku === "SER-VC30" && p.storeId === AURELA)?.name).toBe("Sérum facial vitamina C");
  });

  it("las variantes sin SKU se ven, sin SKU y cada una por su cuenta", () => {
    const sinSku = list.filter((p) => p.sku === null);
    expect(sinSku.map((p) => p.name)).toEqual(["Faja reductora – L", "Faja reductora – M"]);
    expect(new Set(list.map((p) => p.key)).size).toBe(list.length);
    expect(sinSku.every((p) => p.storeId === AURELA && p.orderCount === 0)).toBe(true);
  });

  it("el historial queda para los SKU que ningún catálogo tiene (p. ej. descontinuados)", () => {
    expect(list.find((p) => p.sku === "LMP-LED")).toMatchObject({ storeId: null, orderCount: 40 });
    expect(list.find((p) => p.sku === "KP-AUD-01")).toMatchObject({ storeId: STORE_A });
    // El SKU que sí está en un catálogo no se repite desde el historial.
    expect(list.filter((p) => p.sku === "SER-VC30")).toHaveLength(2);
  });

  it("el nombre: título y variante, sin «Default Title»", () => {
    expect(pickerName("Crema", "Default Title")).toBe("Crema");
    expect(pickerName(" Crema ", " 50 ml ")).toBe("Crema – 50 ml");
    expect(pickerName("Crema", null)).toBe("Crema");
  });

  it("el tope de 3000: los más pedidos y cuántos quedaron fuera", () => {
    const many = Array.from({ length: PICKER_LIMIT + 5 }, (_, i) => ({ storeId: AURELA, sku: `SKU-${i}`, title: `Producto ${i}`, variantTitle: null }));
    const { products, omitted } = capProductPicker(buildProductPicker([], many));
    expect(products).toHaveLength(PICKER_LIMIT);
    expect(omitted).toBe(5);
  });
});

describe("leer el catálogo de cada tienda (servidor)", () => {
  beforeEach(() => {
    clearPickerCatalogCache();
    h.reads = [];
    h.history = [{ sku: "OLD-1", name: "Producto descontinuado", storeId: null, orderCount: 3 }];
    h.live = {
      [AURELA]: {
        variants: ["4XL", "5XL", "6XL"].map((t) => ({ shopifySku: `BOXER-CONFORT-P4-${t}`, title: BOXER, variantTitle: t, productId: "901", variantId: `9${t}` })),
      },
      [KENKU]: { variants: [], error: "WooCommerce respondió 401." },
    };
  });

  const stores = [
    { id: AURELA, name: "Aurela", status: "active" },
    { id: KENKU, name: "Kenku", status: "active" },
    { id: "55555555-5555-4555-8555-555555555555", name: "Vieja", status: "disabled" },
  ];

  it("el catálogo vivo de cada tienda activa, el historial y el aviso de la que no se pudo leer", async () => {
    const c = await loadPickerCatalog("org", stores);
    expect(c.products.map((p) => p.sku)).toEqual(["OLD-1", "BOXER-CONFORT-P4-4XL", "BOXER-CONFORT-P4-5XL", "BOXER-CONFORT-P4-6XL"]);
    expect(c.products.find((p) => p.sku === "BOXER-CONFORT-P4-4XL")?.storeId).toBe(AURELA);
    expect(c.notices).toEqual(["No se pudo leer el catálogo de Kenku; se muestran los productos vendidos."]);
    expect(c.omitted).toBe(0);
    // Sin releer un año de pedidos por tienda (el historial llega por `org_shopify_products`), y la inactiva no se lee.
    expect(h.reads.sort()).toEqual([`${AURELA}:0`, `${KENKU}:0`].sort());
  });

  it("leída en parte: lo leído se queda y se dice", async () => {
    h.live[KENKU] = { variants: [{ shopifySku: "K-1", title: "Gel", variantTitle: null, productId: null, variantId: null }], error: "Se leyó en parte (tiempo)." };
    const c = await loadPickerCatalog("org", stores);
    expect(c.products.some((p) => p.sku === "K-1" && p.storeId === KENKU)).toBe(true);
    expect(c.notices).toEqual(["El catálogo de Kenku se leyó en parte; se completa con los productos vendidos."]);
  });

  it("una tienda leída bien se guarda unos minutos; la que falló se vuelve a intentar", async () => {
    await loadPickerCatalog("org", stores);
    await loadPickerCatalog("org", stores);
    expect(h.reads.filter((r) => r.startsWith(AURELA))).toHaveLength(1);
    expect(h.reads.filter((r) => r.startsWith(KENKU))).toHaveLength(2);
  });
});
