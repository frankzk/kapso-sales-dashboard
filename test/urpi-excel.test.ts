import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { readUrpiExcelWorkbook } from "@/lib/urpi-excel";
import { parseUrpiProgramming } from "@/lib/urpi-programming";

const headers = ["Validación", "Fecha de entrega", "Tipo de Envio", "Asesor", "Código de pedido", "Destinatario", "Número de contacto", "Provincia", "Distrito", "Dirección", "Referencia", "Producto a entregar", "Monto a Cobrar", "Número de referencia", "Observaciones"];

describe("Excel mensual exportado de Google", () => {
  it("recupera fechas de pestañas sin barras y fórmulas sin caché, conservando la fila", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("011026");
    sheet.getRow(5).values = headers;
    sheet.getRow(6).values = ["", { formula: 'CELL("sheet",A6)' }, "Primer Turno", "", "#KP123", "Cliente", "900000000", "Lima", "Rímac", "Dirección", "", "1 Producto", 149];
    sheet.getRow(8).values = ["", new Date("2026-10-01T00:00:00Z"), "Primer Turno", "", "#AUR123", "Cliente", "900000000", "Lima", "Rímac", "Dirección", "", "1 Producto", { formula: "100+49", result: 149 }];
    const tabs = await readUrpiExcelWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(tabs[0]?.title).toBe("01/10/26");
    const kenku = parseUrpiProgramming(tabs, "2026-10", "KP");
    expect(kenku.rows[0]).toMatchObject({ date: "2026-10-01", dateWritten: "", rowNumber: 6, amount: 149, issues: ["Fecha tomada de la pestaña"] });
    const aurela = parseUrpiProgramming(tabs, "2026-10", "AUR");
    expect(aurela.rows[0]).toMatchObject({ date: "2026-10-01", rowNumber: 8, amount: 149, issues: [] });
  });

  it("rechaza pestañas que se convierten en una misma fecha", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("011026");
    workbook.addWorksheet("01-10-26");
    await expect(readUrpiExcelWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()))).rejects.toThrow("misma fecha");
  });

  it("tolera cachés de fórmula de fecha incompatibles con Excel", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("021026");
    sheet.getRow(5).values = headers;
    sheet.getRow(6).values = ["", { formula: 'CELL("sheet",A6)', result: "02/10/26" }, "Primer Turno", "", "#KP124", "Cliente", "900000000", "Lima", "Rímac", "Dirección", "", "1 Producto", 149];
    sheet.getCell("B6").numFmt = "dd/mm/yy";
    const tabs = await readUrpiExcelWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(parseUrpiProgramming(tabs, "2026-10", "KP").rows[0]?.date).toBe("2026-10-02");
  });
});
