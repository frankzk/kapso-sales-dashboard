import { describe, expect, it } from "vitest";
import {
  computeAdditionalCosts,
  computeLogisticsCost,
  costDay,
  isEffectiveOn,
  resolveProductCost,
  resolveTariff,
  specificity,
  type AdditionalCost,
  type CostContext,
  type CostTariff,
  type ProductCost,
} from "@/lib/costs";

const STORE = "store-a";

function tariff(over: Partial<CostTariff> = {}): CostTariff {
  return {
    id: over.id ?? "t1",
    store_id: null,
    courier: null,
    region: null,
    province: null,
    district: null,
    concept: "primer_intento",
    amount: 10,
    effective_from: "2026-01-01",
    effective_to: null,
    ...over,
  };
}

const CTX: CostContext = {
  storeId: STORE,
  courier: "aliclik",
  region: "Junín",
  province: "Huancayo",
  district: "El Tambo",
};

describe("vigencia", () => {
  it("una tarifa rige desde su fecha de inicio, inclusive", () => {
    const t = tariff({ effective_from: "2026-07-01", effective_to: null });
    expect(isEffectiveOn(t, "2026-06-30")).toBe(false);
    expect(isEffectiveOn(t, "2026-07-01")).toBe(true);
    expect(isEffectiveOn(t, "2027-01-01")).toBe(true);
  });

  it("una tarifa cerrada deja de regir tras su fecha final, inclusive", () => {
    const t = tariff({ effective_from: "2026-01-01", effective_to: "2026-06-30" });
    expect(isEffectiveOn(t, "2026-06-30")).toBe(true);
    expect(isEffectiveOn(t, "2026-07-01")).toBe(false);
  });

  it("subir el precio hoy NO reescribe lo que costó un pedido de antes", () => {
    const vieja = tariff({ id: "vieja", amount: 10, effective_from: "2026-01-01", effective_to: "2026-06-30" });
    const nueva = tariff({ id: "nueva", amount: 14, effective_from: "2026-07-01" });
    expect(resolveTariff([vieja, nueva], "primer_intento", CTX, "2026-05-10")?.amount).toBe(10);
    expect(resolveTariff([vieja, nueva], "primer_intento", CTX, "2026-07-10")?.amount).toBe(14);
  });
});

describe("especificidad", () => {
  it("la tarifa de distrito gana a la de provincia, región, courier y tienda", () => {
    const general = tariff({ id: "general", amount: 10 });
    const porTienda = tariff({ id: "tienda", store_id: STORE, amount: 11 });
    const porCourier = tariff({ id: "courier", courier: "aliclik", amount: 12 });
    const porRegion = tariff({ id: "region", region: "Junín", amount: 13 });
    const porProvincia = tariff({ id: "provincia", province: "Huancayo", amount: 14 });
    const porDistrito = tariff({ id: "distrito", district: "El Tambo", amount: 15 });
    const all = [general, porTienda, porCourier, porRegion, porProvincia, porDistrito];
    expect(resolveTariff(all, "primer_intento", CTX, "2026-07-10")?.id).toBe("distrito");
  });

  it("un criterio fino no lo supera la suma de varios gruesos", () => {
    const distrito = tariff({ id: "distrito", district: "El Tambo", amount: 15 });
    const combinada = tariff({
      id: "combinada",
      store_id: STORE,
      courier: "aliclik",
      region: "Junín",
      amount: 9,
    });
    expect(resolveTariff([combinada, distrito], "primer_intento", CTX, "2026-07-10")?.id).toBe("distrito");
  });

  it("una tarifa de otro ámbito no aplica", () => {
    expect(specificity(tariff({ district: "Chilca" }), CTX)).toBeNull();
    expect(specificity(tariff({ store_id: "otra-tienda" }), CTX)).toBeNull();
    expect(specificity(tariff({ courier: "fenix" }), CTX)).toBeNull();
  });

  it("compara los nombres sin acentos ni mayúsculas", () => {
    expect(specificity(tariff({ region: "JUNIN" }), CTX)).not.toBeNull();
    expect(specificity(tariff({ district: "el tambo" }), CTX)).not.toBeNull();
  });

  it("a igual especificidad gana la vigencia más reciente", () => {
    const a = tariff({ id: "a", district: "El Tambo", amount: 15, effective_from: "2026-01-01" });
    const b = tariff({ id: "b", district: "El Tambo", amount: 18, effective_from: "2026-06-01" });
    expect(resolveTariff([a, b], "primer_intento", CTX, "2026-07-10")?.id).toBe("b");
  });

  it("sin ninguna tarifa aplicable devuelve null", () => {
    expect(resolveTariff([], "primer_intento", CTX, "2026-07-10")).toBeNull();
  });
});

