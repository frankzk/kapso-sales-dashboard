import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  URPI_HEADERS,
  buildUrpiWorkbook,
  urpiDate,
  urpiPhone,
  urpiProducts,
  urpiRow,
  urpiStoreCode,
  urpiUnits,
  type UrpiExportInput,
} from "@/lib/exports/urpi-manifest";

// Este archivo se PEGA en el sistema de Urpi. Un dato con el formato de Kapta en
// vez del suyo no da error visible: entra mal y se descubre cuando el pedido no
// llega. Por eso las conversiones se prueban una por una.

const base: UrpiExportInput = {
  routeDate: "2026-08-03",
  storeName: "Kenku Peru",
  orderName: "#KP124122",
  customerName: "Johnny Romero",
  customerPhone: "51991467077",
  province: "LIMA",
  district: "La Victoria",
  address: "Jr mendoza merino 755",
  reference: "Entre jr humbolt y unanue",
  lineItems: [{ title: "Pulsera Magnetica", quantity: 2, variant_title: null }],
  productText: null,
  collectAmount: 99,
  note: "Llamar antes de salir",
};

describe("urpiPhone", () => {
  it("quita el prefijo del país: su sistema espera nueve dígitos", () => {
    expect(urpiPhone("51991467077")).toBe("991467077");
    expect(urpiPhone("+51 991 467 077")).toBe("991467077");
    expect(urpiPhone("051991467077")).toBe("991467077");
  });

  it("un número que ya viene sin prefijo se deja igual", () => {
    expect(urpiPhone("991467077")).toBe("991467077");
  });

  it("lo que no reconoce se devuelve en dígitos, sin inventar recortes", () => {
    // Cortar "los dos primeros" a ciegas mutilaría un número raro pero válido.
    expect(urpiPhone("12345")).toBe("12345");
    expect(urpiPhone(null)).toBe("");
  });
});

describe("urpiStoreCode", () => {
  it("la primera palabra en mayúsculas, como su desplegable", () => {
    expect(urpiStoreCode("Kenku Peru")).toBe("KENKU");
    expect(urpiStoreCode("Aurela")).toBe("AURELA");
  });
  it("sin acentos, que su desplegable no tiene", () => {
    expect(urpiStoreCode("Bodegón Perú")).toBe("BODEGON");
  });
  it("sin tienda no revienta", () => {
    expect(urpiStoreCode(null)).toBe("");
  });
});

describe("urpiDate", () => {
  it("día/mes/año, sin pasar por la zona horaria", () => {
    expect(urpiDate("2026-08-03")).toBe("03/08/2026");
  });
  it("lo que no es fecha se devuelve tal cual", () => {
    expect(urpiDate("mañana")).toBe("mañana");
  });
});

describe("urpiProducts y urpiUnits", () => {
  const items = [
    { quantity: 2, name: "Colageno", variant: null },
    { quantity: 1, name: "SoftFlex", variant: "39-40" },
  ];

  it("un producto por línea, con la cantidad solo cuando es más de una", () => {
    expect(urpiProducts(items)).toBe("2 x Colageno\nSoftFlex - 39-40");
  });

  it("las unidades suman, no cuentan líneas", () => {
    expect(urpiUnits(items)).toBe(3);
  });

  it("sin productos la cantidad queda vacía, no en cero", () => {
    // Un 0 en su planilla se lee como "no lleva nada"; vacío se lee como "falta
    // el dato", que es lo que de verdad pasa.
    expect(urpiUnits([])).toBeNull();
    expect(urpiProducts([])).toBe("");
  });
});

describe("urpiRow", () => {
  it("respeta las quince columnas de su plantilla, con la D vacía", () => {
    const row = urpiRow(base);
    expect(row).toHaveLength(URPI_HEADERS.length);
    // La columna sin encabezado existe en su archivo: si se omite, TODO lo que
    // viene después se pega una columna a la izquierda.
    expect(row[3]).toBeNull();
    expect(row[0]).toBe("03/08/2026");
    expect(row[1]).toBe("Primer envio");
    expect(row[2]).toBe("KENKU");
    expect(row[4]).toBe("#KP124122");
    expect(row[6]).toBe("991467077");
    expect(row[12]).toBe(99);
    expect(row[13]).toBe(2);
    expect(row[14]).toBe("Llamar antes de salir");
  });

  it("sin líneas del pedido cae al texto guardado en la salida", () => {
    const row = urpiRow({ ...base, lineItems: null, productText: "Colageno ×3" });
    expect(row[11]).toBe("3 x Colageno");
    expect(row[13]).toBe(3);
  });

  it("los campos que faltan salen vacíos, nunca como «null»", () => {
    const row = urpiRow({
      ...base,
      customerName: null,
      province: null,
      district: null,
      address: null,
      reference: null,
      note: null,
      collectAmount: null,
    });
    expect(row[5]).toBe("");
    expect(row[7]).toBe("");
    expect(row[14]).toBe("");
    expect(row[12]).toBeNull();
  });
});

describe("buildUrpiWorkbook", () => {
  it("genera un xlsx con la cabecera de Urpi y una fila por paquete", async () => {
    const file = await buildUrpiWorkbook([base, { ...base, orderName: "#KP2" }]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Hoja1")!;
    expect(ws).toBeTruthy();
    expect(ws.rowCount).toBe(3); // cabecera + dos paquetes

    const header = ws.getRow(1);
    URPI_HEADERS.forEach((title, index) => {
      // La D va vacía, no con cadena vacía: así el archivo calza con el suyo.
      expect(header.getCell(index + 1).value ?? null).toBe(title);
    });
    expect(ws.getRow(2).getCell(5).value).toBe("#KP124122");
    expect(ws.getRow(3).getCell(5).value).toBe("#KP2");
  });

  it("sin paquetes deja solo la cabecera, en vez de un archivo vacío", async () => {
    const file = await buildUrpiWorkbook([]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file as unknown as ArrayBuffer);
    expect(wb.getWorksheet("Hoja1")!.rowCount).toBe(1);
  });
});
