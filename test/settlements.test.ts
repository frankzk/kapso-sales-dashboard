import { describe, expect, it } from "vitest";
import {
  computeRiderPayout,
  declaresDelivered,
  isMismatch,
  reconcileLine,
  reconcileSettlement,
  settlementStatus,
  type SettlementLineInput,
  type SettlementMasterFacts,
} from "@/lib/settlements";
import type { CostTariff } from "@/lib/costs";

const STORE = "store-a";

function line(over: Partial<SettlementLineInput> = {}): SettlementLineInput {
  return {
    id: over.id ?? "l1",
    order_id: over.order_id !== undefined ? over.order_id : "o1",
    guide_code: over.guide_code ?? "G-1",
    order_name: over.order_name ?? "#KP1",
    declared_status: over.declared_status ?? "entregado",
    declared_amount: over.declared_amount !== undefined ? over.declared_amount : 100,
    match_status: over.match_status ?? "ok",
  };
}

function facts(over: Partial<SettlementMasterFacts> = {}): SettlementMasterFacts {
  return {
    order_id: over.order_id ?? "o1",
    general_status: over.general_status ?? "entregado",
    order_total: over.order_total !== undefined ? over.order_total : 100,
    current_courier: over.current_courier ?? "aliclik",
    region: over.region ?? "Lima",
    province: over.province ?? "Lima",
    district: over.district ?? "Miraflores",
    store_id: over.store_id ?? STORE,
  };
}

function tariff(over: Partial<CostTariff> = {}): CostTariff {
  return {
    id: over.id ?? "t1",
    store_id: over.store_id !== undefined ? over.store_id : null,
    courier: over.courier !== undefined ? over.courier : null,
    region: over.region !== undefined ? over.region : null,
    province: over.province !== undefined ? over.province : null,
    district: over.district !== undefined ? over.district : null,
    concept: over.concept ?? "motorizado_entrega",
    amount: over.amount ?? 5,
    effective_from: over.effective_from ?? "2026-01-01",
    effective_to: over.effective_to !== undefined ? over.effective_to : null,
  };
}

describe("declaresDelivered", () => {
  it("tolera cómo escribe cada motorizado", () => {
    expect(declaresDelivered("ENTREGADO")).toBe(true);
    expect(declaresDelivered("entregó  ")).toBe(true);
    expect(declaresDelivered("Entregada")).toBe(true);
    expect(declaresDelivered("entregué")).toBe(true);
    expect(declaresDelivered("ok")).toBe(true);
    expect(declaresDelivered("cobrado")).toBe(true);
    expect(declaresDelivered("cobré")).toBe(true);
  });

  it("no confunde una negación con una entrega", () => {
    expect(declaresDelivered("no entregado")).toBe(false);
    expect(declaresDelivered("sin entrega")).toBe(false);
    expect(declaresDelivered("rechazado")).toBe(false);
    expect(declaresDelivered("devolución")).toBe(false);
    expect(declaresDelivered(null)).toBe(false);
    expect(declaresDelivered("")).toBe(false);
  });
});