describe("computeLogisticsCost", () => {
  const tarifas = [
    tariff({ id: "p", concept: "primer_intento", amount: 10 }),
    tariff({ id: "a", concept: "intento_adicional", amount: 6 }),
    tariff({ id: "g", concept: "envio_agencia", amount: 18 }),
    tariff({ id: "d", concept: "devolucion", amount: 12 }),
  ];
  const base = { ctx: CTX, day: "2026-07-10", generalStatus: "entregado", agency: false };

  it("un pedido entregado al primer intento cobra solo el primero", () => {
    const r = computeLogisticsCost(tarifas, { ...base, attempts: 1 });
    expect(r.total).toBe(10);
    expect(r.missing).toEqual([]);
  });

  it("cada intento adicional se suma", () => {
    expect(computeLogisticsCost(tarifas, { ...base, attempts: 3 }).total).toBe(22);
  });

  it("sin intentos reportados se asume uno: el pedido salió a reparto", () => {
    expect(computeLogisticsCost(tarifas, { ...base, attempts: 0 }).total).toBe(10);
  });

  it("un envío por agencia cobra su tarifa, no los intentos", () => {
    const r = computeLogisticsCost(tarifas, { ...base, attempts: 3, agency: true });
    expect(r.total).toBe(18);
    expect(r.lines.map((l) => l.concept)).toEqual(["envio_agencia"]);
  });

  it("una devolución añade su costo", () => {
    const r = computeLogisticsCost(tarifas, {
      ...base,
      attempts: 2,
      generalStatus: "devuelto",
      agency: true,
    });
    expect(r.total).toBe(30);
  });

  it("un pedido anulado en Lima NO paga devolución (§9)", () => {
    // Allí no hay retorno físico: el costo de devolución no corresponde.
    const r = computeLogisticsCost(tarifas, { ...base, attempts: 1, generalStatus: "anulado" });
    expect(r.lines.map((l) => l.concept)).toEqual(["primer_intento"]);
  });

  it("un concepto sin tarifa se reporta como faltante, no como cero", () => {
    const r = computeLogisticsCost([tarifas[0]!], {
      ...base,
      attempts: 2,
      generalStatus: "devuelto",
    });
    expect(r.total).toBe(10);
    expect(r.missing).toEqual(["intento_adicional", "devolucion"]);
  });
});

describe("costos de producto", () => {
  function product(over: Partial<ProductCost> = {}): ProductCost {
    return {
      id: "c1",
      store_id: null,
      sku: "COL-2",
      unit_cost: 20,
      effective_from: "2026-01-01",
      effective_to: null,
      ...over,
    };
  }

  it("resuelve el costo vigente del SKU", () => {
    expect(resolveProductCost([product()], "COL-2", STORE, "2026-07-10")?.unit_cost).toBe(20);
  });

  it("la tarifa por tienda gana a la general", () => {
    const general = product({ id: "g", unit_cost: 20 });
    const tienda = product({ id: "t", store_id: STORE, unit_cost: 17 });
    expect(resolveProductCost([general, tienda], "COL-2", STORE, "2026-07-10")?.id).toBe("t");
  });

  it("una tarifa de otra tienda no se usa", () => {
    const otra = product({ id: "o", store_id: "store-b", unit_cost: 5 });
    expect(resolveProductCost([otra], "COL-2", STORE, "2026-07-10")).toBeNull();
  });

  it("respeta la vigencia", () => {
    const vieja = product({ id: "v", unit_cost: 20, effective_to: "2026-06-30" });
    const nueva = product({ id: "n", unit_cost: 23, effective_from: "2026-07-01" });
    expect(resolveProductCost([vieja, nueva], "COL-2", STORE, "2026-05-01")?.id).toBe("v");
    expect(resolveProductCost([vieja, nueva], "COL-2", STORE, "2026-07-05")?.id).toBe("n");
  });
});

