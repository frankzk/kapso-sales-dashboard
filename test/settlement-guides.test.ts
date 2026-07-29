// La liquidación como origen de guía. Axel no manda reporte de guías, así que
// sus pedidos pueden llegar al Master sin ninguna fila en `shipments` — y sin
// guía no hay `current_courier`, sin `current_courier` el motor de Costos no
// resuelve la tarifa del courier, y el envío se queda sin costo para siempre.

import { describe, expect, it } from "vitest";
import {
  settlementGuideCode,
  settlementGuidesToCreate,
  type SettlementLineInput,
  type SettlementMasterFacts,
} from "@/lib/settlements";

function line(over: Partial<SettlementLineInput> = {}): SettlementLineInput {
  return {
    id: "l1",
    order_id: "o1",
    guide_code: null,
    order_name: "#KP114985",
    declared_status: "EFECTIVO",
    declared_amount: 120,
    customer_name: "Edgard William",
    district: "San Juan de Lurigancho",
    match_status: "ok",
    ...over,
  };
}

function facts(over: Partial<SettlementMasterFacts> = {}): SettlementMasterFacts {
  return {
    order_id: "o1",
    general_status: "pendiente",
    order_total: 120,
    current_courier: null,
    region: "Lima",
    province: null,
    district: "San Juan de Lurigancho",
    store_id: "s1",
    ...over,
  };
}

describe("settlementGuideCode", () => {
  it("es determinista: reaplicar la liquidación no crea una segunda guía", () => {
    expect(settlementGuideCode("axel", "#KP114985", "o1")).toBe("AXEL-KP114985");
    expect(settlementGuideCode("axel", "#KP114985", "o1")).toBe(
      settlementGuideCode("axel", "#KP114985", "o1"),
    );
  });

  it("cae al id del pedido cuando la hoja no trae número", () => {
    const code = settlementGuideCode("axel", null, "3f9a1b2c-0000-4000-8000-000000000001");
    expect(code).toBe("AXEL-3F9A1B2C00");
  });

  it("separa por courier: dos couriers pueden liquidar el mismo pedido", () => {
    expect(settlementGuideCode("axel", "#KP1", "o1")).not.toBe(
      settlementGuideCode("aliclik", "#KP1", "o1"),
    );
  });
});

describe("settlementGuidesToCreate", () => {
  it("crea la guía del pedido que no tiene ninguna", () => {
    const out = settlementGuidesToCreate("axel", [{ line: line(), facts: facts() }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      order_id: "o1",
      store_id: "s1",
      guide_code: "AXEL-KP114985",
      district: "San Juan de Lurigancho",
      delivered: true,
    });
  });

  it("NO toca el pedido que ya tiene courier: el Master sabe más que la hoja", () => {
    const out = settlementGuidesToCreate("axel", [
      { line: line(), facts: facts({ current_courier: "aliclik" }) },
    ]);
    expect(out).toEqual([]);
  });

  it("un rechazo también deja guía, pero marcada como no entregada", () => {
    const out = settlementGuidesToCreate("axel", [
      { line: line({ declared_status: "RECHAZO" }), facts: facts() },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].delivered).toBe(false);
  });

  it("ignora lo que no declara ni entrega ni rechazo: son reintentos", () => {
    // "CAIDA COBRO" y "LUNES" dejan el pedido vivo (ver lineEffect).
    for (const status of ["CAIDA COBRO", "LUNES", null]) {
      expect(
        settlementGuidesToCreate("axel", [{ line: line({ declared_status: status }), facts: facts() }]),
      ).toEqual([]);
    }
  });

  it("ignora las líneas en revisión: vincular mal movería plata de un pedido a otro", () => {
    expect(
      settlementGuidesToCreate("axel", [
        { line: line({ match_status: "revisar" }), facts: facts() },
      ]),
    ).toEqual([]);
    expect(
      settlementGuidesToCreate("axel", [{ line: line({ order_id: null }), facts: null }]),
    ).toEqual([]);
  });

  it("no duplica cuando la hoja trae dos líneas del mismo pedido", () => {
    const out = settlementGuidesToCreate("axel", [
      { line: line({ id: "l1" }), facts: facts() },
      { line: line({ id: "l2" }), facts: facts() },
    ]);
    expect(out).toHaveLength(1);
  });

  it("prefiere el distrito del Master, que es el que usan las tarifas", () => {
    const out = settlementGuidesToCreate("axel", [
      {
        line: line({ district: "SJL" }),
        facts: facts({ district: "San Juan de Lurigancho" }),
      },
    ]);
    expect(out[0].district).toBe("San Juan de Lurigancho");
  });

  it("usa el distrito de la hoja solo cuando el Master no lo tiene", () => {
    const out = settlementGuidesToCreate("axel", [
      { line: line({ district: "Huaycán" }), facts: facts({ district: null }) },
    ]);
    expect(out[0].district).toBe("Huaycán");
  });
});
