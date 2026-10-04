// El cruce de «Validar pagos» con el estado de cuenta de Yape (MOM §16.2).
//
// Los casos son los del 04-10-2026, cuando se cruzó a mano el primer reporte:
// 66 comprobantes cuadraban al 100 % y 9 solo «casi». Lo que se fija aquí es
// esa frontera: lo que el cruce valida solo y lo que deja a una persona.

import { describe, expect, it } from "vitest";
import {
  channelFitsCourier,
  matchStatement,
  payerIsPerson,
  type MatchableMovement,
  type StatementPayment,
} from "@/lib/yape-statement/match";
import {
  parseStatementAmount,
  parseStatementInstant,
  parseStatementRows,
  splitOrigin,
} from "@/lib/yape-statement/parse";

function pago(over: Partial<StatementPayment>): StatementPayment {
  return {
    id: over.id ?? "p1",
    orderName: over.orderName ?? "#KP1",
    kind: "adelanto",
    amount: 30,
    paidAt: null,
    registeredAt: "2026-10-04T23:00:00.000Z",
    status: "pendiente_revision",
    operationNumber: "12345678",
    operationTypedBy: null,
    customerName: null,
    payerName: null,
    courierMethod: null,
    courierToYape: null,
    ...over,
  };
}

function mov(origin: string, amount: number, occurredAt: string, key = origin + occurredAt): MatchableMovement {
  const { channel, payerName } = splitOrigin(origin);
  return { key, origin, channel, payerName, amount, occurredAt };
}

const NADA = { movementKeys: new Set<string>(), paymentIds: new Set<string>() };

describe("parseo del reporte de Yape", () => {
  it("monto, hora de Lima y canal", () => {
    expect(parseStatementAmount("S/ 20.00")).toBe(20);
    expect(parseStatementAmount("S/ 1,234.50")).toBe(1234.5);
    expect(parseStatementAmount("veinte")).toBeNull();
    expect(parseStatementInstant("04/10/2026 11:43:05")).toBe("2026-10-04T16:43:05.000Z");
    // Si exceljs ya la volvió fecha, la hora de la pared sigue siendo la de Lima.
    expect(parseStatementInstant("2026-10-04T11:43:05.000Z")).toBe("2026-10-04T16:43:05.000Z");
    expect(splitOrigin("PLIN - ROY RIDER LOPEZ VILLACORTA")).toEqual({
      channel: "PLIN",
      payerName: "ROY RIDER LOPEZ VILLACORTA",
    });
    expect(splitOrigin("Benito Cac*")).toEqual({ channel: "YAPE", payerName: "Benito Cac*" });
    expect(splitOrigin("PREXPE - Erick Jesus Sanchez").channel).toBe("PREXPE");
  });

  it("encuentra la tabla bajo el título y no funde dos pagos idénticos", () => {
    const rows = [
      [],
      ["Reporte de Movimientos"],
      [],
      [],
      ["Movimiento", "Origen", "Destino", "Monto", "Fecha de operación", "Datos adicionales"],
      ["Ingreso", "Carmen Tas*", "GRUPO GF  S.A.C.", "S/ 20.00", "04/10/2026 11:43:05", "pulsera"],
      ["Ingreso", "Luis Bon*", "GRUPO GF  S.A.C.", "S/ 30.00", "04/10/2026 09:42:34", ""],
      ["Ingreso", "Luis Bon*", "GRUPO GF  S.A.C.", "S/ 30.00", "04/10/2026 09:42:34", ""],
      ["Egreso", "GRUPO GF  S.A.C.", "Servicio Yape Empresa 3 Oct", "S/ 335.68", "04/10/2026 05:48:36", ""],
      ["Ingreso", "Ilegible", "GRUPO GF  S.A.C.", "S/ ??", "04/10/2026 05:48:36", ""],
    ];
    const p = parseStatementRows(rows);
    expect(p.movements).toHaveLength(4);
    expect(p.unreadable).toBe(1);
    expect(p.movements.filter((m) => m.kind === "egreso")).toHaveLength(1);
    const dobles = p.movements.filter((m) => m.origin === "Luis Bon*");
    expect(new Set(dobles.map((m) => m.key)).size).toBe(2);
    expect(p.from).toBe("2026-10-04T10:48:36.000Z");
    expect(p.to).toBe("2026-10-04T16:43:05.000Z");
  });

  it("el mismo movimiento da la misma llave en dos reportes", () => {
    const fila = ["Ingreso", "Benito Cac*", "GRUPO GF  S.A.C.", "S/ 30.00", "04/10/2026 09:22:42", ""];
    const head = ["Movimiento", "Origen", "Destino", "Monto", "Fecha de operación", "Datos adicionales"];
    const a = parseStatementRows([head, fila]).movements[0]!.key;
    const b = parseStatementRows([["Reporte"], head, ["Ingreso", "Otra*", "X", "S/ 1.00", "04/10/2026 09:00:00", ""], fila])
      .movements[1]!.key;
    expect(a).toBe(b);
  });
});

