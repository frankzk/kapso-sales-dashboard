/** Reporte de resultados de Urpi: el export «Reporte del mes – detallado» de su
 * AppSheet. Una fila por INTENTO (no por pedido); un reintento apunta al
 * anterior con «Row number relacionado». No trae código de pedido: el vínculo
 * con Kapta se resuelve aparte (lib/urpi-report-link.ts). MOM §30.11. */

export type UrpiResultCode = "entregado" | "reprogramado" | "cancelado" | "programado" | "en_coordinacion" | "sin_resultado" | "otro";

export interface UrpiReportRow {
  urpiRow: number;
  previousRow: number | null;
  reportDate: string | null;
  resultWritten: string;
  resultCode: UrpiResultCode;
  reason: string | null;
  detail: string | null;
  evidence: string[];
  paymentMethod: string | null;
  amountCollected: number | null;
  serviceFee: number | null;
  posFee: number | null;
  finalDelivered: boolean | null;
  finalCancelled: boolean | null;
  recipient: string | null;
  phone: string | null;
  address: string | null;
  product: string | null;
  storeHint: string | null;
  seller: string | null;
  whatsappStatus: string | null;
  closingLocation: string | null;
}

export interface UrpiReport {
  rows: UrpiReportRow[];
  /** Filas sin resultado reconocido: se guardan, pero no se interpretan. */
  unknownResults: string[];
}

export const URPI_RESULT_LABEL: Record<UrpiResultCode, string> = {
  entregado: "Entregado",
  reprogramado: "Reprogramado",
  cancelado: "Cancelado",
  programado: "Programado",
  en_coordinacion: "En coordinación",
  sin_resultado: "Sin resultado",
  otro: "Estado no reconocido",
};

const MAX_ROWS = 20000;
const norm = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9_]+/g, " ").trim();

/** CSV con comillas, `""` escapadas y saltos de línea dentro de un campo. El
 * separador se deduce de la cabecera: AppSheet exporta con `;`. */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, "");
  const end = body.search(/\r?\n/);
  const firstLine = end < 0 ? body : body.slice(0, end);
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (quoted) {
      if (char === '"' && body[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw new Error("El archivo está cortado: una celda abre comillas y no las cierra.");
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

const clean = (value: string | undefined) => {
  const text = (value ?? "").trim();
  return text && text !== "-" ? text : null;
};

/** «2,323» → 2323. AppSheet usa coma de miles en los números de fila. */
function integerOf(value: string | undefined): number | null {
  const text = (value ?? "").trim().replace(/,/g, "");
  return /^\d{1,9}$/.test(text) ? Number(text) : null;
}

/** «89», «89.9», «1,234.50» → número; vacío o «-» → null. */
function amountOf(value: string | undefined): number | null {
  const text = (value ?? "").trim().replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : null;
}

/** «3/10/2026» (día/mes/año) → «2026-10-03». */
export function urpiReportDate(value: string | undefined): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(20\d{2})$/.exec((value ?? "").trim());
  if (!match) return null;
  const iso = `${match[3]}-${match[2]!.padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
  const date = new Date(`${iso}T12:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

/** «Row number relacionado» sale del export con formato de fecha: el número de
 * fila leído como serial de Excel («24/04/1906» = fila 2306). Se recupera el
 * número; un entero normal también vale. */
export function urpiPreviousRow(value: string | undefined): number | null {
  const text = (value ?? "").trim();
  const direct = integerOf(text);
  if (direct !== null) return direct;
  const match = /^(\d{1,2})\/(\d{1,2})\/(1[89]\d{2})$/.exec(text);
  if (!match) return null;
  const days = (Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])) - Date.UTC(1899, 11, 30)) / 86400000;
  return Number.isInteger(days) && days > 0 ? days : null;
}

/** Teléfono peruano de 9 dígitos (sin el 51), o null si no lo es. */
export function urpiPhone(value: string | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("51") ? digits.slice(2) : digits;
  return /^9\d{8}$/.test(local) ? local : null;
}

