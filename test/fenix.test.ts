import { describe, it, expect } from "vitest";
import {
  currentFenixReason,
  evaluateFenix,
  fenixStockCityKey,
  matchesFenixAvailability,
  type FenixStockRow,
} from "@/lib/fenix";

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

  it("shares the same Fenix stock pool between Juliaca and Puno", () => {
    const juliacaStock: FenixStockRow[] = [
      { city: "juliaca", product: "Ethiopian Black Seed Oil", sku: "PRUEBA-ETHIOPIAN", quantity: 3 },
    ];
    const punoStock: FenixStockRow[] = [
      { city: "puno", product: "Pulsera Magnética", sku: "PULSERA", quantity: 2 },
    ];

    expect(fenixStockCityKey("Puno")).toBe("juliaca");
    expect(fenixStockCityKey("Juliaca")).toBe("juliaca");
    expect(
      evaluateFenix(
        { city: "Puno", product: "Nombre distinto" },
        juliacaStock,
        [{ title: "Ethiopian Black Seed Oil", sku: "PRUEBA-ETHIOPIAN" }],
      ).eligible,
    ).toBe(true);
    expect(
      evaluateFenix(
        { city: "Juliaca", product: "Nombre distinto" },
        punoStock,
        [{ title: "Pulsera Magnética", sku: "PULSERA" }],
      ).eligible,
    ).toBe(true);
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

  it("matches the linked order's products (by SKU) over the Aliclik free-text", () => {
    const s: FenixStockRow[] = [
      { city: "cusco", product: "8 en 1 Ultra SuperHuman", sku: "SH-8EN1", quantity: 5 },
    ];
    // The Aliclik free-text product wouldn't match by name, but the linked
    // Shopify order's line item shares the exact SKU → eligible.
    const r = evaluateFenix(
      { city: "Cusco", product: "combo raro tipeado por el courier" },
      s,
      [{ title: "8 en 1 Ultra - Cápsulas … SuperHuman™", sku: "SH-8EN1" }],
    );
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("ok");
  });

  it("falls back to the free-text product when the guide has no linked order", () => {
    const s: FenixStockRow[] = [{ city: "trujillo", product: "Mushroom Coffee", quantity: 3 }];
    // no orderProducts (undefined or empty) → uses shipment.product
    expect(evaluateFenix({ city: "Trujillo", product: "Mushroom Coffee 180g" }, s).eligible).toBe(true);
    expect(evaluateFenix({ city: "Trujillo", product: "Otra cosa" }, s, []).eligible).toBe(false);
  });
});

describe("Fenix availability filters", () => {
  it("separates no-stock cases from cities outside coverage", () => {
    const noStock = { city: "Cusco", fenix_eligible: false, fenix_reason: "sin_stock" as const };
    const noCoverage = {
      city: "Piura",
      fenix_eligible: false,
      fenix_reason: "sin_cobertura" as const,
    };
    expect(currentFenixReason(noStock)).toBe("sin_stock");
    expect(matchesFenixAvailability(noStock, "sin_stock")).toBe(true);
    expect(matchesFenixAvailability(noStock, "sin_cobertura")).toBe(false);
    expect(matchesFenixAvailability(noCoverage, "sin_cobertura")).toBe(true);
  });

  it("classifies legacy false rows by known Fenix coverage", () => {
    expect(currentFenixReason({ city: "Arequipa", fenix_eligible: false })).toBe("sin_stock");
    expect(currentFenixReason({ city: "Piura", fenix_eligible: false })).toBe("sin_cobertura");
  });
});
