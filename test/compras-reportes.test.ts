// «Compras»: estadísticas de proveedores y reportes (MOM §45.7 y §45.8). Las
// reglas puras de lib/compras-reportes.ts sobre un juego de importaciones que
// cubre lo que la referencia (§6.17) pide y lo que no se copia:
//   - cotizaciones y canceladas NO cuentan como compras (ni unidades, ni
//     montos, ni días, ni a tiempo, ni costo por unidad); los pagos de una
//     cancelada no cuentan como pagados;
//   - el costo es el de `landedCosts` (el ejemplo A = 3,40 y B = 14,30);
//   - fechas de Lima, meses por el día del pedido o el del pago.

import { describe, expect, it } from "vitest";
import { landedCosts, type LandedCostRow } from "@/lib/compras";
import {
  isBought,
  lastMonths,
  landedOf,
  moneyInTransit,
  monthlySpend,
  normalizeProductName,
  onTimeIsLow,
  orderDateOf,
  productKey,
  shortageIsHigh,
  supplierBought,
  supplierRanking,
  supplierStats,
  unitCostHistory,
  unitCostTrend,
  type ReportImport,
  type ReportItem,
} from "@/lib/compras-reportes";

const STORE = "store-1";
const S1 = "sup-1";
const S2 = "sup-2";

const COSTS: LandedCostRow[] = [
  { kind: "importacion", label: "Aranceles", amount: 80, allocation: "value" },
  { kind: "envio", label: "Flete", amount: 120, allocation: "weight" },
  { kind: "adicional", label: "Inspección", amount: 30, allocation: "units" },
  { kind: "adicional", label: "Etiquetas B", amount: 25, allocation: "item", itemId: "i1-b" },
];

function item(p: Partial<ReportItem> & Pick<ReportItem, "id" | "name" | "qty">): ReportItem {
  return { sku: null, storeId: null, unitCostUsd: 0, unitWeightKg: null, receivedQty: null, damagedQty: null, ...p };
}

function imp(p: Partial<ReportImport> & Pick<ReportImport, "id" | "status">): ReportImport {
  return {
    code: `IMP-2026-${p.id}`,
    supplierId: S1,
    orderedOn: null,
    createdAt: "2026-01-01T15:00:00Z",
    eta: null,
    arrivedOn: null,
    fxPenPerUsd: null,
    items: [],
    costs: [],
    payments: [],
    ...p,
  };
}

const A = { sku: "SKU-A", storeId: STORE, name: "Audífonos A" };

