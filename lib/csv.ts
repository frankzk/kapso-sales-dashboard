// Small, dependency-free CSV serializer (RFC-4180 quoting). Pure + tested.

const UTF8_BOM = "﻿";

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  let textual = false; // only user text needs the formula-injection guard
  if (typeof v === "string") {
    s = v;
    textual = true;
  } else if (Array.isArray(v)) {
    s = v.join("|");
    textual = true;
  } else if (typeof v === "object") {
    s = JSON.stringify(v);
  } else {
    s = String(v); // number / boolean — safe, must stay unprefixed (e.g. "-5")
  }
  // Formula-injection guard: a text cell that starts with = + - @ (or a control
  // char) is executed as a formula by Excel/Sheets. Values here come from
  // Shopify/WhatsApp/customer input, so neutralize with a leading apostrophe.
  if (textual && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

/**
 * Serialize rows to CSV. `opts.bom` prepends a UTF-8 BOM so Excel opens
 * accented text correctly.
 */
export function toCsv<T>(
  rows: readonly T[],
  columns: readonly CsvColumn<T>[],
  opts: { bom?: boolean } = {},
): string {
  const head = columns.map((c) => escapeCell(c.header)).join(",");
  const body = rows.map((r) => columns.map((c) => escapeCell(c.value(r))).join(",")).join("\n");
  const csv = body ? `${head}\n${body}` : head;
  return (opts.bom ? UTF8_BOM : "") + csv + "\n";
}