describe("costos adicionales", () => {
  function extra(over: Partial<AdditionalCost> = {}): AdditionalCost {
    return {
      id: "e1",
      store_id: null,
      concept: "empaque",
      amount: 2.5,
      basis: "pedido",
      effective_from: "2026-01-01",
      effective_to: null,
      ...over,
    };
  }

  it("suma los importes fijos por pedido", () => {
    const r = computeAdditionalCosts([extra(), extra({ id: "e2", concept: "materiales", amount: 1.5 })], {
      storeId: STORE,
      orderTotal: 100,
      day: "2026-07-10",
    });
    expect(r.total).toBe(4);
  });

  it("calcula los porcentuales sobre el total del pedido", () => {
    const r = computeAdditionalCosts([extra({ concept: "comision", amount: 5, basis: "porcentaje" })], {
      storeId: STORE,
      orderTotal: 149.9,
      day: "2026-07-10",
    });
    expect(r.total).toBe(7.5);
  });

  it("ignora las vencidas y las de otra tienda", () => {
    const r = computeAdditionalCosts(
      [
        extra({ id: "vieja", effective_to: "2026-06-30" }),
        extra({ id: "otra", store_id: "store-b" }),
      ],
      { storeId: STORE, orderTotal: 100, day: "2026-07-10" },
    );
    expect(r.total).toBe(0);
  });
});

describe("costDay", () => {
  it("imputa el costo al día del último movimiento", () => {
    expect(
      costDay({ last_movement_at: "2026-07-18T10:00:00.000Z", order_created_at: "2026-07-01T00:00:00.000Z" }),
    ).toBe("2026-07-18");
  });

  it("sin movimiento usa la fecha de creación", () => {
    expect(costDay({ last_movement_at: null, order_created_at: "2026-07-01T00:00:00.000Z" })).toBe(
      "2026-07-01",
    );
  });

  it("sin ninguna de las dos usa el respaldo", () => {
    expect(costDay({ last_movement_at: null, order_created_at: null }, "2026-07-20T00:00:00.000Z")).toBe(
      "2026-07-20",
    );
  });
});

describe("computeLogisticsCost · el costo real del courier gana", () => {
  const ctx = { storeId: "s1", courier: "aliclik", region: "Arequipa", province: "Arequipa", district: "Cayma" };
  const tarifa = (concept: string, amount: number) => ({
    id: concept,
    store_id: null,
    concept: concept as never,
    courier: null,
    region: null,
    province: null,
    district: null,
    amount,
    effective_from: "2026-01-01",
    effective_to: null,
  });

  it("usa lo que Aliclik cotizó en vez de la tarifa por distrito", () => {
    // La tarifa dice S/8,50 pero Aliclik cobró S/16,50 por ESTE envío.
    const r = computeLogisticsCost([tarifa("primer_intento", 8.5)], {
      ctx,
      attempts: 1,
      generalStatus: "entregado",
      agency: false,
      day: "2026-07-28",
      actual: { delivery: 16.5 },
    });
    expect(r.total).toBe(16.5);
    expect(r.lines[0]?.source).toBe("courier");
  });

  it("con costo real no reclama que falte la tarifa", () => {
    // Sin tarifas configuradas, el concepto NO puede salir en `missing`: no
    // falta configurar nada, se sabe exactamente lo que costó.
    const r = computeLogisticsCost([], {
      ctx,
      attempts: 1,
      generalStatus: "entregado",
      agency: false,
      day: "2026-07-28",
      actual: { delivery: 16.5 },
    });
    expect(r.total).toBe(16.5);
    expect(r.missing).not.toContain("primer_intento");
  });

  it("los intentos adicionales siguen saliendo de la tarifa", () => {
    // La cotización es del ENVÍO, no de cuántas veces se tocó la puerta.
    const r = computeLogisticsCost(
      [tarifa("primer_intento", 8.5), tarifa("intento_adicional", 5)],
      {
        ctx,
        attempts: 3,
        generalStatus: "entregado",
        agency: false,
        day: "2026-07-28",
        actual: { delivery: 16.5 },
      },
    );
    expect(r.total).toBe(26.5); // 16,50 real + 2 × 5 de tarifa
    expect(r.lines.find((l) => l.concept === "intento_adicional")?.source).toBe("tarifa");
  });

  it("la devolución real también gana cuando el pedido se devolvió", () => {
    const r = computeLogisticsCost([tarifa("primer_intento", 8.5), tarifa("devolucion", 4)], {
      ctx,
      attempts: 1,
      generalStatus: "devuelto",
      agency: false,
      day: "2026-07-28",
      actual: { delivery: 16.5, return: 10.5 },
    });
    expect(r.total).toBe(27);
  });

  it("sin costo real se comporta exactamente como antes", () => {
    const r = computeLogisticsCost([tarifa("primer_intento", 8.5)], {
      ctx,
      attempts: 1,
      generalStatus: "entregado",
      agency: false,
      day: "2026-07-28",
    });
    expect(r.total).toBe(8.5);
    expect(r.lines[0]?.source).toBe("tarifa");
  });
});