const IMPORTS: ReportImport[] = [
  // I1: recibida a tiempo (17 días), el ejemplo de la referencia, con faltantes y dañadas en A.
  imp({
    id: "001",
    status: "recibido",
    orderedOn: "2026-09-01",
    eta: "2026-09-20",
    arrivedOn: "2026-09-18",
    fxPenPerUsd: 3.75,
    items: [
      item({ id: "i1-a", ...A, qty: 100, unitCostUsd: 2, unitWeightKg: 0.5, receivedQty: 95, damagedQty: 2 }),
      item({ id: "i1-b", sku: "SKU-B", storeId: STORE, name: "Batería B", qty: 50, unitCostUsd: 12, unitWeightKg: 0.2, receivedQty: 50, damagedQty: 0 }),
    ],
    costs: COSTS,
    payments: [
      { amount: 500, paidOn: "2026-09-02" },
      { amount: 400, paidOn: "2026-10-05" },
    ],
  }),
  // I2: en tránsito, sin tipo de cambio.
  imp({
    id: "002",
    status: "en_transito",
    orderedOn: "2026-10-10",
    eta: "2026-11-01",
    items: [item({ id: "i2-a", ...A, qty: 200, unitCostUsd: 2.1 })],
    payments: [{ amount: 100, paidOn: "2026-10-11" }],
  }),
  // I3: cotización: no es compra (pero su pago sí cuenta como pagado).
  imp({
    id: "003",
    status: "cotizacion",
    orderedOn: "2026-11-01",
    items: [item({ id: "i3-a", ...A, qty: 1000, unitCostUsd: 1 })],
    payments: [{ amount: 10, paidOn: "2026-11-02" }],
  }),
  // I4: cancelada (aunque tenga llegada y pago): no cuenta para nada.
  imp({
    id: "004",
    status: "cancelado",
    orderedOn: "2026-08-01",
    eta: "2026-08-20",
    arrivedOn: "2026-08-30",
    fxPenPerUsd: 3.7,
    items: [item({ id: "i4-c", sku: "SKU-C", name: "Cargador C", qty: 10, unitCostUsd: 5, receivedQty: 0, damagedQty: 0 })],
    payments: [{ amount: 50, paidOn: "2026-08-02" }],
  }),
  // I5: cerrada, llegó tarde (39 días), sin contar.
  imp({
    id: "005",
    status: "cerrado",
    orderedOn: "2026-06-01",
    eta: "2026-06-20",
    arrivedOn: "2026-07-10",
    fxPenPerUsd: 3.7,
    items: [item({ id: "i5-a", ...A, qty: 100, unitCostUsd: 2 })],
  }),
  // I6 (otro proveedor): pagada de más, activa.
  imp({
    id: "006",
    supplierId: S2,
    status: "pagado",
    orderedOn: "2026-11-03",
    fxPenPerUsd: 3.8,
    items: [item({ id: "i6-d", name: "Funda  iPhone-15", qty: 10, unitCostUsd: 10 })],
    payments: [{ amount: 120, paidOn: "2026-11-03" }],
  }),
  // I7 (otro proveedor): la misma funda sin SKU con otro nombre, y un cable que no llegó.
  imp({
    id: "007",
    supplierId: S2,
    status: "recibido",
    orderedOn: "2026-10-01",
    arrivedOn: "2026-10-21",
    items: [
      item({ id: "i7-d", name: "FUNDA IPHONE 15", qty: 10, unitCostUsd: 9, receivedQty: 10, damagedQty: 0 }),
      item({ id: "i7-e", name: "Cable", qty: 5, unitCostUsd: 3, receivedQty: 0, damagedQty: 0 }),
    ],
  }),
];

const close = (n: number | null | undefined, expected: number) => expect(n ?? NaN).toBeCloseTo(expected, 6);

describe("qué es una compra y qué día cuenta", () => {
  it("ni la cotización ni la cancelada cuentan como compra", () => {
    expect(isBought("cotizacion")).toBe(false);
    expect(isBought("cancelado")).toBe(false);
    for (const s of ["pagado", "en_produccion", "en_transito", "en_aduana", "en_camino_bodega", "recibido", "ingresado", "cerrado"] as const) {
      expect(isBought(s), s).toBe(true);
    }
  });

  it("el día del pedido; sin él, el día de Lima de la creación (no el UTC)", () => {
    expect(orderDateOf({ orderedOn: "2026-10-05", createdAt: "2026-10-09T15:00:00Z" })).toBe("2026-10-05");
    // 03:00 UTC del 1 de octubre son las 22:00 del 30 de septiembre en Lima.
    expect(orderDateOf({ orderedOn: null, createdAt: "2026-10-01T03:00:00Z" })).toBe("2026-09-30");
  });

  it("los meses terminan en el de hoy y cruzan el año", () => {
    expect(lastMonths("2026-02-10", 3)).toEqual(["2025-12", "2026-01", "2026-02"]);
    expect(lastMonths("2026-11-14", 12)).toHaveLength(12);
    expect(lastMonths("2026-11-14", 12)[0]).toBe("2025-12");
  });

  it("el costo es el de landedCosts, no otra cuenta (A = 3,40 y B = 14,30 del ejemplo)", () => {
    const i1 = { ...IMPORTS[0]!, items: IMPORTS[0]!.items.map((it) => ({ ...it, receivedQty: null, damagedQty: null })) };
    const landed = landedOf(i1);
    close(landed.byItem.get("i1-a")!.usd!.unitCost, 3.4);
    close(landed.byItem.get("i1-b")!.usd!.unitCost, 14.3);
    expect(landed.usd!.total).toBe(landedCosts(
      i1.items.map((it) => ({ id: it.id, qty: it.qty, unitCostUsd: it.unitCostUsd, unitWeightKg: it.unitWeightKg })),
      COSTS,
    ).usd!.total);
    // Con SU tipo de cambio: la vista en soles también.
    close(landed.pen!.total, 1055 * 3.75);
  });
});

