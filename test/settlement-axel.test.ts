import { describe, expect, it } from "vitest";
import { axelDelivered, parseAxelSheet, scoreAxelSheet } from "@/lib/settlements/axel";
import { parseSettlementFile } from "@/lib/settlements/registry";
import { matchByName } from "@/lib/settlement-ingest";
import { reconcileSettlement, type SettlementMasterFacts } from "@/lib/settlements";

/** Filas tal como salen del reporte diario de Axel Courier del 25/07/2026. */
function axelRows(): Record<string, string>[] {
  return [
    {
      ITEM: "1",
      CLIENTE: "AURELA",
      NOMBRE: "Edgard William",
      DISTRITO: "San Juan de Lurigancho",
      EFECTIVO: "S/.636.00",
      "F. PAGO": "EFECTIVO",
      GANANCIA: "S/ 10.00",
      UTILIDAD: "",
      OBSERVACION: "",
    },
    {
      ITEM: "6",
      CLIENTE: "AURELA",
      NOMBRE: "Edith Ascanoa",
      DISTRITO: "Lima - Cercado",
      EFECTIVO: "S/.271.68",
      "F. PAGO": "PAGO POS",
      GANANCIA: "S/ 13.00",
      UTILIDAD: "",
      OBSERVACION: "",
    },
    {
      ITEM: "8",
      CLIENTE: "AURELA",
      NOMBRE: "Jose Piscoya",
      DISTRITO: "San Martin de Porres",
      EFECTIVO: "S/0.00",
      "F. PAGO": "CAIDA",
      GANANCIA: "S/ -",
      UTILIDAD: "",
      OBSERVACION: "",
    },
    {
      ITEM: "9",
      CLIENTE: "AURELA",
      NOMBRE: "Axell Axell",
      DISTRITO: "Callao",
      EFECTIVO: "S/ -",
      "F. PAGO": "CAIDA COBRO",
      GANANCIA: "S/ 10.00",
      UTILIDAD: "",
      OBSERVACION: "",
    },
    {
      ITEM: "10",
      CLIENTE: "AURELA",
      NOMBRE: "Amador Campo",
      DISTRITO: "Independencia",
      EFECTIVO: "S/ -",
      "F. PAGO": "LUNES",
      GANANCIA: "S/ -",
      UTILIDAD: "",
      OBSERVACION: "",
    },
    // Los huecos que la plantilla deja del 26 al 30.
    { ITEM: "26", CLIENTE: "", NOMBRE: "", DISTRITO: "", EFECTIVO: "", "F. PAGO": "", GANANCIA: "" },
    // Fila de total del bloque.
    {
      ITEM: "",
      CLIENTE: "",
      NOMBRE: "",
      DISTRITO: "TOTAL COBRADO",
      EFECTIVO: "S/ 2,219.73",
      "F. PAGO": "",
      GANANCIA: "S/ 146.00",
      OBSERVACION: "S/ 2,073.73",
    },
    // Arrastre del segundo bloque y comisión de POS.
    { ITEM: "17", EFECTIVO: "RECAUDADO", GANANCIA: "RECAUDADO" },
    { ITEM: "18", EFECTIVO: "S/.2,219.73", GANANCIA: "S/ 146.00" },
    { ITEM: "19", "F. PAGO": "COMISION", GANANCIA: "S/ 8.00", UTILIDAD: "POS" },
  ];
}

describe("axelDelivered", () => {
  it("solo EFECTIVO y PAGO POS son entregas", () => {
    expect(axelDelivered("EFECTIVO")).toBe(true);
    expect(axelDelivered("PAGO POS")).toBe(true);
  });

  it("los fallos por los que igual cobran flete NO son entregas", () => {
    // "CAIDA COBRO" y "RECHAZO" traen comisión, pero el pedido no llegó: darlos
    // por entregados inflaría lo que el Master dice que debía cobrarse.
    expect(axelDelivered("CAIDA COBRO")).toBe(false);
    expect(axelDelivered("RECHAZO")).toBe(false);
    expect(axelDelivered("CAIDA")).toBe(false);
    expect(axelDelivered("NO CONTESTO")).toBe(false);
    expect(axelDelivered("LUNES")).toBe(false);
    expect(axelDelivered(null)).toBe(false);
  });
});

describe("parseAxelSheet", () => {
  const parsed = parseAxelSheet(axelRows());

  it("lee solo las entregas, sin totales, arrastres ni huecos", () => {
    expect(parsed.lines).toHaveLength(5);
    expect(parsed.lines.map((l) => l.customer_name)).toEqual([
      "Edgard William",
      "Edith Ascanoa",
      "Jose Piscoya",
      "Axell Axell",
      "Amador Campo",
    ]);
  });

  it("no confunde CLIENTE (la tienda) con el cliente de verdad", () => {
    expect(parsed.storeHint).toBe("AURELA");
    expect(parsed.lines[0]!.customer_name).toBe("Edgard William");
  });

  it("no inventa guía ni nº de pedido, porque la hoja no los trae", () => {
    for (const l of parsed.lines) {
      expect(l.guide_code).toBeNull();
      expect(l.order_name).toBeNull();
    }
  });

  it("distingue 'S/ -' (cobró cero) de una celda vacía (no lo declaró)", () => {
    expect(parsed.lines[3]!.declared_amount).toBe(0); // "S/ -"
    expect(parsed.lines[2]!.declared_amount).toBe(0); // "S/0.00"
  });

  it("lee la comisión por entrega y su variación por distrito", () => {
    expect(parsed.lines[0]!.declared_fee).toBe(10); // Lima
    expect(parsed.lines[1]!.declared_fee).toBe(13); // Lima - Cercado
    expect(parsed.lines[2]!.declared_fee).toBe(0); // caída sin cobro
    expect(parsed.lines[3]!.declared_fee).toBe(10); // caída pero cobran flete
  });

  it("captura la comisión de POS, que va en su propia fila", () => {
    expect(parsed.posFee).toBe(8);
  });

  it("no inventa el motorizado: la hoja es del courier, no de una persona", () => {
    expect(parsed.riderName).toBeNull();
  });
});

