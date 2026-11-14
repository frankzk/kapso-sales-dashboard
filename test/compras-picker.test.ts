import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProductPicker, searchProductPicker, type CatalogEntry } from "@/lib/compras-ia";

// «Agregar producto» elige del catálogo de las tiendas (MOM §45.1): el mismo
// catálogo de «Leer con IA», ordenado por pedidos, con la tienda solo cuando
// el SKU se vio siempre en la misma.

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

  it("la página carga el catálogo solo con «Compras»", () => {
    const page = read("app/dashboard/compras/[id]/page.tsx");
    expect(page).toContain("detail.perms.canManage");
    expect(page).toMatch(/detail\.perms\.canManage\s*\?\s*await Promise\.all\(\[[\s\S]*loadSkuCatalog\(detail\.imp\.org_id\)/);
  });

  it("el catálogo no trae costos", () => {
    const server = read("lib/compras-server.ts");
    expect(server).toContain('.select("sku,product_name,store_id")');
  });

  it("agregar desde el catálogo usa la misma acción que a mano", () => {
    const ui = read("components/compras/import-detail.tsx");
    expect((ui.match(/addImportItem\(/g) ?? []).length).toBe(1);
  });
});
