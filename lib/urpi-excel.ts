import ExcelJS from "exceljs";
import { urpiDateIso, type UrpiTab } from "./urpi-programming";

/** Google removes slashes in worksheet names when exporting to XLSX:
 * 01/10/26 becomes 011026. Restore the date identity used by Google reads. */
function exportedTabTitle(title: string): string {
  const compact = /^(\d{2})(\d{2})(\d{2}|20\d{2})$/.exec(title);
  const separated = /^(\d{1,2})[-_](\d{1,2})[-_](\d{2}|20\d{2})$/.exec(title);
  const parts = compact ?? separated;
  const date = urpiDateIso(parts ? `${parts[1]}/${parts[2]}/${parts[3]}` : title);
  return date ? `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(2, 4)}` : title;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "";
  if (typeof value !== "object") return String(value).trim();
  if ("formula" in value || "sharedFormula" in value) {
    // CELL("sheet") has no cached result in Google's export. Never evaluate it;
    // the parser uses the worksheet date and explicitly flags that fallback.
    return cellText(value.result ?? null);
  }
  if ("richText" in value) return value.richText.map((part) => part.text).join("").trim();
  if ("text" in value) return String(value.text).trim();
  return "";
}

export async function readUrpiExcelWorkbook(buffer: ArrayBuffer | Buffer): Promise<UrpiTab[]> {
  const workbook = new ExcelJS.Workbook();
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const seen = new Set<string>();
  return workbook.worksheets.map((sheet) => {
    const title = exportedTabTitle(sheet.name);
    if (seen.has(title)) throw new Error(`Hay dos pestañas con la misma fecha: ${title}. Revisa el libro.`);
    seen.add(title);
    if (sheet.rowCount > 5000) throw new Error(`La pestaña ${title} supera 5000 filas.`);
    const values: string[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row, number) => {
      values[number - 1] = Array.from({ length: 15 }, (_, index) => cellText(row.getCell(index + 1).value));
    });
    return { title, sheetId: null, values };
  });
}