describe("registry", () => {
  it("reconoce el formato de Axel por su contenido", () => {
    expect(scoreAxelSheet(axelRows())).toBeGreaterThan(0);
    expect(parseSettlementFile(axelRows()).format).toBe("axel");
  });

  it("cae al lector genérico cuando nadie reconoce la hoja", () => {
    const res = parseSettlementFile([{ Guia: "G1", Monto: "50", Estado: "entregado" }]);
    expect(res.format).toBe("generico");
    expect(res.lines).toHaveLength(1);
  });
});

describe("cuadre con la comisión del courier", () => {
  it("el depósito esperado descuenta lo que el courier se queda", () => {
    // El caso exacto del reporte: cobran 2,219.73, se quedan 146.00 y depositan
    // 2,073.73. Sin descontar la comisión el cuadre marcaría un faltante diario
    // por el importe exacto de lo que legítimamente se quedan.
    const facts = new Map<string, SettlementMasterFacts>([
      [
        "o1",
        {
          order_id: "o1",
          general_status: "entregado",
          order_total: 2219.73,
          current_courier: "axel",
          region: "Lima",
          province: "Lima",
          district: "San Juan de Lurigancho",
          store_id: "s1",
        },
      ],
    ]);
    const res = reconcileSettlement(
      [
        {
          id: "l1",
          order_id: "o1",
          guide_code: null,
          order_name: null,
          declared_status: "EFECTIVO",
          declared_amount: 2219.73,
          declared_fee: 146,
          customer_name: "Edgard William",
          district: "San Juan de Lurigancho",
          match_status: "ok",
        },
      ],
      facts,
      { cash: 2073.73 },
    );
    expect(res.totals.feeTotal).toBe(146);
    expect(res.totals.expectedDeposit).toBe(2073.73);
    expect(res.totals.depositDifference).toBe(0);
    expect(res.totals.difference).toBe(0);
    expect(res.totals.balanced).toBe(true);
  });

  it("las comisiones de líneas sin vincular también cuentan", () => {
    // El courier se las queda igual; dejarlas fuera haría que el cuadre del
    // depósito cambiara al vincular una línea, lo que no tiene sentido.
    const res = reconcileSettlement(
      [
        {
          id: "l1",
          order_id: null,
          guide_code: null,
          order_name: null,
          declared_status: "EFECTIVO",
          declared_amount: 100,
          declared_fee: 10,
          customer_name: "Nadie Conocido",
          district: "Lima",
          match_status: "review",
        },
      ],
      new Map(),
      { cash: 90 },
    );
    expect(res.totals.feeTotal).toBe(10);
    expect(res.totals.expectedDeposit).toBe(90);
    expect(res.totals.depositDifference).toBe(0);
  });

  it("la comisión de POS se descuenta como cualquier otra", () => {
    const res = reconcileSettlement([], new Map(), { cash: 0, posFee: 8 });
    expect(res.totals.feeTotal).toBe(8);
    expect(res.totals.expectedDeposit).toBe(-8);
  });
});

describe("matchByName", () => {
  const candidates = [
    { order_id: "o1", store_id: "s1", customer_name: "Edgard William Rojas", district: "San Juan de Lurigancho" },
    { order_id: "o2", store_id: "s1", customer_name: "Ana María Cárdenas", district: "Chorrillos" },
    { order_id: "o3", store_id: "s1", customer_name: "Ana María Cárdenas", district: "Los Olivos" },
  ];

  it("empareja por prefijo, porque el courier trunca el nombre", () => {
    expect(matchByName({ customer_name: "Edgard William" }, candidates)).toBe("o1");
  });

  it("no es sensible a mayúsculas ni acentos", () => {
    expect(matchByName({ customer_name: "EDGARD WILLIAM ROJAS" }, candidates)).toBe("o1");
  });

  it("desempata por distrito cuando hay homónimos", () => {
    expect(matchByName({ customer_name: "Ana María Cárd", district: "Los Olivos" }, candidates)).toBe(
      "o3",
    );
  });

  it("sin desempate posible NO vincula: va a revisión", () => {
    // Dos homónimos y sin distrito que los separe. Vincular al azar movería
    // plata de un pedido a otro.
    expect(matchByName({ customer_name: "Ana María Cárd" }, candidates)).toBeNull();
    expect(
      matchByName({ customer_name: "Ana María Cárd", district: "Ate" }, candidates),
    ).toBeNull();
  });

  it("un nombre demasiado corto no empareja nunca", () => {
    expect(matchByName({ customer_name: "Ana" }, candidates)).toBeNull();
    expect(matchByName({ customer_name: null }, candidates)).toBeNull();
  });
});