describe("producto: SKU y tienda, o nombre normalizado", () => {
  it("normaliza el nombre sin tildes, mayúsculas ni signos", () => {
    expect(normalizeProductName("  Funda  iPhone-15 ÁÉ ")).toBe("funda iphone 15 ae");
    expect(productKey({ sku: null, storeId: null, name: "FUNDA IPHONE 15" })).toBe(productKey({ sku: "", storeId: STORE, name: "Funda  iPhone-15" }));
  });
  it("con SKU, el mismo SKU en otra tienda es otro producto", () => {
    expect(productKey({ sku: "sku-a", storeId: STORE, name: "x" })).toBe(productKey({ sku: " SKU-A ", storeId: STORE, name: "y" }));
    expect(productKey({ sku: "SKU-A", storeId: STORE, name: "x" })).not.toBe(productKey({ sku: "SKU-A", storeId: null, name: "x" }));
  });
});

describe("estadísticas del proveedor (§4.3, §6.17)", () => {
  const s1 = supplierStats(S1, IMPORTS, { money: true });

  it("importaciones: todas; compradas: sin cotización ni cancelada; la última de cualquiera", () => {
    expect(s1.imports).toBe(5);
    expect(s1.bought).toBe(3);
    expect(s1.lastOrderedOn).toBe("2026-11-01");
  });

  it("unidades y «Le compras» solo de las compradas (top 3 por unidades)", () => {
    expect(s1.units).toBe(450);
    expect(s1.topProducts.map((p) => [p.name, p.units])).toEqual([
      ["Audífonos A", 400],
      ["Batería B", 50],
    ]);
  });

  it("«Tarda»: promedio de días del pedido a la llegada de las compradas que llegaron", () => {
    // I1: 17 días; I5: 39 días. La cancelada (29 días) no entra.
    close(s1.avgLeadDays, 28);
    expect(s1.leadSamples).toBe(2);
  });

  it("«A tiempo»: llegó el día estimado o antes, entre las que tenían estimada; rojo bajo 70 %", () => {
    close(s1.onTimeShare, 0.5);
    expect(s1.onTimeSamples).toBe(2);
    expect(onTimeIsLow(s1.onTimeShare)).toBe(true);
    expect(onTimeIsLow(0.7)).toBe(false);
    expect(onTimeIsLow(null)).toBe(false);
  });

  it("«Faltantes y dañadas»: (faltan + dañadas) ÷ pedidas de las líneas contadas; rojo desde 3 %", () => {
    // Solo I1 está contada: A falta 5 y 2 dañadas; B completa → 7 / 150.
    close(s1.shortageShare, 7 / 150);
    expect(shortageIsHigh(s1.shortageShare)).toBe(true);
    expect(shortageIsHigh(0.0299)).toBe(false);
    expect(shortageIsHigh(0.03)).toBe(true);
    const s2 = supplierStats(S2, IMPORTS, { money: true });
    // I7: la funda completa y el cable no llegó (5 de 15). I6 sin contar no entra.
    close(s2.shortageShare, 5 / 15);
    expect(s2.onTimeShare).toBeNull();
    close(s2.avgLeadDays, 20);
  });

  it("«Comprado»: Σ costo aterrizado de las compradas, y en soles las que tienen tipo de cambio", () => {
    // I1 1055 + I2 420 + I5 200; ni la cotización (1000) ni la cancelada (50).
    close(s1.boughtUsd, 1675);
    close(s1.boughtPen, 1055 * 3.75 + 200 * 3.7);
    expect(s1.boughtWithoutFx).toBe(1);
  });

  it("sin «Montos de compras» no hay montos en el resultado", () => {
    const s = supplierStats(S1, IMPORTS, { money: false });
    expect(s).not.toHaveProperty("boughtUsd");
    expect(s).not.toHaveProperty("boughtPen");
    expect(s.units).toBe(450);
    close(s.onTimeShare, 0.5);
  });

  it("un proveedor sin importaciones: todo vacío, sin dividir entre cero", () => {
    const s = supplierStats("nadie", IMPORTS, { money: true });
    expect(s).toMatchObject({ imports: 0, bought: 0, lastOrderedOn: null, units: 0, avgLeadDays: null, onTimeShare: null, shortageShare: null, boughtUsd: 0 });
  });

  it("ranking por monto comprado, de mayor a menor", () => {
    // I2 e I7 no tienen tipo de cambio (todo en USD): no se pueden llevar a
    // soles, pero todas se pueden llevar a USD, así que el ranking va en USD.
    const ranking = supplierRanking([supplierStats(S2, IMPORTS, { money: true }), s1, supplierStats("nadie", IMPORTS, { money: true })]);
    expect(ranking.base).toBe("USD");
    expect(ranking.rows.map((r) => r.supplierId)).toEqual([S1, S2]);
    close(ranking.rows[1]!.amount, 100 + 105);
    close(ranking.rows[0]!.share, 1675 / 1880);
    // Sin soles a medias: a los dos les falta el tipo de cambio en alguna.
    expect(ranking.rows.map((r) => r.other)).toEqual([null, null]);
    expect(ranking.missingFx).toBe(0);
    expect(ranking.outside).toEqual([]);
  });
});

