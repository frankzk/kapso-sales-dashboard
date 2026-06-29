// Small, dependency-free CSV reader (RFC-4180). Pure + tested. The sibling of
// lib/csv.ts (the writer). Handles quoted fields, embedded commas/newlines,
// escaped quotes ("") and a leading UTF-8 BOM. Returns objects keyed by header.

const UTF8_BOM = "﻿";

/** Parse CSV text into an array of string cells per row (header included). */
export function parseCsvRows(text: string): string[][] {
  let s = text;
  if (s.startsWith(UTF8_BOM)) s = s.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const n = s.length;

  const pushCell = () => {
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushCell();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // swallow CRLF / lone CR as a row break
      if (s[i + 1] === "\n") i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  // flush the trailing cell/row unless the input ended on a clean newline
  if (cell.length > 0 || row.length > 0) pushRow();
  return rows;
}

/**
 * Parse CSV text into objects keyed by the (trimmed) header row. Blank trailing
 * rows are dropped. Duplicate headers keep the last column's value.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  const header = rows[0];
  if (!header) return [];
  const headers = header.map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells) continue;
    // skip fully-empty rows
    if (cells.length === 1 && (cells[0] ?? "").trim() === "") continue;
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