describe("reconcileLine", () => {
  it("conforme cuando lo declarado es el total del pedido", () => {
    const r = reconcileLine(line({ declared_amount: 100 }), facts({ order_total: 100 }));
    expect(r.verdict).toBe("conforme");
    expect(r.difference).toBe(0);
    expect(r.delivered).toBe(true);
    expect(isMismatch(r.verdict)).toBe(false);
  });

  it("distingue cobrar de más de cobrar de menos", () => {
    expect(reconcileLine(line({ declared_amount: 120 }), facts({ order_total: 100 })).verdict).toBe(
      "cobro_de_mas",
    );
    expect(reconcileLine(line({ declared_amount: 80 }), facts({ order_total: 100 })).verdict).toBe(
      "cobro_de_menos",
    );
  });

  it("marca la entrega sin un sol declarado", () => {
    const r = reconcileLine(line({ declared_amount: 0 }), facts({ order_total: 100 }));
    expect(r.verdict).toBe("entregado_sin_cobro");
    expect(r.difference).toBe(-100);
  });

  it("marca la plata de una guía que el Master no da por entregada", () => {
    const r = reconcileLine(
      line({ declared_amount: 100 }),
      facts({ general_status: "pendiente" }),
    );
    expect(r.verdict).toBe("cobro_sin_entrega");
    expect(r.expected).toBe(0);
  });

  it("no entregado y sin plata es conforme", () => {
    const r = reconcileLine(
      line({ declared_amount: 0, declared_status: "no entregado" }),
      facts({ general_status: "pendiente" }),
    );
    expect(r.verdict).toBe("conforme");
  });

  it("la hoja no manda sobre el Master: dice entregado y el Master no", () => {
    // Lo que decide si hubo entrega es el Master, no lo escrito en el cuaderno.
    const r = reconcileLine(
      line({ declared_status: "ENTREGADO", declared_amount: 100 }),
      facts({ general_status: "pendiente" }),
    );
    expect(r.verdict).toBe("cobro_sin_entrega");
    expect(r.delivered).toBe(false);
  });

  it("sin vínculo no se cuadra ni se adivina", () => {
    const suelta = reconcileLine(line({ order_id: null, match_status: "review" }), null);
    expect(suelta.verdict).toBe("sin_pedido");
    expect(suelta.expected).toBe(0);
    expect(suelta.difference).toBe(0);
    // Vinculada en la fila pero sin datos del Master: tampoco se inventa.
    expect(reconcileLine(line(), null).verdict).toBe("sin_pedido");
    // Con datos pero pendiente de revisión: sigue sin cuadrarse.
    expect(reconcileLine(line({ match_status: "review" }), facts()).verdict).toBe("sin_pedido");
  });

  it("un céntimo de ruido no es un descuadre", () => {
    const r = reconcileLine(
      line({ declared_amount: 0.1 + 0.2 }),
      facts({ order_total: 0.3 }),
    );
    expect(r.verdict).toBe("conforme");
  });

  it("un monto negativo se trata como cero, no resta del cuadre", () => {
    const r = reconcileLine(line({ declared_amount: -50 }), facts({ order_total: 100 }));
    expect(r.declared).toBe(0);
    expect(r.verdict).toBe("entregado_sin_cobro");
  });
});

describe("reconcileSettlement", () => {
  const map = new Map<string, SettlementMasterFacts>([
    ["o1", facts({ order_id: "o1", order_total: 100 })],
    ["o2", facts({ order_id: "o2", order_total: 50 })],
    ["o3", facts({ order_id: "o3", general_status: "pendiente", order_total: 70 })],
  ]);

  it("suma lo declarado contra lo esperado y cuenta los descuadres", () => {
    const res = reconcileSettlement(
      [
        line({ id: "a", order_id: "o1", declared_amount: 100 }),
        line({ id: "b", order_id: "o2", declared_amount: 40 }),
        line({ id: "c", order_id: "o3", declared_amount: 0, declared_status: "no entregado" }),
      ],
      map,
      { cash: 140 },
    );
    expect(res.totals.declaredTotal).toBe(140);
    expect(res.totals.expectedTotal).toBe(150);
    expect(res.totals.difference).toBe(-10);
    expect(res.totals.deliveredCount).toBe(2);
    expect(res.totals.mismatchCount).toBe(1); // la "b" cobró de menos
    expect(res.totals.balanced).toBe(false);
  });

  it("separa el cuadre contra el Master del cuadre del depósito", () => {
    // Declara bien lo que dice el Master, pero deposita de menos.
    const res = reconcileSettlement(
      [line({ id: "a", order_id: "o1", declared_amount: 100 })],
      map,
      { cash: 60, yape: 0 },
    );
    expect(res.totals.difference).toBe(0); // contra el Master, impecable
    expect(res.totals.depositDifference).toBe(-40); // pero faltan 40 en la mano
    expect(res.totals.balanced).toBe(false);
  });

  it("cuadra del todo cuando no hay diferencias ni líneas sueltas", () => {
    const res = reconcileSettlement(
      [
        line({ id: "a", order_id: "o1", declared_amount: 100 }),
        line({ id: "b", order_id: "o2", declared_amount: 50 }),
      ],
      map,
      { cash: 100, yape: 50 },
    );
    expect(res.totals.balanced).toBe(true);
    expect(settlementStatus(res.totals)).toBe("cuadrada");
  });

  it("una línea sin vincular impide dar por cuadrada la liquidación", () => {
    const res = reconcileSettlement(
      [
        line({ id: "a", order_id: "o1", declared_amount: 100 }),
        line({ id: "z", order_id: null, match_status: "review", declared_amount: 0 }),
      ],
      map,
      { cash: 100 },
    );
    expect(res.totals.reviewCount).toBe(1);
    expect(res.totals.balanced).toBe(false);
    expect(settlementStatus(res.totals)).toBe("con_descuadre");
  });
});