describe("dinero en camino (§6.17)", () => {
  it("activas que no son cotización; lo que falta pagar no se descuenta con lo pagado de más en otra", () => {
    const t = moneyInTransit(IMPORTS);
    expect(t.imports).toBe(2); // I2 e I6
    expect(t.units).toBe(210);
    close(t.totalUsd, 520);
    close(t.paidUsd, 220);
    close(t.pendingUsd, 320); // I2 falta 320; I6 pagó 20 de más y no resta.
    close(t.totalPen, 100 * 3.8);
    close(t.pendingPen, 0);
    expect(t.withoutFx).toBe(1);
  });
});

describe("por mes (§6.17)", () => {
  const months = monthlySpend(IMPORTS, "2026-11-14", 12);
  const at = (m: string) => months.find((r) => r.month === m)!;

  it("12 meses de Lima, del más viejo al actual", () => {
    expect(months.map((m) => m.month)[0]).toBe("2025-12");
    expect(months.map((m) => m.month)[11]).toBe("2026-11");
  });

  it("comprado por el mes del pedido, sin cotizaciones ni canceladas", () => {
    close(at("2026-06").boughtUsd, 200);
    close(at("2026-06").boughtPen, 740);
    close(at("2026-08").boughtUsd, 0); // la cancelada
    close(at("2026-09").boughtUsd, 1055);
    close(at("2026-10").boughtUsd, 420 + 105);
    expect(at("2026-10").imports).toBe(2);
    expect(at("2026-10").units).toBe(215);
    close(at("2026-11").boughtUsd, 100); // la cotización de 1000 no entra
  });

  it("pagado por el mes del pago, sin los de canceladas", () => {
    close(at("2026-08").paidUsd, 0);
    close(at("2026-09").paidUsd, 500);
    close(at("2026-09").paidPen, 500 * 3.75);
    close(at("2026-10").paidUsd, 400 + 100);
    close(at("2026-10").paidPen, 400 * 3.75);
    close(at("2026-11").paidUsd, 120 + 10);
  });
});

