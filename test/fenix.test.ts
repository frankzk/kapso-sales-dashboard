import { describe, it, expect } from "vitest";
import { evaluateFenix, type FenixStockRow } from "@/lib/fenix";

const stock: FenixStockRow[] = [
  { city: "cusco", product: "SUPER HUMAN Ethiopian Black Seed Oil", quantity: 5 },
  { city: "arequipa", product: "Pulsera Magnética", quantity: 0 },
  { city: "trujillo", product: "Mushroom Coffee", quantity: 3 },
];

describe("evaluateFenix", () => {
  it("eligible when city is covered and product has stock (loose match)", () => {
    const r = evaluateFenix({ city: "Cusco", product: "SUPER HUMAN Ethiopian Black Seed Oil (60 caps)" }, stock);
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("ok");
    expect(r.city).toBe("cusco");
  });

  it("sin_stock when the city is covered but quantity is 0", () => {
    const r = evaluateFenix({ city: "Arequipa", product: "Pulsera Magnética" }, stock);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("sin_stock");
  });

  it("sin_cobertura when the city is not covered", () => {
    const r = evaluateFenix({ city: "Lima", product: "Mushroom Coffee" }, stock);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("sin_cobertura");
  });

  it("sin_stock when the product doesn't match any stock row in a covered city", () => {
    const r = evaluateFenix({ city: "Trujillo", product: "Producto desconocido" }, stock);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("sin_stock");
  });

  it("handles Juliaca/Puno normalization", () => {
    const j: FenixStockRow[] = [{ city: "juliaca", product: "X", quantity: 2 }];
    expect(evaluateFenix({ city: "Juliaca/Puno", product: "X" }, j).eligible).toBe(true);
  });

  it("matches the same product across naming drift (token overlap)", () => {
    // Real case: report label vs stock-sheet label describe the same product
    // differently — neither contains the other, but the ingredient tokens match.
    const s: FenixStockRow[] = [
      {
        city: "cusco",
        product:
          "8 en 1 Ultra - Cápsulas de Shilajit Ashwagandha Rhodiola Rosea Panax y Ginseng (120 Cápsulas) SuperHuman™ PG",
        quantity: 5,
      },
    ];
    const r = evaluateFenix(
      { city: "Cusco", product: "8 en 1 Cápsulas - Shilajit Ashwagandha Rhodiola Rosea Panax y Ginseng" },
      s,
    );
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("ok");
  });

  it("does not over-match two different products that share a generic word", () => {
    const s: FenixStockRow[] = [
      { city: "cusco", product: "Colágeno Hidrolizado en Cápsulas SuperHuman", quantity: 5 },
    ];
    const r = evaluateFenix(
      { city: "Cusco", product: "Magnesio en Cápsulas SuperHuman" },
      s,
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("sin_stock");
  });
});