describe("computeRiderPayout", () => {
  const day = "2026-07-20";

  it("paga por entrega con la tarifa vigente ese día", () => {
    const rec = reconcileSettlement(
      [line({ id: "a", order_id: "o1", declared_amount: 100 })],
      new Map([["o1", facts({ order_id: "o1", order_total: 100 })]]),
      { cash: 100 },
    );
    const payout = computeRiderPayout(rec.lines, [tariff({ amount: 6 })], day);
    expect(payout.gross).toBe(6);
    expect(payout.net).toBe(6);
    expect(payout.missingTariffs).toBe(0);
    expect(payout.lines[0]!.concept).toBe("motorizado_entrega");
  });

  it("la tarifa más específica gana, igual que en Costos", () => {
    const rec = reconcileSettlement(
      [line({ id: "a", order_id: "o1", declared_amount: 100 })],
      new Map([["o1", facts({ order_id: "o1", district: "Miraflores" })]]),
      { cash: 100 },
    );
    const payout = computeRiderPayout(
      rec.lines,
      [tariff({ id: "gen", amount: 6 }), tariff({ id: "dist", district: "Miraflores", amount: 9 })],
      day,
    );
    expect(payout.gross).toBe(9);
  });

  it("una tarifa que aún no regía ese día no se usa", () => {
    const rec = reconcileSettlement(
      [line({ id: "a", order_id: "o1", declared_amount: 100 })],
      new Map([["o1", facts({ order_id: "o1" })]]),
      { cash: 100 },
    );
    const payout = computeRiderPayout(
      rec.lines,
      [tariff({ amount: 12, effective_from: "2026-08-01" })],
      day,
    );
    expect(payout.gross).toBe(0);
    expect(payout.missingTariffs).toBe(1);
  });

  it("paga visita cuando fue y no entregó, y devolución cuando se anuló", () => {
    const rec = reconcileSettlement(
      [
        line({ id: "a", order_id: "o1", declared_amount: 0, declared_status: "no entregado" }),
        line({ id: "b", order_id: "o2", declared_amount: 0, declared_status: "devolución" }),
      ],
      new Map([
        ["o1", facts({ order_id: "o1", general_status: "en_proceso" })],
        ["o2", facts({ order_id: "o2", general_status: "anulado" })],
      ]),
    );
    const payout = computeRiderPayout(
      rec.lines,
      [
        tariff({ id: "v", concept: "motorizado_visita", amount: 2 }),
        tariff({ id: "d", concept: "motorizado_devolucion", amount: 3 }),
      ],
      day,
    );
    expect(payout.lines.map((l) => l.concept)).toEqual([
      "motorizado_visita",
      "motorizado_devolucion",
    ]);
    expect(payout.gross).toBe(5);
  });

  it("no paga líneas sin vincular", () => {
    const rec = reconcileSettlement(
      [line({ id: "z", order_id: null, match_status: "review" })],
      new Map(),
    );
    const payout = computeRiderPayout(rec.lines, [tariff({ amount: 6 })], day);
    expect(payout.lines).toHaveLength(0);
    expect(payout.gross).toBe(0);
  });

  it("descuenta el faltante solo si se pide, y nunca deja el pago en negativo", () => {
    const rec = reconcileSettlement(
      [line({ id: "a", order_id: "o1", declared_amount: 20 })],
      new Map([["o1", facts({ order_id: "o1", order_total: 100 })]]),
      { cash: 20 },
    );
    const sin = computeRiderPayout(rec.lines, [tariff({ amount: 6 })], day);
    expect(sin.shortfall).toBe(80);
    expect(sin.net).toBe(6); // por defecto NO se descuenta: es decisión de la empresa

    const con = computeRiderPayout(rec.lines, [tariff({ amount: 6 })], day, {
      deductShortfall: true,
    });
    expect(con.net).toBe(0); // 6 − 80 nunca baja de cero
  });

  it("traer de más no le sube el pago", () => {
    const rec = reconcileSettlement(
      [line({ id: "a", order_id: "o1", declared_amount: 150 })],
      new Map([["o1", facts({ order_id: "o1", order_total: 100 })]]),
      { cash: 150 },
    );
    const payout = computeRiderPayout(rec.lines, [tariff({ amount: 6 })], day, {
      deductShortfall: true,
    });
    expect(payout.shortfall).toBe(0);
    expect(payout.net).toBe(6);
  });
});
