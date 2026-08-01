import { describe, it, expect } from "vitest";
import {
  collectActiveShopifyCatalogDetails,
  collectShopifySkuDetails,
  flattenCatalog,
  hydrateOrderLineSkusFromCatalog,
  normalizeSku,
  resolveAliclikItems,
  type AliclikSkuMapRow,
  type AliclikSkuRow,
  type OrderLineInput,
} from "@/lib/aliclik-catalog";

describe("hydrateOrderLineSkusFromCatalog", () => {
  const astaxantina = {
    productId: "gid://shopify/Product/100",
    productTitle: "ASTAXANTINA - Antioxidante De Alta Potencia (120 Cápsulas)",
    variantId: "gid://shopify/ProductVariant/200",
    variantTitle: null,
    sku: "69995815",
    inventory: 81,
  };

  it("recupera el SKU actual por variant_id para un pedido histórico", () => {
    const [result] = hydrateOrderLineSkusFromCatalog(
      [line({ title: astaxantina.productTitle, sku: null, variantId: "200" })],
      [astaxantina],
    );
    expect(result?.sku).toBe("69995815");
  });

  it("recupera el SKU de un producto inequívoco aunque el pedido no tenga IDs", () => {
    const [result] = hydrateOrderLineSkusFromCatalog(
      [line({ title: astaxantina.productTitle, sku: null })],
      [astaxantina],
    );
    expect(result?.sku).toBe("69995815");
  });

  it("no adivina cuando dos variantes del mismo producto tienen SKUs distintos", () => {
    const [result] = hydrateOrderLineSkusFromCatalog(
      [line({ title: "CloudSlides", sku: null })],
      [
        { ...astaxantina, productTitle: "CloudSlides", variantTitle: "Negro", sku: "NEGRO" },
        { ...astaxantina, variantId: "gid://shopify/ProductVariant/201", productTitle: "CloudSlides", variantTitle: "Beige", sku: "BEIGE" },
      ],
    );
    expect(result?.sku).toBeNull();
  });
});

describe("collectActiveShopifyCatalogDetails", () => {
  it("mantiene visible Astaxantina activa aunque Shopify no le haya asignado SKU", () => {
    const details = collectActiveShopifyCatalogDetails([
      {
        productId: "gid://shopify/Product/asta",
        productTitle: "ASTAXANTINA - Antioxidante De Alta Potencia (120 Capsulas)",
        variantId: "gid://shopify/ProductVariant/asta-default",
        variantTitle: null,
        sku: null,
        inventory: 81,
      },
    ]);

    expect([...details.values()]).toEqual([
      {
        shopifySku: null,
        title: "ASTAXANTINA - Antioxidante De Alta Potencia (120 Capsulas)",
        variantTitle: null,
        productId: "gid://shopify/Product/asta",
        variantId: "gid://shopify/ProductVariant/asta-default",
      },
    ]);
  });
});

describe("collectShopifySkuDetails", () => {
  it("recupera talla y color del payload REST histórico por SKU", () => {
    const details = collectShopifySkuDetails([
      {
        line_items: [
          { sku: "30647718", title: "CloudSlides", variant_title: null },
        ],
        raw: {
          line_items: [
            {
              sku: "30647718",
              title: "CloudSlides",
              variant_title: "38-39 / Negro",
            },
          ],
        },
      },
    ]);

    expect(details.get("30647718")).toEqual({
      shopifySku: "30647718",
      title: "CloudSlides",
      variantTitle: "38-39 / Negro",
      productId: null,
      variantId: null,
    });
  });

  it("no reemplaza una variante conocida por un registro incompleto posterior", () => {
    const details = collectShopifySkuDetails([
      {
        line_items: [
          {
            sku: "30647721",
            title: "CloudSlides",
            variant_title: "38-39 / Beige",
          },
        ],
        raw: null,
      },
      {
        line_items: [
          { sku: "30647721", title: "CloudSlides", variant_title: null },
        ],
        raw: null,
      },
    ]);

    expect(details.get("30647721")?.variantTitle).toBe("38-39 / Beige");
  });
});

const sku = (over: Partial<AliclikSkuRow> = {}): AliclikSkuRow => ({
  ean: "1480110110503",
  sku: "LAP-14",
  product_name: "Laptop",
  stock_virtual: 10,
  warehouse_id: 210,
  warehouse_name: "Lima Centro",
  format_time_agency: "13:00",
  shalom_origin_in: "CHOSICA",
  is_agency_eligible: true,
  ...over,
});

const line = (over: Partial<OrderLineInput> = {}): OrderLineInput => ({
  title: "Laptop",
  sku: "LAP-14",
  quantity: 1,
  price: 100,
  ...over,
});

