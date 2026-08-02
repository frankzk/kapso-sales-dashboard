import { describe, expect, it } from "vitest";
import { buildProductCostViews, skuKey, type ProductCostRow } from "@/lib/costs";

function row(partial: Partial<ProductCostRow> & { id: string; sku: string; unit_cost: number; effective_from: string }): ProductCostRow {
  return {
    store_id: null,
    product_name: null,
    supplier: null,
    batch: null,
    effective_to: null,
    ...partial,
  };
}

describe("skuKey", () => {
  it("normaliza acentos, espacios y mayúsculas", () => {
    expect(skuKey("  Ábc-01 ")).toBe("abc-01");
    expect(skuKey("ABC01")).toBe(skuKey("abc01"));
  });
  it("string vacío para nulos", () => {
    expect(skuKey(null)).toBe("");
    expect(skuKey(undefined)).toBe("");
  });
});

describe("buildProductCostViews", () => {
  const catalog = [
    { sku: "AAA", productName: "Colágeno", orderCount: 10 },
    { sku: "BBB", productName: "Magnesio", orderCount: 3 },
  ];

  it("lista productos de Shopify sin costo como sin asignar", () => {
    const views = buildProductCostViews(catalog, [], null);
    expect(views.map((v) => v.sku)).toEqual(["AAA", "BBB"]);
    expect(views.every((v) => v.currentCost === null)).toBe(true);
    expect(views.every((v) => v.fromShopify)).toBe(true);
  });

  it("toma el costo vigente (periodo abierto) y arma la línea de tiempo", () => {
    const costs = [
      row({ id: "1", sku: "aaa", unit_cost: 12, effective_from: "2026-01-01", effective_to: "2026-05-31" }),
      row({ id: "2", sku: "aaa", unit_cost: 15, effective_from: "2026-06-01" }),
    ];
    const views = buildProductCostViews(catalog, costs, null);
    const aaa = views.find((v) => v.sku === "AAA")!;
    expect(aaa.currentCost).toBe(15);
    // Historial ordenado del más reciente al más antiguo.
    expect(aaa.history.map((h) => h.unit_cost)).toEqual([15, 12]);
  });

  it("respeta el ámbito de tienda: general no ve costos de una tienda concreta", () => {
    const costs = [row({ id: "1", sku: "AAA", unit_cost: 20, effective_from: "2026-01-01", store_id: "store-1" })];
    expect(buildProductCostViews(catalog, costs, null).find((v) => v.sku === "AAA")!.currentCost).toBeNull();
    expect(buildProductCostViews(catalog, costs, "store-1").find((v) => v.sku === "AAA")!.currentCost).toBe(20);
  });

  it("empareja SKU sin distinguir mayúsculas ni acentos", () => {
    const costs = [row({ id: "1", sku: "aaa", unit_cost: 9, effective_from: "2026-01-01" })];
    const aaa = buildProductCostViews(catalog, costs, null).find((v) => v.sku === "AAA")!;
    expect(aaa.currentCost).toBe(9);
  });

  it("incluye costos huérfanos (SKU que ya no está en Shopify) al final", () => {
    const costs = [row({ id: "1", sku: "ZZZ", unit_cost: 5, effective_from: "2026-01-01" })];
    const views = buildProductCostViews(catalog, costs, null);
    const zzz = views.find((v) => v.sku === "ZZZ")!;
    expect(zzz.fromShopify).toBe(false);
    expect(views[views.length - 1]!.sku).toBe("ZZZ");
  });
});
