import { describe, it, expect } from "vitest";
import {
  coverageInputOf,
  currentFenixReason,
  evaluateDirectFenixStock,
  evaluateFenix,
  FENIX_COVERAGE_COLUMNS,
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

  // Este es EL camino que decide en la cola: el servidor guarda su resultado en
  // `fenix_reason`, y `currentFenixReason` se corta ahí. Arreglar sólo aquella
  // no cambiaba nada de lo que se ve —lo comprobamos en producción con
  // AUR5X392242419936 (#KP130479), que siguió saliendo «fuera de cobertura»
  // después del primer intento.
  describe("con `city` vacía deriva del destino, igual que la creación de guía", () => {
    it("resuelve la ciudad y llega a evaluar el stock", () => {
      const r = evaluateFenix(
        { city: "", district: "Cusco", province: "Cusco", product: "SUPER HUMAN Ethiopian Black Seed Oil" },
        stock,
      );
      expect(r.city).toBe("cusco");
      expect(r.reason).toBe("ok");
      expect(r.eligible).toBe(true);
    });

    it("cobertura sin stock dice sin_stock, no sin_cobertura", () => {
      const r = evaluateFenix(
        { city: "", district: "Arequipa", province: "Arequipa", product: "Pulsera Magnética" },
        stock,
      );
      expect(r.reason).toBe("sin_stock");
    });

    it("un destino de verdad fuera de cobertura sigue estándolo", () => {
      const r = evaluateFenix(
        { city: "", district: "Tacna", province: "Tacna", product: "Mushroom Coffee" },
        stock,
      );
      expect(r.reason).toBe("sin_cobertura");
    });

    it("sin `city` y sin destino no hay nada que derivar", () => {
      expect(evaluateFenix({ city: "", product: "Mushroom Coffee" }, stock).reason).toBe(
        "sin_cobertura",
      );
    });

    it("cuando `city` viene cargada manda ella: derivar taparía localityMismatch", () => {
      const r = evaluateFenix(
        { city: "Lima", district: "Cusco", province: "Cusco", product: "SUPER HUMAN Ethiopian Black Seed Oil" },
        stock,
      );
      expect(r.city).toBe("lima");
      expect(r.reason).toBe("sin_cobertura");
    });
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

/**
 * `evaluateFenix` ya sabía derivar del distrito; lo que faltaba era que los
 * llamadores le pasaran el destino. Las rejas de escritura seleccionaban `city`
 * a secas, así que la cola decía «Fenix Ok» y el botón «Fenix no tiene cobertura
 * en la ciudad indicada» sobre el MISMO envío —#KP130656, Arequipa, con `city`
 * NULL porque el alta vino por la API de Aliclik (219 envíos así, 85 pendientes)—.
 * Esto fija la pieza que lo destapó.
 */
describe("coverageInputOf: el destino de una fila de `shipments`", () => {
  it("una guía del alta por API resuelve igual que una del portal", () => {
    // Tal cual está en la base: city NULL, el resto con el dato.
    const porApi = coverageInputOf({
      city: null,
      district: "Arequipa",
      province: "Arequipa",
      region: "Arequipa",
      product: "Pulsera Magnética",
    });
    expect(evaluateFenix(porApi, stock).city).toBe("arequipa");
    expect(evaluateFenix(porApi, stock).reason).toBe("sin_stock"); // cubierta, sin unidades
  });

  it("cae a `region` cuando `province` está vacía —la columna llegó en la 0039—", () => {
    const historica = coverageInputOf({ city: null, district: "Cusco", province: null, region: "Cusco" });
    expect(historica.province).toBe("Cusco");
    expect(evaluateFenix({ ...historica, product: "SUPER HUMAN Ethiopian Black Seed Oil" }, stock).eligible)
      .toBe(true);
  });

  it("`province` manda sobre `region` cuando las dos vienen", () => {
    expect(coverageInputOf({ province: "Arequipa", region: "Cusco" }).province).toBe("Arequipa");
  });

  it("no inventa provincia cuando no hay ninguna de las dos", () => {
    expect(coverageInputOf({ city: null, district: "Arequipa" }).province).toBeNull();
  });

  // El select se arma con esta constante. Si alguien le saca una columna, la
  // cobertura vuelve a decidirse con datos incompletos —que es exactamente el
  // bug— y aquí se ve antes de que llegue a producción.
  it("FENIX_COVERAGE_COLUMNS nombra las cuatro columnas del destino", () => {
    expect(FENIX_COVERAGE_COLUMNS.split(",").sort()).toEqual(
      ["city", "district", "province", "region"],
    );
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

  describe("cuando `city` viene vacía", () => {
    // Caso real: AUR5X392242419936 (#KP130479), dada de alta por la API de
    // Aliclik. `city` vacía, distrito/provincia «Arequipa». La cola la mostraba
    // fuera de cobertura y nadie la intentaba, aunque hubiera stock.
    it("deriva del distrito y la provincia en vez de darla por sin cobertura", () => {
      expect(
        currentFenixReason({
          city: "",
          district: "Arequipa",
          province: "Arequipa",
          fenix_eligible: false,
        }),
      ).toBe("sin_stock");
    });

    it("también con city null o solo espacios", () => {
      for (const city of [null, undefined, "   "]) {
        expect(
          currentFenixReason({ city, district: "Cusco", province: "Cusco", fenix_eligible: false }),
          String(city),
        ).toBe("sin_stock");
      }
    });

    it("sin cobertura sigue siendo sin cobertura: no inventa una ciudad", () => {
      expect(
        currentFenixReason({ city: "", district: "Tacna", province: "Tacna", fenix_eligible: false }),
      ).toBe("sin_cobertura");
    });

    it("hereda la cobertura del departamento, igual que la creación de guía", () => {
      // Camaná es otra provincia de Arequipa, y aun así deriva a `arequipa`:
      // deriveFenixCoverageCity escanea la etiqueta combinada buscando un token
      // de ciudad conocida, y ese es su comportamiento documentado. No se
      // corrige acá a propósito — el punto de este cambio es que la pantalla
      // responda LO MISMO que el despacho, no algo distinto pero más estricto.
      //
      // Lo que frena de verdad un destino así es el ubigeo al crear la guía:
      // resolveUbigeo("arequipa","Camaná") devuelve exact=false y el envío se
      // rechaza con un mensaje explícito, en vez de salir con un código
      // aproximado que desviaría el paquete.
      expect(
        currentFenixReason({ city: "", district: "Camaná", province: "Arequipa", fenix_eligible: false }),
      ).toBe("sin_stock");
    });

    it("sin ningún dato de destino no hay nada que derivar", () => {
      expect(currentFenixReason({ city: "", fenix_eligible: false })).toBe("sin_cobertura");
    });
  });

  it("cuando `city` viene cargada MANDA ella: derivar taparía localityMismatch", () => {
    // El courier puede contradecir a Shopify —«cusco» contra «Juliaca · Puno»—
    // y esa discrepancia la reporta localityMismatch(). Si acá se derivara por
    // encima de un dato presente, la pantalla mostraría la cobertura del
    // destino equivocado y el conflicto no se vería.
    expect(
      currentFenixReason({
        city: "Tacna",
        district: "Arequipa",
        province: "Arequipa",
        fenix_eligible: false,
      }),
    ).toBe("sin_cobertura");
  });

  it("una razón ya calculada en el servidor gana sobre cualquier derivación", () => {
    expect(
      currentFenixReason({
        city: "",
        district: "Arequipa",
        province: "Arequipa",
        fenix_eligible: false,
        fenix_reason: "sin_cobertura",
      }),
    ).toBe("sin_cobertura");
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
