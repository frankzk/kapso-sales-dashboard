// La bitácora del estado de cuenta de Yape (MOM §16.2): cada reporte recibido y
// lo que validó. Se fija lo que la pestaña promete: que cada pago cuelgue del
// reporte que lo validó, que el reenvío del mismo correo se diga, que lo
// omitido se explique y que un pago que una persona deshizo después no se
// siga mostrando como validado sin más.

import { describe, expect, it } from "vitest";
import {
  buildStatementLog,
  limaDateTime,
  limaMovementTime,
  limaPeriod,
  statementRuleLabel,
  statementSkipLabel,
  type StatementImportRow,
} from "@/lib/yape-statement/log";

function reporte(over: Partial<StatementImportRow> & { id: string; created_at: string }): StatementImportRow {
  return {
    message_id: `msg-${over.id}`,
    file_name: "YAPE_REPORTE_MOVIMIENTOS_04102026.xlsx",
    received_at: null,
    period_from: "2026-09-28T10:34:20Z",
    period_to: "2026-10-04T21:50:03Z",
    movements: 662,
    new_movements: 13,
    unreadable: 0,
    report: {},
    error: null,
    finished_at: over.created_at,
    ...over,
  };
}

describe("buildStatementLog", () => {
  const imports = [
    reporte({
      id: "mañana",
      message_id: "correo-1",
      received_at: "2026-10-04T17:32:51Z",
      created_at: "2026-10-04T22:25:28Z",
      movements: 1301,
      new_movements: 1301,
      report: { omitidos: { sin_movimiento: 10, no_fue_a_yape: 3 }, horas_courier: { filled: 38 } },
    }),
    reporte({
      id: "tarde",
      message_id: "correo-2",
      received_at: "2026-10-04T22:37:03Z",
      created_at: "2026-10-04T23:54:38Z",
      report: { omitidos: { no_fue_a_yape: 3, sin_movimiento: 8 }, horas_courier: { filled: 1 } },
    }),
    reporte({
      id: "reenvio",
      message_id: "correo-1",
      received_at: "2026-10-04T17:32:51Z",
      created_at: "2026-10-04T23:54:45Z",
      new_movements: 0,
      report: { omitidos: { sin_movimiento: 8 } },
    }),
  ];
  const matches = [
    { import_id: "tarde", payment_id: "p-1", order_id: "o-1", movement_key: "m-1", rule: "minuto_y_clienta" },
    { import_id: "tarde", payment_id: "p-2", order_id: "o-2", movement_key: "m-2", rule: "minuto_y_canal" },
    { import_id: "mañana", payment_id: "p-3", order_id: "o-3", movement_key: "m-3", rule: "minuto_y_clienta_pm" },
    // Sin reporte (se borró): no cuelga de ninguno.
    { import_id: null, payment_id: "p-4", order_id: "o-4", movement_key: "m-4", rule: "minuto_y_clienta" },
  ];
  const movements = [
    { movement_key: "m-1", origin: "Ramón Med*", amount: "30.00", occurred_at: "2026-10-04T07:34:10Z" },
    { movement_key: "m-2", origin: "PLIN - JUAN PEREZ", amount: 149, occurred_at: "2026-10-04T20:02:59Z" },
    { movement_key: "m-3", origin: "Benito Cac*", amount: 30, occurred_at: "2026-10-04T14:22:42Z" },
    { movement_key: "m-4", origin: "Otra Per*", amount: 50, occurred_at: "2026-10-04T14:00:00Z" },
  ];
  const payments = [
    { id: "p-1", kind: "adelanto", validation_status: "validado" },
    { id: "p-2", kind: "cobro_courier", validation_status: "rechazado" },
    { id: "p-3", kind: "diferencia", validation_status: "validado" },
  ];
  const orders = [
    { order_id: "o-1", order_name: "#KP138824", customer_name: "Ramón medina cruz" },
    { order_id: "o-2", order_name: "#AUR177808", customer_name: "Juan Pérez" },
    { order_id: "o-3", order_name: "#KP138765", customer_name: "Benito Cachique puga" },
  ];
  const log = buildStatementLog({ imports, matches, movements, payments, orders });

  it("lista los correos del último recibido al primero; un reproceso va tras la vez que contó", () => {
    // «reenvio» se procesó el último, pero es el correo de la mañana.
    expect(log.entries.map((e) => e.id)).toEqual(["tarde", "mañana", "reenvio"]);
    expect(log.truncated).toBe(false);
  });

  it("cada pago cuelga del reporte que lo validó, el movimiento más reciente primero", () => {
    const tarde = log.entries.find((e) => e.id === "tarde")!;
    expect(tarde.matches.map((m) => m.orderName)).toEqual(["#AUR177808", "#KP138824"]);
    expect(tarde.matches[1]).toEqual(
      expect.objectContaining({
        orderId: "o-1",
        customerName: "Ramón medina cruz",
        kind: "adelanto",
        payer: "Ramón Med*",
        amount: 30,
        rule: "minuto_y_clienta",
        laterStatus: null,
      }),
    );
    expect(log.entries.find((e) => e.id === "mañana")!.matches.map((m) => m.paymentId)).toEqual(["p-3"]);
    expect(log.entries.flatMap((e) => e.matches).some((m) => m.paymentId === "p-4")).toBe(false);
  });

  it("un pago que una persona deshizo después lo dice", () => {
    const courier = log.entries.find((e) => e.id === "tarde")!.matches[0]!;
    expect(courier.laterStatus).toBe("Rechazado después");
  });

  it("el mismo correo procesado dos veces se marca como reenvío", () => {
    const [tarde, mañana, reenvio] = log.entries;
    expect(reenvio!.repeatOf).toBe("2026-10-04T22:25:28Z");
    expect(reenvio!.matches).toEqual([]);
    expect(tarde!.repeatOf).toBeNull();
    expect(mañana!.repeatOf).toBeNull();
  });

  it("lo que quedó sin validar se explica por motivo, el más frecuente primero", () => {
    const tarde = log.entries.find((e) => e.id === "tarde")!;
    expect(tarde.leftPending).toBe(11);
    expect(tarde.skipped).toEqual([
      { reason: "sin_movimiento", label: statementSkipLabel("sin_movimiento"), count: 8 },
      { reason: "no_fue_a_yape", label: statementSkipLabel("no_fue_a_yape"), count: 3 },
    ]);
    expect(tarde.courierTimesFilled).toBe(1);
    expect(log.entries.find((e) => e.id === "mañana")!.courierTimesFilled).toBe(38);
  });

  it("un reporte que falló muestra el error aunque el informe venga vacío", () => {
    const fallido = buildStatementLog({
      imports: [
        reporte({
          id: "x",
          created_at: "2026-10-05T12:00:00Z",
          finished_at: null,
          error: "el reporte no trae ingresos legibles",
          report: {},
        }),
      ],
      matches: [],
      movements: [],
      payments: [],
      orders: [],
      truncated: true,
    });
    expect(fallido.entries[0]).toEqual(
      expect.objectContaining({ finished: false, errors: ["el reporte no trae ingresos legibles"], leftPending: 0 }),
    );
    expect(fallido.truncated).toBe(true);
  });
});

