import { describe, expect, it } from "vitest";
import { parseCsv, parseUrpiReport, urpiPhone, urpiPreviousRow, urpiReportDate, urpiResultCode } from "@/lib/urpi-report";

// Cabecera real del export de AppSheet («Reporte del mes – detallado»), con el
// `;` final que deja una columna vacía. Los datos son inventados.
const HEADER = '﻿"_RowNumber";"Destinatario";"Provincia";"Resultado";"Método de pago";"Monto Cobrado";"Cobro servicio*";"Motivo principal (solo canc/repro)";"Detalle de entrega / cancelación / reprogramación";"Evidencia de entrega 1";"Evidencia de entrega 2";"Producto";"Dirección";"Número de teléfono";"New Virtual Column";"Asesor de venta";"Comisiones POS u otros";"Estatus final: Entregado";"Estatus final: Cancelado";"Fecha envío";"Row number relacionado";"Costo producto (proveedor externo)";"Ubicación de cierre";"PROVEEDOR ASOCIADO";"Tienda";"Contacto mediante Whatsapp API";"Row number";';
type Cells = Partial<Record<"row" | "name" | "result" | "method" | "amount" | "fee" | "reason" | "detail" | "ev1" | "phone" | "pos" | "fin" | "fca" | "date" | "prev" | "store", string>>;
const line = (c: Cells) => [
  c.row ?? "2,323", c.name ?? "Cliente Prueba", "Lima", c.result ?? "Reprogramado", c.method ?? "-", c.amount ?? "", c.fee ?? "",
  c.reason ?? "No contesta", c.detail ?? "Soporte: volver a llamar\nMotorizado: NC", c.ev1 ?? "https://api.routal.com/v3/stop/report/x/image/y/public", "",
  "Producto de prueba", "Calle Falsa 123 ||\nSurco ||", c.phone ?? "900000001", "https://api.whatsapp.com/send/?phone=900000001", "", c.pos ?? "-",
  c.fin ?? "N", c.fca ?? "N", c.date ?? "3/10/2026", c.prev ?? "", "", "", "", c.store ?? "", "Sin respuesta", "", "",
].map((value) => `"${value.replace(/"/g, '""')}"`).join(";");
const csv = (...rows: Cells[]) => [HEADER, ...rows.map(line)].join("\n");

describe("lector del reporte de Urpi", () => {
  it("lee el export real: separador `;`, comillas y saltos de línea dentro de la celda", () => {
    const report = parseUrpiReport(csv({}));
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      urpiRow: 2323, previousRow: null, reportDate: "2026-10-03", resultWritten: "Reprogramado", resultCode: "reprogramado",
      reason: "No contesta", detail: "Soporte: volver a llamar\nMotorizado: NC", phone: "900000001", paymentMethod: null,
      amountCollected: null, serviceFee: null, posFee: null, finalDelivered: false, finalCancelled: false, whatsappStatus: "Sin respuesta",
      evidence: ["https://api.routal.com/v3/stop/report/x/image/y/public"],
    });
  });
  it("conserva el cobro de una entrega", () => {
    const [row] = parseUrpiReport(csv({ result: "Entregado", method: "Plin/Yape URPI OD", amount: "89.9", fee: "12", reason: "-", pos: "4.95" })).rows;
    expect(row).toMatchObject({ resultCode: "entregado", paymentMethod: "Plin/Yape URPI OD", amountCollected: 89.9, serviceFee: 12, posFee: 4.95, reason: null });
  });
  it("recupera el número de la fila anterior aunque el export lo pinte como fecha", () => {
    expect(urpiPreviousRow("24/04/1906")).toBe(2306);
    expect(urpiPreviousRow("6/12/1900")).toBe(341);
    expect(urpiPreviousRow("2,306")).toBe(2306);
    expect(urpiPreviousRow("")).toBeNull();
    expect(urpiPreviousRow("3/10/2026")).toBeNull();
    const report = parseUrpiReport(csv({ row: "2,306" }, { row: "2,323", prev: "24/04/1906" }));
    expect(report.rows.map((row) => [row.urpiRow, row.previousRow])).toEqual([[2306, null], [2323, 2306]]);
  });
  it("no adivina estados: lo desconocido queda marcado y se informa", () => {
    expect(urpiResultCode("En coordinación")).toBe("en_coordinacion");
    expect(urpiResultCode("")).toBe("sin_resultado");
    const report = parseUrpiReport(csv({ result: "Pronto a entregar" }));
    expect(report.rows[0]!.resultCode).toBe("otro");
    expect(report.unknownResults).toEqual(["Pronto a entregar"]);
  });
  it("normaliza teléfono y fecha sin inventar datos", () => {
    expect(urpiPhone("51 912 345 678")).toBe("912345678");
    expect(urpiPhone("912345678")).toBe("912345678");
    for (const value of ["", "12345678", "9123456789012", "812345678"]) expect(urpiPhone(value)).toBeNull();
    expect(urpiReportDate("30/9/2026")).toBe("2026-09-30");
    expect(urpiReportDate("31/9/2026")).toBeNull();
  });
  it("rechaza un archivo que no es el reporte o con filas repetidas", () => {
    expect(() => parseUrpiReport('"Fecha";"Pedido"\n"1/10/2026";"KP1"')).toThrow("No se reconoce");
    expect(() => parseUrpiReport(csv({ row: "7" }, { row: "7" }))).toThrow("repetido");
    expect(() => parseUrpiReport(csv({ row: "" }))).toThrow("número de fila");
    expect(() => parseCsv('"a";"b\n')).toThrow("comillas");
  });
  it("lee también un CSV separado por comas", () => {
    expect(parseCsv('a,b\n"1,5",2\n')).toEqual([["a", "b"], ["1,5", "2"]]);
  });
});
