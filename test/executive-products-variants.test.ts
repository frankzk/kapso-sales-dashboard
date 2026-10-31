import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { productVariantLabel, topProducts } from "@/lib/metrics";
import type { OrderLineItem, OrderRow } from "@/lib/types";

// «Productos» del Consolidado con sus variantes (owner, 31-10-2026: «Quiero
// saber qué variantes se venden en Productos»). MOM §17.4.1.

const AURELA = "4c6522f9-c775-4be3-95b0-160a3c16d27a";
const SHORTS = "Fat‑Burn Shorts - Shorts para Quemar Grasa – Faja Moldeadora de Compresión y Control Abdomen";
const PASTILLERO = "Cortador Organizador de Pastillas 4 en 1 Echu";

let seq = 0;
function order(items: Partial<OrderLineItem>[], extra: Partial<OrderRow> = {}): OrderRow {
  seq += 1;
  return {
    id: `o${seq}`,
    store_id: AURELA,
    cancelled_at: null,
    line_items: items.map((li) => ({
      title: "",
      quantity: 1,
      sku: null,
      product_id: null,
      variant_id: null,
      price: null,
      ...li,
    })),
    ...extra,
  } as OrderRow;
}

// Como los guarda `lib/shopify.ts`: título del producto, opciones en
// `variant_title` (sin «Default Title») y un SKU por variante.
const shopifyShorts = (variant: string, sku: string, variantId: string, quantity = 1): Partial<OrderLineItem> => ({
  title: SHORTS,
  variant_title: variant,
  sku,
  product_id: "9586405769436",
  variant_id: variantId,
  quantity,
  price: 89.9,
});

// Como los guarda `lib/woocommerce.ts`: `parent_name` de título, los atributos
// de la variación en `variant_title` (con la oferta por cantidad) y otro id.
const wooShorts = (variant: string, sku: string, variantId: string, quantity = 1): Partial<OrderLineItem> => ({
  title: SHORTS,
  variant_title: variant,
  sku,
  product_id: "10342",
  variant_id: variantId,
  quantity,
  price: 89.9,
});

describe("productVariantLabel", () => {
  it("lee variant_title de Shopify y de WooCommerce", () => {
    expect(productVariantLabel({ variant_title: "Negro / L" })).toBe("Negro / L");
    expect(productVariantLabel({ variant_title: "  M  " })).toBe("M");
  });

  it("nunca devuelve «Default Title» ni una variante vacía", () => {
    expect(productVariantLabel({ variant_title: "Default Title" })).toBeNull();
    expect(productVariantLabel({ variant_title: "default title" })).toBeNull();
    expect(productVariantLabel({ variant_title: "" })).toBeNull();
    expect(productVariantLabel({ variant_title: null })).toBeNull();
    expect(productVariantLabel({})).toBeNull();
  });

  it("quita la oferta por cantidad de WooCommerce, que no es una variante", () => {
    expect(productVariantLabel({ variant_title: "Negro / XXL / 1 unidad" })).toBe("Negro / XXL");
    expect(productVariantLabel({ variant_title: "Negro / XXL / 2 und. + 1 GRATIS (Total 3 und.)" })).toBe("Negro / XXL");
    expect(productVariantLabel({ variant_title: "Trébol Gold / 1 unidad" })).toBe("Trébol Gold");
  });

  it("respeta una variante que solo es la presentación", () => {
    expect(productVariantLabel({ variant_title: "Sólo 1 unidad" })).toBe("Sólo 1 unidad");
    expect(productVariantLabel({ variant_title: "2 unidades" })).toBe("2 unidades");
    expect(productVariantLabel({ variant_title: "Set Fruits para Niñas - 3und" })).toBe("Set Fruits para Niñas - 3und");
  });
});