const map = (rows: [string, string][]): AliclikSkuMapRow[] =>
  rows.map(([shopify_sku, ean]) => ({ shopify_sku, ean }));

describe("normalizeSku", () => {
  it("recorta y pasa a mayúsculas para que 'abc ' y 'ABC' sean el mismo SKU", () => {
    expect(normalizeSku(" abc ")).toBe("ABC");
    expect(normalizeSku(null)).toBe("");
  });
});

describe("resolveAliclikItems — camino feliz", () => {
  it("resuelve EAN, almacén y cantidades", () => {
    const res = resolveAliclikItems([line()], map([["LAP-14", "1480110110503"]]), [sku()], {
      modality: "cod",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warehouseId).toBe(210);
    expect(res.warehouseName).toBe("Lima Centro");
    expect(res.warehouseCandidates).toEqual([{ id: 210, name: "Lima Centro" }]);
    expect(res.items).toEqual([
      { ean: "1480110110503", quantity: 1, price: 100, title: "Laptop", stockVirtual: 10 },
    ]);
  });

  it("prioriza el almacén operativo aunque Postgres entregue primero otro almacén", () => {
    const mapped = map([
      ["LAP-14", "1480110110503"],
      ["MOU-1", "2220000000001"],
    ]);
    const res = resolveAliclikItems(
      [line()],
      mapped,
      [
        sku({ warehouse_id: 183, warehouse_name: "NIBRESMA" }),
        sku({ warehouse_id: 133, warehouse_name: "GRUPO GF" }),
        sku({
          ean: "2220000000001",
          sku: "MOU-1",
          warehouse_id: 133,
          warehouse_name: "GRUPO GF",
        }),
      ],
      { modality: "cod" },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warehouseId).toBe(133);
    expect(res.warehouseName).toBe("GRUPO GF");
    expect(res.warehouseCandidates).toEqual([
      { id: 133, name: "GRUPO GF" },
      { id: 183, name: "NIBRESMA" },
    ]);
  });

  it("solo ofrece almacenes de respaldo que contienen todos los EAN", () => {
    const res = resolveAliclikItems(
      [line(), line({ title: "Mouse", sku: "MOU-1" })],
      map([
        ["LAP-14", "1480110110503"],
        ["MOU-1", "2220000000001"],
      ]),
      [
        sku({ warehouse_id: 133, warehouse_name: "GRUPO GF" }),
        sku({ warehouse_id: 183, warehouse_name: "NIBRESMA" }),
        sku({
          ean: "2220000000001",
          sku: "MOU-1",
          warehouse_id: 133,
          warehouse_name: "GRUPO GF",
        }),
      ],
      { modality: "cod" },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warehouseCandidates).toEqual([{ id: 133, name: "GRUPO GF" }]);
  });

  it("empareja el SKU sin importar mayúsculas ni espacios", () => {
    const res = resolveAliclikItems(
      [line({ sku: " lap-14 " })],
      map([["LAP-14", "1480110110503"]]),
      [sku()],
      { modality: "cod" },
    );
    expect(res.ok).toBe(true);
  });

  it("agrega dos líneas del mismo EAN en un solo item", () => {
    const res = resolveAliclikItems(
      [line({ quantity: 2 }), line({ quantity: 3 })],
      map([["LAP-14", "1480110110503"]]),
      [sku({ stock_virtual: 50 })],
      { modality: "cod" },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.quantity).toBe(5);
  });

  it("ignora las líneas de cantidad cero", () => {
    const res = resolveAliclikItems(
      [line(), line({ quantity: 0, sku: "OTRO" })],
      map([["LAP-14", "1480110110503"]]),
      [sku()],
      { modality: "cod" },
    );
    expect(res.ok).toBe(true);
  });
});

describe("resolveAliclikItems — bloqueos", () => {
  it("sin líneas", () => {
    const res = resolveAliclikItems([], [], [], { modality: "cod" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.blocker.kind).toBe("sin_lineas");
  });

  it("sin SKU en Shopify", () => {
    const res = resolveAliclikItems([line({ sku: null })], [], [], { modality: "cod" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.blocker.kind).toBe("sin_sku");
    expect(res.blocker.offenders).toContain("Laptop");
  });

  it("SKU sin mapear, nombrando el SKU concreto", () => {
    const res = resolveAliclikItems([line()], [], [sku()], { modality: "cod" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.blocker.kind).toBe("sku_sin_mapeo");
    expect(res.blocker.offenders[0]).toContain("LAP-14");
  });

  it("EAN mapeado que ya no está en el catálogo", () => {
    const res = resolveAliclikItems([line()], map([["LAP-14", "9999"]]), [sku()], {
      modality: "cod",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.blocker.kind).toBe("ean_desconocido");
  });

  it("almacenes distintos: hay que dividir el pedido", () => {
    const res = resolveAliclikItems(
      [line(), line({ sku: "MOU-1", title: "Mouse" })],
      map([
        ["LAP-14", "1480110110503"],
        ["MOU-1", "2220000000001"],
      ]),
      [
        sku(),
        sku({ ean: "2220000000001", sku: "MOU-1", warehouse_id: 311, warehouse_name: "Chorrillos" }),
      ],
      { modality: "cod" },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.blocker.kind).toBe("multi_almacen");
    expect(res.blocker.message).toContain("Lima Centro");
    expect(res.blocker.message).toContain("Chorrillos");
  });

  it("catálogo sin almacén", () => {
    const res = resolveAliclikItems([line()], map([["LAP-14", "1480110110503"]]), [sku({ warehouse_id: null })], {
      modality: "cod",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.blocker.kind).toBe("sin_almacen");
  });

  it("precio inválido", () => {
    const res = resolveAliclikItems(
      [line({ price: null })],
      map([["LAP-14", "1480110110503"]]),
      [sku()],
      { modality: "cod" },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.blocker.kind).toBe("precio_invalido");
  });
});

describe("resolveAliclikItems — reglas propias de agencia", () => {
  it("bloquea un SKU no habilitado para Shalom", () => {
    const res = resolveAliclikItems(
      [line()],
      map([["LAP-14", "1480110110503"]]),
      [sku({ is_agency_eligible: false })],
      { modality: "agency" },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.blocker.kind).toBe("no_apto_agencia");
  });

  it("el mismo SKU sí pasa en contraentrega", () => {
    const res = resolveAliclikItems(
      [line()],
      map([["LAP-14", "1480110110503"]]),
      [sku({ is_agency_eligible: false })],
      { modality: "cod" },
    );
    expect(res.ok).toBe(true);
  });

  it("aplica el tope de 6 unidades", () => {
    const res = resolveAliclikItems(
      [line({ quantity: 7 })],
      map([["LAP-14", "1480110110503"]]),
      [sku({ stock_virtual: 100 })],
      { modality: "agency" },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.blocker.kind).toBe("max_6_unidades");
    expect(res.blocker.message).toContain("7");
  });

  it("6 unidades exactas sí pasan", () => {
    const res = resolveAliclikItems(
      [line({ quantity: 6 })],
      map([["LAP-14", "1480110110503"]]),
      [sku({ stock_virtual: 100 })],
      { modality: "agency" },
    );
    expect(res.ok).toBe(true);
  });

  it("el tope de 6 no existe en contraentrega", () => {
    const res = resolveAliclikItems(
      [line({ quantity: 20 })],
      map([["LAP-14", "1480110110503"]]),
      [sku({ stock_virtual: 100 })],
      { modality: "cod" },
    );
    expect(res.ok).toBe(true);
  });
});

describe("resolveAliclikItems — stock", () => {
  it("bloquea en agencia, porque Aliclik lo exige en su servidor", () => {
    const res = resolveAliclikItems(
      [line({ quantity: 5 })],
      map([["LAP-14", "1480110110503"]]),
      [sku({ stock_virtual: 2 })],
      { modality: "agency" },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.blocker.kind).toBe("sin_stock");
  });

  it("solo avisa en contraentrega: el espejo puede estar desfasado", () => {
    const res = resolveAliclikItems(
      [line({ quantity: 5 })],
      map([["LAP-14", "1480110110503"]]),
      [sku({ stock_virtual: 2 })],
      { modality: "cod" },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("Stock ajustado");
  });
});

describe("flattenCatalog", () => {
  it("aplana productos y marca la elegibilidad de agencia", () => {
    const rows = flattenCatalog(
      [
        {
          id: 101,
          name: "Laptop",
          category: "Tecnología",
          skus: [
            { sku: "LAP-14", ean: "148", stockVirtual: 3, warehouseId: 210, formatTimeAgency: "13:00" },
          ],
        },
      ],
      true,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ean: "148",
      sku: "LAP-14",
      product_name: "Laptop",
      warehouse_id: 210,
      format_time_agency: "13:00",
      is_agency_eligible: true,
    });
  });

  it("descarta SKUs sin EAN — sin EAN no se puede pedir", () => {
    const rows = flattenCatalog([{ id: 1, name: "X", skus: [{ sku: "A", ean: null }] }], false);
    expect(rows).toHaveLength(0);
  });
});