function flagOf(value: string | undefined): boolean | null {
  const text = (value ?? "").trim().toUpperCase();
  return text === "Y" ? true : text === "N" ? false : null;
}

/** Solo los valores escritos por Urpi. Lo que no está aquí no se adivina. */
export function urpiResultCode(written: string): UrpiResultCode {
  const key = norm(written);
  if (!key) return "sin_resultado";
  if (key === "entregado") return "entregado";
  if (key === "reprogramado") return "reprogramado";
  if (key === "cancelado") return "cancelado";
  if (key === "programado") return "programado";
  if (key === "en coordinacion") return "en_coordinacion";
  return "otro";
}

const REQUIRED = ["_rownumber", "destinatario", "resultado", "fecha envio", "numero de telefono"] as const;

export function parseUrpiReport(text: string): UrpiReport {
  const table = parseCsv(text);
  if (!table.length) throw new Error("El archivo está vacío.");
  const names = table[0]!.map(norm);
  const missing = REQUIRED.filter((name) => !names.includes(name));
  if (missing.length) throw new Error("No se reconoce el reporte de Urpi. Exporta «Reporte del mes – detallado» desde su plataforma, sin cambiar las columnas.");
  if (table.length - 1 > MAX_ROWS) throw new Error(`El reporte supera ${MAX_ROWS.toLocaleString("es-PE")} filas.`);
  const index = (name: string) => names.indexOf(norm(name));
  const get = (cells: string[], name: string) => { const i = index(name); return i < 0 ? undefined : cells[i]; };
  const report: UrpiReport = { rows: [], unknownResults: [] };
  const seen = new Set<number>();
  for (let i = 1; i < table.length; i++) {
    const cells = table[i]!;
    const urpiRow = integerOf(get(cells, "_RowNumber"));
    if (urpiRow === null) throw new Error(`La fila ${i + 1} no tiene número de fila de Urpi. No se importó el reporte.`);
    if (seen.has(urpiRow)) throw new Error(`El número de fila ${urpiRow} de Urpi está repetido. No se importó el reporte.`);
    seen.add(urpiRow);
    const resultWritten = (get(cells, "Resultado") ?? "").trim();
    const resultCode = urpiResultCode(resultWritten);
    if (resultCode === "otro" && !report.unknownResults.includes(resultWritten)) report.unknownResults.push(resultWritten);
    report.rows.push({
      urpiRow,
      previousRow: urpiPreviousRow(get(cells, "Row number relacionado")),
      reportDate: urpiReportDate(get(cells, "Fecha envío")),
      resultWritten,
      resultCode,
      reason: clean(get(cells, "Motivo principal (solo canc/repro)")),
      detail: clean(get(cells, "Detalle de entrega / cancelación / reprogramación")),
      evidence: [get(cells, "Evidencia de entrega 1"), get(cells, "Evidencia de entrega 2")]
        .map((url) => (url ?? "").trim()).filter((url) => /^https:\/\/[^\s"<>]+$/.test(url)),
      paymentMethod: clean(get(cells, "Método de pago")),
      amountCollected: amountOf(get(cells, "Monto Cobrado")),
      serviceFee: amountOf(get(cells, "Cobro servicio*")),
      posFee: amountOf(get(cells, "Comisiones POS u otros")),
      finalDelivered: flagOf(get(cells, "Estatus final: Entregado")),
      finalCancelled: flagOf(get(cells, "Estatus final: Cancelado")),
      recipient: clean(get(cells, "Destinatario")),
      phone: urpiPhone(get(cells, "Número de teléfono")),
      address: clean(get(cells, "Dirección")),
      product: clean(get(cells, "Producto")),
      storeHint: clean(get(cells, "Tienda")),
      seller: clean(get(cells, "Asesor de venta")),
      whatsappStatus: clean(get(cells, "Contacto mediante Whatsapp API")),
      closingLocation: clean(get(cells, "Ubicación de cierre")),
    });
  }
  if (!report.rows.length) throw new Error("El reporte no tiene filas.");
  return report;
}