describe("topProducts con variantes", () => {
  it("junta las variantes de un producto aunque cada una tenga su SKU (Shopify)", () => {
    const products = topProducts([
      order([shopifyShorts("Negro / L", "48143430648062", "52334226997468", 2)]),
      order([shopifyShorts("Negro / XL", "48143430680830", "52334227030236")]),
      order([shopifyShorts("Negro / L", "48143430648062", "52334226997468")]),
      order([{ title: PASTILLERO, sku: "27753716", product_id: "9599507366108", variant_id: "52431632564444", quantity: 2, price: 59.9 }]),
    ], Number.POSITIVE_INFINITY);

    expect(products).toHaveLength(2);
    const [shorts, pastillero] = products;
    expect(shorts).toMatchObject({ title: SHORTS, quantity: 4, orders: 3, revenue: 359.6 });
    expect(shorts!.variants).toEqual([
      { label: "Negro / L", quantity: 3, orders: 2, revenue: 269.7 },
      { label: "Negro / XL", quantity: 1, orders: 1, revenue: 89.9 },
    ]);
    // Sin variante (Shopify lo guarda sin «Default Title»): sin filas debajo.
    expect(pastillero).toMatchObject({ title: PASTILLERO, quantity: 2, variants: [] });
  });

  it("junta Shopify y WooCommerce: otro product_id y variant_id, la misma variante", () => {
    const products = topProducts([
      order([shopifyShorts("Negro / XXL", "48143430713598", "52334227063004")], { store_id: AURELA }),
      order([wooShorts("Negro / XXL / 1 unidad", "48143430713598", "10353")]),
      order([wooShorts("Negro / XXL / 2 und. + 1 GRATIS (Total 3 und.)", "48143430713598", "10353", 3)]),
      order([wooShorts("Negro / XL", "48143430680830", "10352")]),
      order([wooShorts("negro / xl", "48143430680830", "10352")]),
    ]);

    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ title: SHORTS, quantity: 7, orders: 5 });
    expect(products[0]!.variants.map((v) => [v.label, v.quantity, v.orders])).toEqual([
      ["Negro / XXL", 5, 3],
      ["Negro / XL", 2, 2],
    ]);
  });

  it("WooCommerce sin variación (variant_id null): sin filas debajo", () => {
    const products = topProducts([
      order([{ title: PASTILLERO, sku: "27753716", product_id: "10388", variant_id: null, variant_title: null, quantity: 2, price: 59.9 }]),
      order([{ title: PASTILLERO, sku: "27753716", product_id: "9599507366108", variant_id: "52431632564444", quantity: 1, price: 59.9 }]),
    ]);
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ quantity: 3, orders: 2, variants: [] });
  });

  it("las líneas sin variante de un producto con variantes van al final, «Sin variante»", () => {
    const crucis = { title: "Crucis+ Pulsera Magnética de Cobre", sku: "645731546", product_id: "10305", price: 79.9 };
    const products = topProducts([
      order([{ ...crucis, quantity: 3 }]),
      order([{ ...crucis, variant_title: "Cobre clásico / 1 unidad", variant_id: "11442", quantity: 1 }]),
      order([{ ...crucis, variant_title: "Cobre clásico", variant_id: "11442", quantity: 1 }]),
    ]);
    expect(products[0]!.variants.map((v) => [v.label, v.quantity])).toEqual([
      ["Cobre clásico", 2],
      [null, 3],
    ]);
  });

  it("las unidades de las variantes suman las del producto, y el total no cambia", () => {
    const orders = [
      order([shopifyShorts("Negro / L", "A1", "1", 2), { title: PASTILLERO, sku: "P", quantity: 1, price: 10 }]),
      order([wooShorts("Beige / L / 1 unidad", "A2", "2"), { title: "Sin SKU", quantity: 4, price: 5 }]),
      order([shopifyShorts("Negro / L", "A1", "1")], { cancelled_at: "2026-10-30T10:00:00Z" }),
    ];
    const products = topProducts(orders, Number.POSITIVE_INFINITY);
    for (const p of products) {
      if (p.variants.length) expect(p.variants.reduce((s, v) => s + v.quantity, 0)).toBe(p.quantity);
    }
    // 2 + 1 + 1 + 4: la orden anulada no cuenta, como antes.
    expect(products.reduce((s, p) => s + p.quantity, 0)).toBe(8);
  });

  it("el mismo product_id en dos tiendas WooCommerce no junta productos distintos", () => {
    const products = topProducts([
      order([{ title: "Aceite", sku: "K1", product_id: "1938", quantity: 1 }], { store_id: "kenku" }),
      order([{ title: "Pulsera", sku: "A1", product_id: "1938", quantity: 1 }], { store_id: AURELA }),
    ]);
    expect(products).toHaveLength(2);
  });

  it("un producto renombrado con el mismo SKU sigue siendo uno, con el título más vendido", () => {
    const products = topProducts([
      order([{ title: "Tobillera X Pro", sku: "25652067", product_id: "7069103423676", quantity: 2 }]),
      order([{ title: "+ GRATIS Tobillera X Pro", sku: "25652067", product_id: "7069103423676", quantity: 1 }]),
    ]);
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ title: "Tobillera X Pro", quantity: 3, variants: [] });
  });
});

describe("panel «Productos»", () => {
  const src = readFileSync(resolve(process.cwd(), "components/executive-dashboard.tsx"), "utf8");

  it("pinta las variantes debajo de cada producto y nunca «Default Title»", () => {
    expect(src).toContain("<ProductsBreakdown products={products} currency={currency} />");
    expect(src).toContain("p.variants.map(");
    expect(src).not.toContain("Default Title");
  });

  it("es legible en el teléfono: lista bajo 640 px, tabla desde sm", () => {
    expect(src).toContain('className="hidden w-full text-sm sm:table"');
    expect(src).toContain('className="border-t border-line sm:hidden"');
  });

  it("la celda sigue con las tres barras a nivel de producto", () => {
    expect(src).toContain("products.slice(0, 3).map((p) => ({ label: p.title, value: p.quantity");
  });
});
