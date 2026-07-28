import { describe, expect, it } from "vitest";
import {
  computeRoutePayout,
  groupByStore,
  masterEffects,
  stopEffect,
  routeTotals,
  stopsToSettlementLines,
  validateStopReport,
  type RouteStop,
  type StopReport,
} from "@/lib/routes";
import type { CostContext, CostTariff } from "@/lib/costs";

function report(over: Partial<StopReport> = {}): StopReport {
  return {
    status: over.status ?? "entregado",
    paymentMethod: over.paymentMethod !== undefined ? over.paymentMethod : "efectivo",
    collectedAmount: over.collectedAmount !== undefined ? over.collectedAmount : 100,
    outcomeReason: over.outcomeReason !== undefined ? over.outcomeReason : null,
    note: over.note !== undefined ? over.note : null,
    hasPhoto: over.hasPhoto ?? true,
    hasVoucher: over.hasVoucher ?? false,
  };
}

function stop(over: Partial<RouteStop> = {}): RouteStop {
  return {
    id: over.id ?? "s1",
    order_id: over.order_id ?? "o1",
    status: over.status ?? "entregado",
    payment_method: over.payment_method !== undefined ? over.payment_method : "efectivo",
    collected_amount: over.collected_amount !== undefined ? over.collected_amount : 100,
  };
}

const CTX: CostContext = {
  storeId: "store-a",
  courier: null,
  region: "Lima",
  province: "Lima",
  district: "Miraflores",
};

function tariff(over: Partial<CostTariff> = {}): CostTariff {
  return {
    id: over.id ?? "t1",
    store_id: over.store_id !== undefined ? over.store_id : null,
    courier: over.courier !== undefined ? over.courier : null,
    region: over.region !== undefined ? over.region : null,
    province: over.province !== undefined ? over.province : null,
    district: over.district !== undefined ? over.district : null,
    concept: over.concept ?? "motorizado_entrega",
    amount: over.amount ?? 8.5,
    effective_from: over.effective_from ?? "2026-01-01",
    effective_to: over.effective_to !== undefined ? over.effective_to : null,
  };
}

describe("validateStopReport", () => {
  it("acepta una entrega completa", () => {
    expect(validateStopReport(report()).ok).toBe(true);
  });

  it("una entrega sin método de cobro no pasa", () => {
    // Sin método, la liquidación queda con un agujero silencioso.
    const v = validateStopReport(report({ paymentMethod: null }));
    expect(v.ok).toBe(false);
    expect(v.errors).toContain("Indica cómo cobraste.");
  });

  it("una entrega cobrada sin monto no pasa", () => {
    const v = validateStopReport(report({ collectedAmount: null }));
    expect(v.ok).toBe(false);
    expect(v.errors).toContain("Escribe cuánto cobraste.");
    expect(validateStopReport(report({ collectedAmount: 0 })).ok).toBe(false);
  });

  it("cobrar por Yape exige la captura", () => {
    const sin = validateStopReport(report({ paymentMethod: "yape", hasVoucher: false }));
    expect(sin.ok).toBe(false);
    expect(sin.errors).toContain("Adjunta la captura del Yape.");
    expect(validateStopReport(report({ paymentMethod: "yape", hasVoucher: true })).ok).toBe(true);
  });

  it("toda entrega exige la foto", () => {
    const v = validateStopReport(report({ hasPhoto: false }));
    expect(v.ok).toBe(false);
    expect(v.errors).toContain("Adjunta la foto de la entrega.");
  });

  it("un pedido ya pagado se entrega sin monto", () => {
    // "sin_cobro" es el caso del pedido prepagado: hay entrega, no hay plata.
    const v = validateStopReport(
      report({ paymentMethod: "sin_cobro", collectedAmount: null }),
    );
    expect(v.ok).toBe(true);
  });

  it("una no entrega exige motivo del catálogo", () => {
    const sin = validateStopReport(
      report({ status: "no_entregado", paymentMethod: null, collectedAmount: null }),
    );
    expect(sin.ok).toBe(false);
    expect(sin.errors).toContain("Indica por qué no se entregó.");

    const con = validateStopReport(
      report({
        status: "no_entregado",
        paymentMethod: null,
        collectedAmount: null,
        outcomeReason: "no_contesta",
        hasPhoto: false,
      }),
    );
    expect(con.ok).toBe(true); // una no-entrega no exige foto
  });

  it("'otro' exige explicar en la nota", () => {
    const v = validateStopReport(
      report({
        status: "no_entregado",
        paymentMethod: null,
        collectedAmount: null,
        outcomeReason: "otro",
      }),
    );
    expect(v.ok).toBe(false);
    expect(v.errors).toContain("Escribe en la nota qué pasó.");
  });

  it("no entregar y declarar dinero es una contradicción", () => {
    const v = validateStopReport(
      report({ status: "no_entregado", outcomeReason: "no_contesta", collectedAmount: 50 }),
    );
    expect(v.ok).toBe(false);
    expect(v.errors).toContain("Marcaste que no se entregó pero declaraste dinero cobrado.");
  });

  it("dejar la parada pendiente no es un reporte", () => {
    expect(validateStopReport(report({ status: "pendiente" })).ok).toBe(false);
  });
});

