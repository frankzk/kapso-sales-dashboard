import { describe, it, expect } from "vitest";
import { buildFenixDemand, type DemandShipment } from "@/lib/fenix-demand";
import type { FenixStockRow } from "@/lib/fenix";

const stock: FenixStockRow[] = [
  { city: "cusco", product: "Mushroom Coffee", sku: "MC-1", quantity: 2 },
  { city: "arequipa", product: "Colágeno", sku: null, quantity: 10 },
];

describe("buildFenixDemand", () => {
  it("flags shortfall when demand exceeds stock in a covered city", () => {
    const ships: DemandShipment[] = [
      { city: "Cusco", product: "Mushroom Coffee 180g" },
      { city: "Cusco", product: "Mushroom Coffee 180g" },
      { city: "Cusco", product: "Mushroom Coffee 180g" }, // 3 demand vs 2 stock
    ];
    const rows = buildFenixDemand(stock, ships);
    const mc = rows.find((r) => r.city === "cusco" && r.product === "Mushroom Coffee")!;
    expect(mc.demand).toBe(3);
    expect(mc.stock).toBe(2);
    expect(mc.shortfall).toBe(1);
    expect(mc.status).toBe("reponer");
  });

  it("surfaces a product with demand but no stock as sin_stock (send it)", () => {
    const ships: DemandShipment[] = [
      { city: "Cusco", product: "Producto Nuevo Sin Stock" },
      { city: "Cusco", product: "Producto Nuevo Sin Stock" },
    ];
    const rows = buildFenixDemand(stock, ships);
    const gap = rows.find((r) => r.status === "sin_stock" && r.product === "Producto Nuevo Sin Stock")!;
    expect(gap.city).toBe("cusco");
    expect(gap.demand).toBe(2);
    expect(gap.stock).toBe(0);
    expect(gap.shortfall).toBe(2);
    // sorted first (highest shortfall)
    expect(rows[0]).toBe(gap);
  });

  it("matches demand by the linked order's SKU over free-text", () => {
    const ships: DemandShipment[] = [
      { city: "Cusco", product: "texto raro del courier", orderProduct: { title: "otro nombre", sku: "MC-1" } },
    ];
    const rows = buildFenixDemand(stock, ships);
    const mc = rows.find((r) => r.product === "Mushroom Coffee")!;
    expect(mc.demand).toBe(1); // attributed to the MC-1 stock row via SKU
  });

  it("ignores guides in uncovered cities", () => {
    const ships: DemandShipment[] = [{ city: "Lima", product: "Mushroom Coffee" }];
    const rows = buildFenixDemand(stock, ships);
    expect(rows.every((r) => r.city !== "lima")).toBe(true);
    expect(rows.find((r) => r.product === "Mushroom Coffee")!.demand).toBe(0);
  });

  it("stock with no current demand shows OK, zero shortfall", () => {
    const rows = buildFenixDemand(stock, []);
    expect(rows.every((r) => r.status === "ok" && r.shortfall === 0)).toBe(true);
  });
});