describe("textos de la bitácora", () => {
  it("las horas van en hora de Lima, escritas a mano", () => {
    expect(limaDateTime("2026-10-04T22:37:03Z")).toBe("04/10/2026, 5:37 p. m.");
    expect(limaDateTime("2026-10-04T05:05:00Z")).toBe("04/10/2026, 12:05 a. m.");
    expect(limaDateTime("2026-10-04T17:00:00Z")).toBe("04/10/2026, 12:00 p. m.");
    expect(limaDateTime(null)).toBe("—");
    expect(limaMovementTime("2026-10-04T14:22:42Z")).toBe("04/10, 09:22:42");
    expect(limaPeriod("2026-09-28T10:34:20Z", "2026-10-04T21:50:03Z")).toBe("28/09 al 04/10");
    expect(limaPeriod(null, "2026-10-04T21:50:03Z")).toBeNull();
  });

  it("cada regla y cada motivo tienen su frase, y lo desconocido no se pierde", () => {
    expect(statementRuleLabel("minuto_y_canal")).toMatch(/canal del courier/);
    expect(statementRuleLabel("regla_nueva")).toBe("regla_nueva");
    expect(statementSkipLabel("receptor_no_cuadra")).toMatch(/cuenta receptora/);
    expect(statementSkipLabel("motivo_nuevo")).toBe("Motivo nuevo");
  });
});