describe("routeTotals", () => {
  const stops = [
    stop({ id: "a", payment_method: "efectivo", collected_amount: 100 }),
    stop({ id: "b", payment_method: "efectivo", collected_amount: 50 }),
    stop({ id: "c", payment_method: "yape", collected_amount: 80 }),
    stop({ id: "d", payment_method: "pos", collected_amount: 30 }),
    stop({ id: "e", status: "no_entregado", payment_method: null, collected_amount: null }),
    stop({ id: "f", status: "pendiente", payment_method: null, collected_amount: null }),
  ];

  it("separa lo cobrado por método", () => {
    const t = routeTotals(stops);
    expect(t.efectivo).toBe(150);
    expect(t.yape).toBe(80);
    expect(t.pos).toBe(30);
    expect(t.cobradoTotal).toBe(260);
  });

  it("cuenta las paradas por estado", () => {
    const t = routeTotals(stops);
    expect(t.total).toBe(6);
    expect(t.entregados).toBe(4);
    expect(t.noEntregados).toBe(1);
    expect(t.pendientes).toBe(1);
    expect(t.completa).toBe(false);
  });

  it("la ruta está completa cuando no queda nada pendiente", () => {
    expect(routeTotals(stops.filter((s) => s.status !== "pendiente")).completa).toBe(true);
    // Una ruta vacía no está "completa": no hay nada que cerrar.
    expect(routeTotals([]).completa).toBe(false);
  });
});

describe("computeRoutePayout", () => {
  const day = "2026-07-27";

  it("paga la tarifa plana por entrega", () => {
    const stops = [stop({ id: "a" }), stop({ id: "b" }), stop({ id: "c", status: "no_entregado" })];
    const p = computeRoutePayout(stops, [tariff({ amount: 8.5 })], CTX, day);
    expect(p.entregas).toBe(2);
    expect(p.visitas).toBe(1);
    expect(p.amount).toBe(17); // 2 × 8.50; la visita no se paga si no hay tarifa
    expect(p.missingTariffs).toBe(0);
  });

  it("paga la visita solo si hay tarifa configurada", () => {
    const stops = [stop({ id: "a" }), stop({ id: "b", status: "no_entregado" })];
    const p = computeRoutePayout(
      stops,
      [tariff({ amount: 8.5 }), tariff({ id: "v", concept: "motorizado_visita", amount: 3 })],
      CTX,
      day,
    );
    expect(p.amount).toBe(11.5); // 8.50 + 3.00
  });

  it("sin tarifa de entrega avisa, en vez de pagar cero en silencio", () => {
    const p = computeRoutePayout([stop()], [], CTX, day);
    expect(p.amount).toBe(0);
    expect(p.missingTariffs).toBe(1);
  });

  it("una tarifa que aún no regía ese día no se usa", () => {
    const p = computeRoutePayout(
      [stop()],
      [tariff({ amount: 9, effective_from: "2026-08-01" })],
      CTX,
      day,
    );
    expect(p.amount).toBe(0);
    expect(p.missingTariffs).toBe(1);
  });

  it("una ruta sin entregas no reclama tarifa", () => {
    const p = computeRoutePayout([stop({ status: "no_entregado" })], [], CTX, day);
    expect(p.missingTariffs).toBe(0);
  });
});

