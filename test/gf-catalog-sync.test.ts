import { describe, expect, it } from "vitest";
import { GF_BATCH_SIZE, gfSyncBatches, planGfCatalogSync, type GfCatalogProduct } from "@/lib/gf-courier-catalog";

const gf = (sku: string, name: string, extra: Partial<GfCatalogProduct> = {}): GfCatalogProduct => ({ merchant_sku: sku, name, mode: "UNBOUNDED", sales_status: "IN_STOCK", ...extra });

describe("planGfCatalogSync", () => {
  it("crea lo que falta, renombra lo que cambió (conservando su disponibilidad) y no toca lo igual", () => {
    const plan = planGfCatalogSync(
      [{ sku: "A-1", name: "Sérum A" }, { sku: "b-2", name: "Crema B – 50 ml" }, { sku: "C-3", name: "Gel C" }],
      [gf("B-2", "Crema B", { sales_status: "OUT_OF_STOCK" }), gf("C-3", "Gel C")],
    );
    expect(plan.create).toEqual([{ sku: "A-1", name: "Sérum A", sales_status: "IN_STOCK" }]);
    expect(plan.rename).toEqual([{ sku: "B-2", name: "Crema B – 50 ml", sales_status: "OUT_OF_STOCK" }]);
    expect(plan.discontinue).toEqual([]);
  });
  it("agota lo que la tienda dejó de vender, solo si es sin conteo y estaba En existencias", () => {
    const plan = planGfCatalogSync(
      [{ sku: "K", name: "K" }, { sku: "L", name: "L" }, { sku: "M", name: "M" }, { sku: "N", name: "N" }],
      [gf("K", "K"), gf("L", "L"), gf("M", "M"), gf("N", "N"), gf("VIEJO", "Viejo"), gf("CONTADO", "Contado", { mode: "COUNTED" }), gf("YA", "Ya agotado", { sales_status: "OUT_OF_STOCK" })],
    );
    expect(plan.discontinue).toEqual([{ sku: "VIEJO", name: "Viejo", sales_status: "OUT_OF_STOCK" }]);
    expect(plan.discontinueSkipped).toBeNull();
  });
  it("con una lectura a medias o demasiados de golpe, no agota nada y dice por qué", () => {
    const partial = planGfCatalogSync([{ sku: "K", name: "K" }], [gf("K", "K"), gf("X", "X")], { partial: true });
    expect(partial.discontinue).toEqual([]);
    expect(partial.discontinueSkipped).toMatch(/en parte/);
    const many = planGfCatalogSync([{ sku: "K", name: "K" }], [gf("K", "K"), gf("X", "X"), gf("Y", "Y")]);
    expect(many.discontinue).toEqual([]);
    expect(many.discontinueSkipped).toMatch(/2 de 3/);
  });
  it("manda en lotes de hasta 200: crear, renombrar, agotar", () => {
    const store = Array.from({ length: 450 }, (_, i) => ({ sku: `S${i}`, name: `P${i}` }));
    const batches = gfSyncBatches(planGfCatalogSync(store, []));
    expect(batches.map((b) => b.length)).toEqual([GF_BATCH_SIZE, GF_BATCH_SIZE, 50]);
    expect(batches[0]?.[0]).toEqual({ sku: "S0", name: "P0", sales_status: "IN_STOCK" });
  });
});