describe("¿el pagador es la clienta?", () => {
  it("Yape recorta a nombre + tres letras del apellido", () => {
    expect(payerIsPerson("Benito Cac*", "YAPE", "Benito Cachique puga")).toBe(true);
    expect(payerIsPerson("Elen Gar*", "YAPE", "Elén Gargate Rosado")).toBe(true);
    expect(payerIsPerson("Juan Sau*", "YAPE", "Juan Ruperto Saucedo Carranza")).toBe(true);
  });

  it("un apellido que encaja con otro nombre de pila no basta", () => {
    // #KP138646: «Luis Pal*» pagó el pedido de Alfredo Palao. Puede ser un
    // familiar, pero eso lo decide una persona.
    expect(payerIsPerson("Luis Pal*", "YAPE", "Alfredo Palao")).toBe(false);
    expect(payerIsPerson("Tito Gab*", "YAPE", "Gilberto gabino")).toBe(false);
    expect(payerIsPerson("Carlo Lop*", "YAPE", "letsy Silvia Quintana")).toBe(false);
  });

  it("las otras apps traen el nombre completo, a veces con los apellidos delante", () => {
    expect(payerIsPerson("QUISPE ARELA JUAN MARTIN", "BCP", "JUAN MARTIN\t QUISPE\tARELA")).toBe(true);
    expect(payerIsPerson("ALVARO ROMAN REMUZGO", "PLIN", "Alvaro Remuzgo")).toBe(true);
    expect(payerIsPerson("Juan C. Penadillo C.", "YAPE", "Juan Carlos Penadillo Chavez")).toBe(true);
    expect(payerIsPerson("JOSE CARLOS LAMAS ARRIAGA", "PLIN", "JOSE JOSE")).toBe(false);
  });

  it("el canal del courier sigue a la app de la constancia", () => {
    expect(channelFitsCourier("yape", "YAPE")).toBe(true);
    expect(channelFitsCourier("yape", "PLIN")).toBe(false);
    expect(channelFitsCourier("plin", "PLIN")).toBe(true);
    expect(channelFitsCourier("otro", "PREXPE")).toBe(true);
    expect(channelFitsCourier("otro", "YAPE")).toBe(false);
    expect(channelFitsCourier("bcp", "BCP")).toBe(true);
  });
});

