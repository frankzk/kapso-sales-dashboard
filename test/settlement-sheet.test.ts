import { describe, expect, it } from "vitest";
import { parseSettlementSheet, scoreSettlementSheet } from "@/lib/settlement-sheet";
import { parseSettlementVision } from "@/lib/settlement-vision";

describe("parseSettlementSheet", () => {
  it("lee la variante con cabeceras en limpio", () => {
    const res = parseSettlementSheet([
      { "N° GUÍA": "AUR5X123", "MONTO COBRADO": "S/ 120.50", ESTADO: "ENTREGADO" },
      { "N° GUÍA": "AUR5X124", "MONTO COBRADO": "0", ESTADO: "NO ENTREGÓ" },
    ]);
    expect(res.lines).toHaveLength(2);
    expect(res.lines[0]).toMatchObject({
      guide_code: "AUR5X123",
      declared_amount: 120.5,
      declared_status: "ENTREGADO",
    });
    expect(res.lines[1]!.declared_amount).toBe(0);
  });

  it("tolera cómo titula cada courier la misma columna", () => {
    // "Nro. Guia", "N GUIA" y "guía" son la misma columna una vez normalizadas.
    const a = parseSettlementSheet([{ "Nro. Guia": "G1", Importe: "10" }]);
    const b = parseSettlementSheet([{ "N GUIA": "G1", Recaudado: "10" }]);
    const c = parseSettlementSheet([{ Guía: "G1", Cobro: "10" }]);
    for (const res of [a, b, c]) {
      expect(res.lines[0]).toMatchObject({ guide_code: "G1", declared_amount: 10 });
    }
  });

  it("normaliza el nº de pedido a la forma del Master", () => {
    const res = parseSettlementSheet([{ Pedido: "kp124158", Monto: "80" }]);
    expect(res.lines[0]!.order_name).toBe("#KP124158");
  });

  it("saca el motorizado y la fecha de la hoja", () => {
    const res = parseSettlementSheet([
      { Motorizado: "Luis Quispe", Fecha: "24/07/2026", Guia: "G1", Monto: "50" },
      { Motorizado: "Luis Quispe", Fecha: "24/07/2026", Guia: "G2", Monto: "60" },
    ]);
    expect(res.riderName).toBe("Luis Quispe");
    expect(res.settlementDate).toBe("2026-07-24");
  });

  it("descarta la fila de TOTAL para no duplicar la plata del día", () => {
    const res = parseSettlementSheet([
      { Guia: "G1", Monto: "50" },
      { Guia: "G2", Monto: "60" },
      { Guia: "TOTAL", Monto: "110" },
    ]);
    expect(res.lines).toHaveLength(2);
    expect(res.lines.reduce((s, l) => s + (l.declared_amount ?? 0), 0)).toBe(110);
  });

  it("descarta filas vacías pero conserva las que traen plata sin guía", () => {
    // Una fila con monto y sin identificador NO se tira: es plata declarada que
    // alguien tiene que revisar. Se guarda con el vínculo en null.
    const res = parseSettlementSheet([
      { Guia: "", Monto: "" },
      { Guia: "", Monto: "45", Estado: "entregado" },
    ]);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toMatchObject({ guide_code: null, declared_amount: 45 });
  });

  it("una celda de monto ausente queda en null, no en cero", () => {
    // null = "no declaró"; 0 = "declaró que no cobró". El cuadre los distingue.
    const res = parseSettlementSheet([{ Guia: "G1", Estado: "entregado" }]);
    expect(res.lines[0]!.declared_amount).toBeNull();
  });
});

describe("scoreSettlementSheet", () => {
  it("reconoce una hoja de liquidación", () => {
    expect(
      scoreSettlementSheet([
        { Guia: "AUR5X1", Monto: "10" },
        { Guia: "AUR5X2", Monto: "20" },
      ]),
    ).toBe(2);
  });

  it("no reconoce una hoja que no trae plata", () => {
    expect(scoreSettlementSheet([{ Guia: "AUR5X1", Distrito: "Lince" }])).toBe(0);
  });
});

describe("parseSettlementVision", () => {
  it("lee el JSON del modelo aunque venga envuelto en prosa o vallas", () => {
    const text =
      "Aquí va la transcripción:\n```json\n" +
      JSON.stringify({
        rider_name: "Luis Quispe",
        date: "2026-07-24",
        lines: [
          { guide: "AUR5X1", order: "KP124158", status: "entregado", amount: 120 },
          { guide: null, order: null, status: "no entregó", amount: null },
        ],
      }) +
      "\n```\nEso es todo.";
    const res = parseSettlementVision(text);
    expect(res).not.toBeNull();
    expect(res!.riderName).toBe("Luis Quispe");
    expect(res!.settlementDate).toBe("2026-07-24");
    expect(res!.lines).toHaveLength(2);
    expect(res!.lines[0]).toMatchObject({ guide_code: "AUR5X1", declared_amount: 120 });
  });

  it("descarta la fila que no dice nada", () => {
    const res = parseSettlementVision(
      JSON.stringify({ lines: [{ guide: null, order: null, status: null, amount: null }] }),
    );
    expect(res!.lines).toHaveLength(0);
  });

  it("un monto en texto se convierte, uno ilegible queda en null", () => {
    const res = parseSettlementVision(
      JSON.stringify({
        lines: [
          { guide: "G1", amount: "S/ 45,50" },
          { guide: "G2", amount: "ilegible" },
        ],
      }),
    );
    expect(res!.lines[0]!.declared_amount).toBe(45.5);
    expect(res!.lines[1]!.declared_amount).toBeNull();
  });

  it("una fecha a medias es ninguna fecha", () => {
    expect(parseSettlementVision(JSON.stringify({ date: "24/07", lines: [] }))!.settlementDate)
      .toBeNull();
    expect(parseSettlementVision(JSON.stringify({ date: "2026-13-45", lines: [] }))!.settlementDate)
      .toBeNull();
  });

  it("devuelve null si la respuesta no trae JSON", () => {
    expect(parseSettlementVision("no pude leer la foto")).toBeNull();
    expect(parseSettlementVision("")).toBeNull();
  });

  it("una respuesta sin líneas es una hoja vacía, no un error", () => {
    const res = parseSettlementVision(JSON.stringify({ rider_name: null, lines: [] }));
    expect(res).not.toBeNull();
    expect(res!.lines).toHaveLength(0);
  });

  it("lee las columnas contables de una foto del reporte Axel", () => {
    const res = parseSettlementVision(
      JSON.stringify({
        date: "2026-07-27",
        lines: [
          {
            store: "AURELA",
            customer: "Elías Abanto",
            district: "Jicamarca",
            status: "EFECTIVO",
            payment_method: "EFECTIVO",
            amount: 149,
            fee: 15,
          },
          {
            store: "KENKU",
            customer: "Remigio",
            district: "Pariachi",
            status: "NO CONTESTO",
            payment_method: "NO CONTESTO",
            amount: 0,
            fee: null,
          },
        ],
      }),
    );

    expect(res!.lines[0]).toMatchObject({
      store_hint: "AURELA",
      customer_name: "Elías Abanto",
      district: "Jicamarca",
      declared_status: "EFECTIVO",
      payment_method: "EFECTIVO",
      declared_amount: 149,
      declared_fee: 15,
    });
    expect(res!.lines[1]).toMatchObject({
      store_hint: "KENKU",
      payment_method: null,
      declared_status: "NO CONTESTO",
      declared_amount: 0,
    });
  });
});