describe("costo por unidad de cada producto (§6.17)", () => {
  const products = unitCostHistory(IMPORTS);
  const byName = (n: string) => products.find((p) => p.name === n)!;

  it("un punto por importación comprada con unidades buenas; sin cotización ni cancelada", () => {
    const a = byName("Audífonos A");
    expect(a.points.map((p) => p.code)).toEqual(["IMP-2026-005", "IMP-2026-001", "IMP-2026-002"]);
    close(a.points[0]!.unitCostUsd, 2);
    // A en I1: 340 de costo aterrizado entre 93 buenas (95 recibidas − 2 dañadas).
    close(a.points[1]!.unitCostUsd, 340 / 93);
    close(a.points[1]!.unitCostPen, (340 / 93) * 3.75);
    expect(a.points[2]!.unitCostPen).toBeNull();
    expect(products.find((p) => p.name === "Cargador C")).toBeUndefined();
    // El cable no tuvo unidades buenas: no hay punto.
    expect(products.find((p) => p.name === "Cable")).toBeUndefined();
  });

  it("último, anterior y cambio = último ÷ anterior − 1; verde si baja más de 2 %", () => {
    const a = byName("Audífonos A");
    expect(a.last.code).toBe("IMP-2026-002");
    expect(a.previous!.code).toBe("IMP-2026-001");
    close(a.change, 2.1 / (340 / 93) - 1);
    expect(a.trend).toBe("down");
  });

  it("sin SKU se une por nombre normalizado; rojo si sube más de 2 %; el nombre es el de la más reciente", () => {
    const funda = byName("Funda  iPhone-15");
    expect(funda.points.map((p) => p.code)).toEqual(["IMP-2026-007", "IMP-2026-006"]);
    close(funda.change, 10 / 9 - 1);
    expect(funda.trend).toBe("up");
  });

  it("un solo punto: sin anterior ni cambio", () => {
    const b = byName("Batería B");
    close(b.last.unitCostUsd, 14.3);
    expect(b.previous).toBeNull();
    expect(b.change).toBeNull();
    expect(b.trend).toBeNull();
  });

  it("el umbral es 2 %: más de eso marca, hasta eso no", () => {
    expect(unitCostTrend(0.02)).toBe("flat");
    expect(unitCostTrend(0.0201)).toBe("up");
    expect(unitCostTrend(-0.02)).toBe("flat");
    expect(unitCostTrend(-0.0201)).toBe("down");
  });

  it("el más reciente primero", () => {
    expect(products[0]!.last.date >= products[products.length - 1]!.last.date).toBe(true);
  });
});

