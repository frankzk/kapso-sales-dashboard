// El Excel que Urpi carga en su sistema.
//
// Urpi no recibe una lista nuestra: tiene SU formato, con sus columnas y sus
// desplegables, y lo que se les manda se pega tal cual. Cualquier diferencia
// —una columna corrida, un teléfono con prefijo, una tienda con un nombre que
// su desplegable no conoce— convierte el pegado en trabajo manual, que es
// justamente lo que este archivo existe para evitar.
//
// Las 15 columnas y su orden salen de la plantilla que ellos mandaron. La D no
// tiene encabezado y va vacía a propósito: existe en su archivo.

import ExcelJS from "exceljs";
import { labelItemsFor, type LabelLineItem } from "@/lib/labels/line-items";

/** Encabezados exactos de la plantilla de Urpi, en su orden. */
export const URPI_HEADERS: readonly (string | null)[] = [
  "FECHA",
  "TIPO DE ENVIO",
  "TIENDA",
  // Su plantilla tiene la D con la celda VACÍA, no con un texto vacío. Se
  // respeta para que el archivo sea idéntico al suyo.
  null,
  "PEDIDO",
  "DESTINATARIO",
  "TELEFONO",
  "PROVINCIA",
  "DISTRITO",
  "DIRECCION",
  "REFERENCIA",
  "PRODUCTO",
  "MONTO A \nCOBRAR",
  "N DE REF\n(CANTIDAD)",
  "OBSERVACIONES",
] as const;

/** Lo que Urpi espera en «TIPO DE ENVIO». Es un desplegable de su archivo. */
const TIPO_ENVIO = "Primer envio";

export interface UrpiExportInput {
  /** Fecha de la ruta, `YYYY-MM-DD`. */
  routeDate: string;
  storeName: string | null;
  orderName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  province: string | null;
  district: string | null;
  address: string | null;
  reference: string | null;
  /** Líneas del pedido; si faltan, el texto guardado en la salida. */
  lineItems: unknown;
  productText: string | null;
  collectAmount: number | null;
  /** Nota del pedido en Shopify: va a OBSERVACIONES. */
  note: string | null;
}

/** Una fila del Excel, ya en el orden de las columnas de Urpi. */
export type UrpiExportRow = (string | number | null)[];

/**
 * Código de tienda para su desplegable: la primera palabra en mayúsculas y sin
 * acentos. «Kenku Peru» → `KENKU`, «Aurela» → `AURELA`.
 */
export function urpiStoreCode(storeName: string | null | undefined): string {
  const first = (storeName ?? "").trim().split(/\s+/)[0] ?? "";
  return first
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

/**
 * Teléfono como lo escribe Urpi: nueve dígitos, sin el prefijo del país.
 *
 * Nosotros guardamos `51991467077`; su sistema espera `991467077`. Pegarlo con
 * el 51 delante hace que su plataforma no reconozca el número.
 */
export function urpiPhone(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("51")) return digits.slice(2);
  if (digits.length === 12 && digits.startsWith("051")) return digits.slice(3);
  return digits;
}

/** `2026-08-03` → `03/08/2026`, sin pasar por la zona horaria del navegador. */
export function urpiDate(routeDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(routeDate);
  if (!match) return routeDate;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

/** Texto de la columna PRODUCTO: un producto por línea, con su cantidad. */
export function urpiProducts(items: readonly LabelLineItem[]): string {
  return items
    .map((item) => {
      const name = [item.name, item.variant].filter(Boolean).join(" - ");
      return item.quantity > 1 ? `${item.quantity} x ${name}` : name;
    })
    .join("\n");
}

/** Unidades totales del pedido, para «N DE REF (CANTIDAD)». */
export function urpiUnits(items: readonly LabelLineItem[]): number | null {
  if (!items.length) return null;
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

/** Una fila del Excel de Urpi a partir de un paquete de la ruta. */
export function urpiRow(input: UrpiExportInput): UrpiExportRow {
  const items = labelItemsFor(input.lineItems, input.productText);
  return [
    urpiDate(input.routeDate),
    TIPO_ENVIO,
    urpiStoreCode(input.storeName),
    null, // la columna sin encabezado de su plantilla
    input.orderName ?? "",
    input.customerName ?? "",
    urpiPhone(input.customerPhone),
    input.province ?? "",
    input.district ?? "",
    input.address ?? "",
    input.reference ?? "",
    urpiProducts(items),
    input.collectAmount ?? null,
    urpiUnits(items),
    input.note ?? "",
  ];
}

/** El libro completo, listo para descargar. */
export async function buildUrpiWorkbook(rows: readonly UrpiExportInput[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Kapta";
  const ws = wb.addWorksheet("Hoja1");

  const header = ws.addRow([...URPI_HEADERS]);
  header.font = { bold: true };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };

  for (const input of rows) {
    const row = ws.addRow(urpiRow(input));
    // El producto y la observación son largos: sin ajuste de texto la fila se
    // pega como una tira ilegible.
    row.getCell(12).alignment = { wrapText: true, vertical: "top" };
    row.getCell(15).alignment = { wrapText: true, vertical: "top" };
    row.getCell(13).numFmt = "0.00";
  }

  // Anchos aproximados a los de su plantilla: se pega en su archivo, pero el
  // nuestro tiene que poder revisarse antes de copiar.
  const widths = [11, 14, 10, 4, 14, 26, 13, 12, 16, 30, 22, 40, 11, 10, 34];
  widths.forEach((width, index) => {
    ws.getColumn(index + 1).width = width;
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
