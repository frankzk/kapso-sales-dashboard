import { describe, it, expect } from "vitest";
import {
  flattenCatalog,
  normalizeSku,
  resolveAliclikItems,
  type AliclikSkuMapRow,
  type AliclikSkuRow,
  type OrderLineInput,
} from "@/lib/aliclik-catalog";

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
    expect(res.items).toEqual([
      { ean: "1480110110503", quantity: 1, price: 100, title: "Laptop", stockVirtual: 10 },
    ]);
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
