import { describe, it, expect } from "vitest";
import {
  currentFenixReason,
  evaluateDirectFenixStock,
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

  // Localidades satélite: Fenix llega, pero el stock está en el almacén de al
  // lado. Sin la tabla de alias caían a su propia clave —que no existe en
  // fenix_stock— y salían como «Fuera de cobertura» aunque el reparto las
  // cubriera. El caso real: AUR5X221995919245, Chupaca (Junín).
  it("EL CASO: Chupaca tira del almacén de Huancayo", () => {
    const h: FenixStockRow[] = [{ city: "huancayo", product: "Black Seed Oil", quantity: 4 }];
    const r = evaluateFenix({ city: "Chupaca", product: "Black Seed Oil" }, h);
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("ok");
  });

  it("una satélite sin stock en su almacén dice sin_stock, no sin_cobertura", () => {
    // El matiz importa en la UI: «sin stock» se resuelve reponiendo; «fuera de
    // cobertura» dice que ni vale la pena intentarlo.
    const h: FenixStockRow[] = [{ city: "huancayo", product: "Otro", quantity: 4 }];
    expect(evaluateFenix({ city: "Chupaca", product: "Black Seed Oil" }, h).reason).toBe("sin_stock");
  });

  it("San Román tira del almacén de Juliaca", () => {
    const j: FenixStockRow[] = [{ city: "juliaca", product: "X", quantity: 2 }];
    expect(evaluateFenix({ city: "San Román", product: "X" }, j).eligible).toBe(true);
    expect(evaluateFenix({ city: "San Roman", product: "X" }, j).eligible).toBe(true);
  });

  it("una localidad satélite sale del stock de su almacén, no de una propia", () => {
    // Cargar stock a nombre de la satélite lo pone donde no está: el almacén es
    // el de Huancayo y es ahí donde se compara.
    const enChupaca: FenixStockRow[] = [{ city: "chupaca", product: "X", quantity: 9 }];
    expect(evaluateFenix({ city: "Huancayo", product: "X" }, enChupaca).eligible).toBe(true);
  });

  it("las que la operación descartó siguen fuera de cobertura", () => {
    // Jauja, Chepén y Chala están cerca de un almacén y aun así Fenix no las
    // reparte. La cercanía no es el criterio; la tabla solo crece con lo que
    // confirme la operación.
    const todo: FenixStockRow[] = [
      { city: "huancayo", product: "X", quantity: 9 },
      { city: "trujillo", product: "X", quantity: 9 },
      { city: "arequipa", product: "X", quantity: 9 },
    ];
    for (const c of ["Jauja", "Chepén", "Chala"]) {
      expect(evaluateFenix({ city: c, product: "X" }, todo).reason).toBe("sin_cobertura");
    }
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
    // Piura servía de ejemplo de «fuera de cobertura» hasta que entró al
    // catálogo. El caso que se prueba es la ciudad que NO está en él, así que
    // el ejemplo se muda; con Piura adentro, una fila vieja suya pasa a leerse
    // «sin stock», que es lo correcto ahora.
    expect(currentFenixReason({ city: "Tacna", fenix_eligible: false })).toBe("sin_cobertura");
    expect(currentFenixReason({ city: "Piura", fenix_eligible: false })).toBe("sin_stock");
  });
});

describe("evaluateDirectFenixStock (gate de guía directa: TODOS los ítems)", () => {
  const stock: FenixStockRow[] = [
    { city: "arequipa", product: "8 en 1 Ultra SuperHuman", sku: "SH-8EN1", quantity: 2 },
    { city: "arequipa", product: "Mushroom Coffee", sku: null, quantity: 1 },
    { city: "arequipa", product: "Colágeno Hidrolizado", sku: "SH-COL", quantity: 0 },
    { city: "juliaca", product: "Pulsera Magnética", sku: "PULSERA", quantity: 3 },
  ];

  it("ok cuando todos los line items tienen stock en la ciudad", () => {
    const r = evaluateDirectFenixStock("Arequipa", stock, [
      { title: "8 en 1 Ultra - Cápsulas SuperHuman™", sku: "SH-8EN1", quantity: 1 },
      { title: "Mushroom Coffee 180g", sku: null, quantity: 2 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.city).toBe("arequipa");
    expect(r.uncovered).toEqual([]);
  });

  it("sin_stock si CUALQUIER ítem no tiene stock (aunque otro sí) y lista cuál", () => {
    const r = evaluateDirectFenixStock("Arequipa", stock, [
      { title: "Mushroom Coffee", sku: null, quantity: 1 },
      { title: "Producto inexistente", sku: null, quantity: 1 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("sin_stock");
    expect(r.uncovered).toEqual(["Producto inexistente"]);
  });

  it("un renglón con saldo 0 no cubre (Colágeno agotado)", () => {
    const r = evaluateDirectFenixStock("Arequipa", stock, [
      { title: "Colágeno Hidrolizado", sku: "SH-COL", quantity: 1 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("sin_stock");
    expect(r.uncovered).toEqual(["Colágeno Hidrolizado"]);
  });

  it("prefiere el match por SKU exacto sobre el difuso por título", () => {
    const r = evaluateDirectFenixStock("Arequipa", stock, [
      { title: "nombre que no matchea nada", sku: "SH-8EN1", quantity: 1 },
    ]);
    expect(r.ok).toBe(true);
  });

  it("destino Puno valida contra stock de Juliaca (almacén compartido)", () => {
    const r = evaluateDirectFenixStock("Puno", stock, [
      { title: "Pulsera Magnética", sku: "PULSERA", quantity: 1 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.city).toBe("puno");
  });

  it("sin_cobertura para una ciudad desconocida sin renglones de stock", () => {
    const r = evaluateDirectFenixStock("Miraflores", stock, [
      { title: "Mushroom Coffee", sku: null, quantity: 1 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("sin_cobertura");
  });

  it("sin_cobertura cuando no hay distrito/ciudad en el pedido", () => {
    const r = evaluateDirectFenixStock(null, stock, [{ title: "Mushroom Coffee", quantity: 1 }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("sin_cobertura");
  });

  it("pedido sin line items se valida con un ítem vacío (no pasa sin match)", () => {
    const r = evaluateDirectFenixStock("Arequipa", stock, []);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("sin_stock");
    expect(r.uncovered).toEqual(["(producto sin nombre)"]);
  });
});