describe("«Comprado» y el ranking en una base comparable (MOM §45.7, §45.8)", () => {
  // Un laboratorio local todo en soles (sin tipo de cambio: no le hace falta) y
  // un proveedor de China con tipo de cambio.
  const LAB = "lab";
  const CN = "cn";
  const CN2 = "cn-sin-tc";
  const local = (p: Partial<ReportImport> & Pick<ReportImport, "id">) =>
    imp({
      status: "recibido",
      kind: "local",
      code: `LOC-2026-${p.id}`,
      supplierId: LAB,
      orderedOn: "2026-11-01",
      items: [item({ id: `l-${p.id}`, name: "Crema", sku: "CREMA-1", qty: 600, unitCostPen: 7.5, unitCostCurrency: "PEN", receivedQty: 600, damagedQty: 0 })],
      ...p,
    });
  const china = (p: Partial<ReportImport> & Pick<ReportImport, "id">) =>
    imp({ status: "recibido", supplierId: CN, orderedOn: "2026-10-01", fxPenPerUsd: 3.75, items: [item({ id: `c-${p.id}`, name: "Funda", qty: 100, unitCostUsd: 2 })], ...p });
  const stats = (id: string, list: ReportImport[]) => supplierStats(id, list, { money: true });

  it("el laboratorio local todo en soles entra en soles, sin tipo de cambio; sin USD a medias", () => {
    const v = supplierBought(stats(LAB, [local({ id: "001" })]));
    expect(v).toEqual({ base: "PEN", amount: 4500, other: null, missingFx: 0, otherMissingFx: 1 });
  });

  it("con tipo de cambio en todas: en soles y su equivalente en USD", () => {
    const v = supplierBought(stats(CN, [china({ id: "101" })]));
    expect(v.base).toBe("PEN");
    close(v.amount, 750);
    close(v.other, 200);
    expect(v.missingFx).toBe(0);
  });

  it("todo en USD y alguna sin tipo de cambio: en USD (lo de antes), sin soles a medias, y se dice cuántas", () => {
    const v = supplierBought(stats(CN, [china({ id: "101" }), china({ id: "102", fxPenPerUsd: null })]));
    expect(v).toEqual({ base: "USD", amount: 400, other: null, missingFx: 0, otherMissingFx: 1 });
  });

  it("ni soles ni USD alcanzan a todas: la que alcanza a más (empate: soles) y las de fuera contadas", () => {
    const list = [
      local({ id: "001", supplierId: "mixto" }),
      china({ id: "102", supplierId: "mixto", fxPenPerUsd: null }),
    ];
    const v = supplierBought(stats("mixto", list));
    expect(v).toEqual({ base: "PEN", amount: 4500, other: null, missingFx: 1, otherMissingFx: 1 });
  });

  it("USD con costos en soles y sin tipo de cambio: no se puede valorar, «Falta el tipo de cambio»", () => {
    const v = supplierBought(
      stats(CN, [china({ id: "103", fxPenPerUsd: null, costs: [{ kind: "importacion", label: "DHL", amount: 427.25, currency: "PEN", allocation: "value" }] })]),
    );
    expect(v).toEqual({ base: null, amount: null, other: null, missingFx: 1, otherMissingFx: 1 });
  });

  it("sin «Montos de compras» no hay nada que mostrar ni rankear", () => {
    const s = supplierStats(LAB, [local({ id: "001" })], { money: false });
    expect(supplierBought(s).base).toBeNull();
    expect(supplierRanking([s]).rows).toEqual([]);
  });

  it("el ranking va en soles cuando todas se pueden llevar a soles: el laboratorio local aparece", () => {
    const list = [local({ id: "001" }), china({ id: "101" })];
    const r = supplierRanking([stats(CN, list), stats(LAB, list)]);
    expect(r.base).toBe("PEN");
    expect(r.rows.map((x) => [x.supplierId, x.amount])).toEqual([
      [LAB, 4500],
      [CN, 750],
    ]);
    close(r.total, 5250);
    close(r.rows[0]!.share, 4500 / 5250);
    // El equivalente en USD solo de quien tiene con qué convertir todas.
    expect(r.rows[0]!.other).toBeNull();
    close(r.rows[1]!.other, 200);
    expect(r.missingFx).toBe(0);
  });

  it("un local sin tipo de cambio y una importación sin tipo de cambio: soles, la importación fuera y contada", () => {
    const list = [local({ id: "001" }), china({ id: "102", supplierId: CN2, fxPenPerUsd: null })];
    const r = supplierRanking([stats(LAB, list), stats(CN2, list)]);
    expect(r.base).toBe("PEN");
    expect(r.rows.map((x) => x.supplierId)).toEqual([LAB]);
    expect(r.outside).toEqual([{ supplierId: CN2, bought: 1 }]);
    expect(r.missingFx).toBe(1);
  });

  it("una fila con compras fuera de la base las cuenta en su fila; no se suman a medias en el total", () => {
    const list = [local({ id: "001" }), local({ id: "002", kind: "importacion", code: "IMP-2026-002", items: [item({ id: "x", name: "Tela", qty: 10, unitCostUsd: 5 })] })];
    const r = supplierRanking([stats(LAB, list)]);
    expect(r.base).toBe("PEN");
    expect(r.rows[0]).toMatchObject({ supplierId: LAB, amount: 4500, other: null, missingFx: 1 });
    expect(r.missingFx).toBe(1);
  });
});