describe("matchStatement", () => {
  it("monto + minuto + clienta → conciliado (#KP138765)", () => {
    const p = pago({ paidAt: "2026-10-04T14:22:00.000Z", customerName: "Benito Cachique puga" });
    const r = matchStatement([mov("Benito Cac*", 30, "2026-10-04T14:22:42.000Z")], [p], [p], NADA);
    expect(r.matches).toEqual([
      { paymentId: "p1", movementKey: "Benito Cac*2026-10-04T14:22:42.000Z", rule: "minuto_y_clienta", deltaSeconds: 42 },
    ]);
  });

  it("un Yape directo cae dentro de su minuto, no en el siguiente", () => {
    const p = pago({ paidAt: "2026-10-04T14:22:00.000Z", customerName: "Benito Cachique puga" });
    const r = matchStatement([mov("Benito Cac*", 30, "2026-10-04T14:23:01.000Z")], [p], [p], NADA);
    expect(r.skipped[0]?.reason).toBe("sin_movimiento");
  });

  it("la hora guardada 12 h antes por el «p. m.» perdido (#KP138402)", () => {
    // La ficha dice 02:15 de Lima; el reporte, 14:15:08. Se subió a las 14:24.
    const p = pago({
      paidAt: "2026-10-02T07:15:00.000Z",
      registeredAt: "2026-10-02T19:24:39.000Z",
      customerName: "Mercedes Quispe huyhua",
    });
    const r = matchStatement([mov("Mercedes Qui*", 30, "2026-10-02T19:15:08.000Z")], [p], [p], NADA);
    expect(r.matches[0]?.rule).toBe("minuto_y_clienta_pm");
  });

  it("…pero no si ese pago de la tarde sería posterior a subir la constancia", () => {
    const p = pago({
      paidAt: "2026-10-02T07:15:00.000Z",
      registeredAt: "2026-10-02T12:00:00.000Z",
      customerName: "Mercedes Quispe huyhua",
    });
    const r = matchStatement([mov("Mercedes Qui*", 30, "2026-10-02T19:15:08.000Z")], [p], [p], NADA);
    expect(r.skipped[0]?.reason).toBe("sin_movimiento");
  });

  it("mismo monto y minuto pero pagó otra persona: lo decide alguien (#KP138808)", () => {
    const p = pago({ paidAt: "2026-10-04T12:41:00.000Z", customerName: "letsy Silvia Quintana" });
    const r = matchStatement([mov("Carlo Lop*", 30, "2026-10-04T12:41:51.000Z")], [p], [p], NADA);
    expect(r.matches).toHaveLength(0);
    expect(r.skipped[0]?.reason).toBe("sin_movimiento");
  });

  it("el pago validado de otro pedido en el mismo minuto no estorba si es de otra persona (#KP138593)", () => {
    const esmelida = pago({ id: "e", paidAt: "2026-10-03T13:20:00.000Z", customerName: "Esmelida Gatica Odagawa" });
    const david = pago({
      id: "d",
      status: "validado",
      paidAt: "2026-10-03T13:19:00.000Z",
      customerName: "David vela silva",
    });
    const movs = [
      mov("David Vel*", 30, "2026-10-03T13:19:19.000Z"),
      mov("Esmelida Gat*", 30, "2026-10-03T13:20:09.000Z"),
    ];
    const r = matchStatement(movs, [esmelida], [esmelida, david], NADA);
    expect(r.matches.map((m) => m.paymentId)).toEqual(["e"]);
  });

  it("si otro pago vivo también encaja con el movimiento, nadie lo toma", () => {
    const a = pago({ id: "a", orderName: "#KP1", paidAt: "2026-10-04T14:22:00.000Z", customerName: "Benito Cachique" });
    const b = pago({ id: "b", orderName: "#KP2", status: "validado", paidAt: "2026-10-04T14:22:00.000Z", customerName: "Benito Cachique" });
    const r = matchStatement([mov("Benito Cac*", 30, "2026-10-04T14:22:42.000Z")], [a], [a, b], NADA);
    expect(r.skipped[0]).toEqual({ paymentId: "a", reason: "movimiento_disputado", detail: "#KP2" });
  });

  it("dos movimientos posibles para un comprobante: tampoco", () => {
    const p = pago({ paidAt: "2026-10-04T14:22:00.000Z", customerName: "Benito Cachique" });
    const movs = [mov("Benito Cac*", 30, "2026-10-04T14:22:05.000Z", "k1"), mov("Benito Cac*", 30, "2026-10-04T14:22:50.000Z", "k2")];
    expect(matchStatement(movs, [p], [p], NADA).skipped[0]?.reason).toBe("varios_movimientos");
  });

  it("cobro de courier: monto + minuto + canal (#AUR177586, paga el motorizado)", () => {
    const p = pago({
      kind: "cobro_courier",
      amount: 116.1,
      paidAt: "2026-10-01T00:01:00.000Z",
      customerName: "Maria Isabel",
      courierMethod: "yape",
      courierToYape: true,
      registeredAt: "2026-10-01T02:00:39.000Z",
    });
    const r = matchStatement([mov("Jesus Alv*", 116.1, "2026-10-01T00:01:21.000Z")], [p], [p], NADA);
    expect(r.matches[0]?.rule).toBe("minuto_y_canal");
  });

  it("courier por BBVA: entra como Plin, no como el Yape directo del minuto siguiente (#KP138054)", () => {
    const p = pago({
      kind: "cobro_courier",
      amount: 149,
      paidAt: "2026-10-03T20:03:00.000Z",
      courierMethod: "otro",
      courierToYape: true,
    });
    const movs = [
      mov("Edinson Gon*", 149, "2026-10-03T20:04:05.000Z"),
      mov("PLIN - JOSE CARLOS LAMAS ARRIAGA", 149, "2026-10-03T20:03:09.000Z"),
    ];
    const r = matchStatement(movs, [p], [p], NADA);
    expect(r.matches[0]?.movementKey).toBe("PLIN - JOSE CARLOS LAMAS ARRIAGA2026-10-03T20:03:09.000Z");
  });

  it("un Plin se da un minuto de holgura por el reloj de su app (#KP137950)", () => {
    const p = pago({
      kind: "cobro_courier",
      amount: 298,
      paidAt: "2026-10-01T21:02:00.000Z",
      courierMethod: "plin",
      courierToYape: true,
    });
    const r = matchStatement([mov("PLIN - JAVIER MENDOZA", 298, "2026-10-01T21:01:51.000Z")], [p], [p], NADA);
    expect(r.matches[0]?.deltaSeconds).toBe(-9);
  });

  it("una transferencia a la cuenta BCP no está en el reporte de Yape (#AUR176149)", () => {
    const p = pago({ kind: "cobro_courier", amount: 99, paidAt: "2026-09-29T18:27:00.000Z", courierMethod: "bcp", courierToYape: false });
    expect(matchStatement([], [p], [p], NADA).skipped[0]?.reason).toBe("no_fue_a_yape");
  });

  it("lo que no se cruza nunca: sin hora, nº transcrito a mano, ya conciliado, otra cola", () => {
    const base = { customerName: "Benito Cachique", paidAt: "2026-10-04T14:22:00.000Z" };
    const movs = [mov("Benito Cac*", 30, "2026-10-04T14:22:42.000Z", "k")];
    const casos: [Partial<StatementPayment>, string][] = [
      [{ paidAt: null }, "sin_hora"],
      [{ operationNumber: null }, "sin_operacion"],
      [{ operationTypedBy: "user-1" }, "operacion_transcrita"],
      [{ status: "revision_admin" }, "no_pendiente"],
    ];
    for (const [over, reason] of casos) {
      const p = pago({ ...base, ...over });
      expect(matchStatement(movs, [p], [p], NADA).skipped[0]?.reason).toBe(reason);
    }
    const p = pago(base);
    expect(
      matchStatement(movs, [p], [p], { movementKeys: new Set(["k"]), paymentIds: new Set() }).skipped[0]?.reason,
    ).toBe("sin_movimiento");
    expect(
      matchStatement(movs, [p], [p], { movementKeys: new Set(), paymentIds: new Set(["p1"]) }).skipped[0]?.reason,
    ).toBe("ya_conciliado");
  });
});
