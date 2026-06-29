// XLSX → row objects, isolated behind one function so the rest of the import
// pipeline is parser-agnostic and the dependency is swappable. Uses exceljs
// (pure JS, no native build). For CSV uploads use lib/csv-parse.ts instead.

import ExcelJS from "exceljs";

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    // rich text / hyperlink / formula result shapes exceljs may return
    if (typeof v.text === "string") return v.text;
    if (v.result != null) return String(v.result);
    if (Array.isArray(v.richText)) {
      return (v.richText as Array<{ text?: string }>).map((r) => r.text ?? "").join("");
    }
    if (typeof v.hyperlink === "string") return v.hyperlink;
  }
  return String(value);
}

/**
 * Parse the first worksheet of an XLSX buffer into objects keyed by the header
 * row (first non-empty row). Trims headers and cells; skips fully-empty rows.
 */
export async function parseSheet(buffer: ArrayBuffer | Buffer): Promise<Record<string, string>[]> {
  const wb = new ExcelJS.Workbook();
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(new Uint8Array(buffer as ArrayBuffer));
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    // row.values is 1-indexed (index 0 is unused) in exceljs
    const values = row.values as ExcelJS.CellValue[];
    for (let c = 1; c < values.length; c++) {
      cells[c - 1] = cellText(values[c] ?? null).trim();
    }
    rows.push(cells);
  });
  const header = rows[0];
  if (!header) return [];

  const headers = header.map((h) => (h ?? "").trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells || cells.every((c) => !c || c.trim() === "")) continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      obj[key] = (cells[c] ?? "").trim();
    }
    out.push(obj);
  }
  return out;
}