describe("stopsToSettlementLines", () => {
  it("las líneas nacen ya vinculadas: sin cola de revisión", () => {
    const lines = stopsToSettlementLines([
      stop({ id: "a", order_id: "o1", collected_amount: 100 }),
      stop({ id: "b", order_id: "o2", status: "no_entregado", payment_method: null, collected_amount: null }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.match_status === "ok")).toBe(true);
    expect(lines[0]).toMatchObject({ order_id: "o1", declared_amount: 100 });
  });

  it("una no entrega declara cero, no 'no lo declaró'", () => {
    // 0 = "reportó que no cobró"; null sería "no lo reportó". Son distintos.
    const lines = stopsToSettlementLines([
      stop({ status: "no_entregado", payment_method: null, collected_amount: null }),
    ]);
    expect(lines[0]!.declared_amount).toBe(0);
  });

  it("las paradas sin reportar no entran en la liquidación", () => {
    const lines = stopsToSettlementLines([stop({ status: "pendiente" })]);
    expect(lines).toHaveLength(0);
  });
});

describe("stopEffect y masterEffects", () => {
  it("una entrega mueve el pedido a entregado", () => {
    // Es el hueco que esto tapa: con motorizado propio no viene detrás el
    // reporte de ningún courier, así que sin esto el pedido se quedaría
    // "pendiente" y el cuadre lo marcaría como "cobro sin entrega".
    expect(stopEffect({ status: "entregado" })).toBe("entregado");
  });

  it("solo el rechazo cierra el pedido", () => {
    expect(stopEffect({ status: "no_entregado", outcome_reason: "rechazado" })).toBe("anulado");
  });

  it("los motivos de reintento NO tocan el pedido", () => {
    // Cerrar un pedido por error cuesta una venta; dejarlo abierto solo cuesta
    // otra visita. Ante la duda, no se cierra.
    for (const reason of ["no_contesta", "no_estaba", "reprogramado", "sin_dinero", "direccion_errada", "otro"]) {
      expect(stopEffect({ status: "no_entregado", outcome_reason: reason })).toBeNull();
    }
    expect(stopEffect({ status: "no_entregado", outcome_reason: null })).toBeNull();
  });

  it("una parada sin reportar no toca nada", () => {
    expect(stopEffect({ status: "pendiente" })).toBeNull();
  });

  it("masterEffects devuelve solo lo que cambia, con su motivo", () => {
    const effects = masterEffects([
      { order_id: "o1", status: "entregado" },
      { order_id: "o2", status: "no_entregado", outcome_reason: "rechazado" },
      { order_id: "o3", status: "no_entregado", outcome_reason: "no_contesta" },
      { order_id: "o4", status: "pendiente" },
    ]);
    expect(effects).toHaveLength(2);
    expect(effects[0]).toMatchObject({ order_id: "o1", target: "entregado" });
    expect(effects[1]).toMatchObject({ order_id: "o2", target: "anulado" });
    expect(effects.every((e) => e.reason.length > 0)).toBe(true);
  });
});

describe("groupByStore", () => {
  it("una ruta mixta se parte por tienda", () => {
    // El viaje es uno, pero el dinero y el cuadre son por tienda: cerrarla
    // produce una liquidación por cada una.
    const grouped = groupByStore([
      { store_id: "aurela", id: "a" },
      { store_id: "kenku", id: "b" },
      { store_id: "aurela", id: "c" },
    ]);
    expect([...grouped.keys()].sort()).toEqual(["aurela", "kenku"]);
    expect(grouped.get("aurela")).toHaveLength(2);
    expect(grouped.get("kenku")).toHaveLength(1);
  });

  it("una parada sin tienda no se pierde en un grupo falso", () => {
    const grouped = groupByStore([{ store_id: null, id: "a" }, { store_id: "kenku", id: "b" }]);
    expect(grouped.size).toBe(1);
    expect(grouped.has("kenku")).toBe(true);
  });
});
