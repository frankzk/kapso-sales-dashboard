import { describe, expect, it } from "vitest";
import { nextUrpiDeliveryDate, normalizeUrpiOrder, parseUrpiProgramming, spreadsheetIdFromUrl, urpiDateIso, urpiPrefixesSeparable, urpiStorePrefix, type UrpiTab } from "@/lib/urpi-programming";

const headers = ["Validación", "Fecha de entrega", "Tipo de Envio", "Asesor", "Código de pedido", "Destinatario", "Número de contacto", "Provincia", "Distrito", "Dirección", "Referencia", "Producto a entregar", "Monto a Cobrar", "Número de referencia", "Observaciones"];
const row = (code = "#kp12345", date = "01/10/26", amount: unknown = "149.00") => ["FUERA DE HORARIO", date, "Primer Turno", "", code, "Cliente de prueba", "900000000", "Lima", "Rímac", "Dirección de prueba", "", "1 Producto", amount, "", "Coordinar"];
const tab = (rows: unknown[][], title = "01/10/26"): UrpiTab => ({ title, sheetId: 159874937, values: [[], ["Notas"], [], [], headers, ...rows] });

describe("programaciones mensuales Urpi", () => {
  it("lee la cabecera de la fila 5 y mantiene procedencia, fecha y montos", () => {
    const result = parseUrpiProgramming([tab([row()])], "2026-10", "KP");
    expect(result.rows[0]).toMatchObject({ orderCode: "KP12345", date: "2026-10-01", rowNumber: 6, amount: 149, sheetId: 159874937, orderId: null, issues: [] });
    expect(result.tabs).toEqual([{ title: "01/10/26", sheetId: 159874937, count: 1 }]);
    expect(result.rows[0]).not.toHaveProperty("deliveryStatus");
  });
  it("aísla los prefijos de cada tienda y las pestañas del mes elegido", () => {
    const result = parseUrpiProgramming([tab([row(), row("#AUR999")]), tab([row("#KP888", "30/09/26")], "30/09/26")], "2026-10", "AUR");
    expect(result.rows.map((r) => r.orderCode)).toEqual(["AUR999"]);
  });
  it("conserva repetidos y distintas programaciones sin inventar intentos", () => {
    const result = parseUrpiProgramming([tab([row(), row()]), tab([row("#KP12345", "02/10/26")], "02/10/26")], "2026-10", "KP");
    expect(result.rows).toHaveLength(3);
    expect(result.rows.slice(0, 2).every((r) => r.issues.includes("Pedido repetido en la misma fecha"))).toBe(true);
    expect(result.rows[2]?.issues).toEqual([]);
  });
  it("no interpreta Validación como estado de entrega y marca fechas contradictorias", () => {
    const result = parseUrpiProgramming([tab([row("#KP12345", "02/10/26")])], "2026-10", "KP");
    expect(result.rows[0]?.issues).toContain("La fecha de entrega difiere de la pestaña");
    expect(result.rows[0]?.dateWritten).toBe("02/10/26");
  });
  it("preserva fecha escrita inválida y no convierte montos vacíos en cero", () => {
    const result = parseUrpiProgramming([tab([row("#KP12345", "31/02/26", ""), row("#KP23456", "", "0")])], "2026-10", "KP");
    expect(result.rows[0]).toMatchObject({ date: "2026-10-01", dateWritten: "31/02/26", amount: null });
    expect(result.rows[1]?.amount).toBe(0);
    expect(result.rows[0]?.issues).toHaveLength(2);
  });
  it("rechaza otro formato, mes, prefijo o código roto en vez de importar parcialmente", () => {
    expect(() => parseUrpiProgramming([{ title: "01/10/26", sheetId: null, values: [["Cliente"]] }], "2026-10", "KP")).toThrow("cabecera");
    expect(() => parseUrpiProgramming([tab([row()])], "2026-09", "KP")).toThrow("pestañas");
    expect(() => parseUrpiProgramming([tab([row()])], "2026-13", "KP")).toThrow("mes");
    expect(() => parseUrpiProgramming([tab([row()])], "2026-10", ".*")).toThrow("prefijo");
    expect(() => parseUrpiProgramming([tab([row("#KP?")])], "2026-10", "KP")).toThrow("fila 6");
  });
  it("valida enlaces sin permitir hosts externos o credenciales en URL", () => {
    const id = "13v6LVlETx17NWAN1jgWJzCHxR-7GoWOHk3llf2RzAgc";
    expect(spreadsheetIdFromUrl(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=123`)).toBe(id);
    for (const value of [`https://evil.test/spreadsheets/d/${id}`, `https://docs.google.com.evil.test/spreadsheets/d/${id}`, `https://user@docs.google.com/spreadsheets/d/${id}`, `http://docs.google.com/spreadsheets/d/${id}`]) expect(() => spreadsheetIdFromUrl(value)).toThrow();
  });
  it("normaliza código sin basarse en el nombre del destinatario", () => {
    expect(normalizeUrpiOrder(" # kp12345 ")).toBe("KP12345");
    expect(urpiDateIso("31/02/26")).toBeNull();
    expect(urpiDateIso("29/02/28")).toBe("2028-02-29");
  });
  it("señala filas con cliente sin código sin atribuirlas a una tienda", () => {
    const result = parseUrpiProgramming([tab([row("")])], "2026-10", "KP");
    expect(result.rows).toHaveLength(0);
    expect(result.unassigned).toEqual([{ tab: "01/10/26", rowNumber: 6 }]);
  });
});

describe("prefijo de tienda para libros compartidos", () => {
  it("toma el prefijo guardado en la tienda sin #", () => {
    expect(urpiStorePrefix("#kp")).toBe("KP");
    expect(urpiStorePrefix(" AUR ")).toBe("AUR");
    for (const value of [null, undefined, "", "K1", "#"]) expect(urpiStorePrefix(value)).toBeNull();
  });
  it("solo admite prefijos que no se solapan", () => {
    expect(urpiPrefixesSeparable(["KP", "AUR"])).toBe(true);
    expect(urpiPrefixesSeparable(["A", "AUR"])).toBe(false);
    expect(urpiPrefixesSeparable(["KP", "KP"])).toBe(false);
  });
});

describe("reprogramación Urpi: siguiente día de lunes a sábado", () => {
  it.each([
    ["2026-10-01", "2026-10-02"], ["2026-10-02", "2026-10-03"],
    ["2026-10-03", "2026-10-05"], ["2026-10-31", "2026-11-02"],
    ["2026-09-30", "2026-10-01"], ["2026-12-31", "2027-01-01"],
    ["2028-02-28", "2028-02-29"],
  ])("%s → %s usando la fecha del reporte", (input, output) => expect(nextUrpiDeliveryDate(input)).toBe(output));
  it("requiere fecha válida; no usa hoy como reemplazo", () => expect(() => nextUrpiDeliveryDate("sin fecha")).toThrow());
});
