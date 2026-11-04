// El acta del manifiesto de devolución, en PDF (pdf-lib) y en Excel (exceljs)
// (owner, 04-11-2026: la foto del acta firmada es opcional, pero el acta se
// descarga). Sin nombres, teléfonos ni direcciones de clientes: #pedido, código
// de salida, día de ruta de la caja, motivo reportado, resultado, totales y las
// firmas «Entregó» / «Recibió».

import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { sanitizeWinAnsi, wrapText } from "@/lib/labels/rotulo-pdf";
import { boxDayShort } from "@/lib/gf-scan-return";
import { RETURN_MANIFEST_STATE_LABEL, type ReturnManifestActa } from "@/lib/return-manifest";

const INK = rgb(0.008, 0.023, 0.09);
const MUTED = rgb(0.39, 0.45, 0.55);
const LINE = rgb(0.8, 0.84, 0.88);
/** A4 vertical, en puntos. */
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 36;

/** «04/11/2026 15:20», hora de Lima. */
export function limaDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

/** Las líneas de la cabecera, iguales en PDF y en Excel. */
export function actaHeaderLines(acta: ReturnManifestActa): [string, string][] {
  const h = acta.header;
  return [
    ["Courier", h.courierLabel],
    ["Motorizado", h.riderFirstName ?? "—"],
    ["Llegó el", boxDayShort(h.arrivedOn)],
    ["Entregó", h.handedOverBy ?? "—"],
    ["Recibió", h.receivedBy ?? "—"],
    ["Abierto", limaDateTime(h.openedAt)],
    ["Cerrado", limaDateTime(h.closedAt)],
    ["Estado", RETURN_MANIFEST_STATE_LABEL[h.state]],
  ];
}

/** Los totales, iguales en PDF y en Excel. */
export function actaTotalsLines(acta: ReturnManifestActa): [string, string][] {
  const t = acta.totals;
  return [
    // «Recibidos X de Y esperados»: la misma cifra antes y después de cerrar.
    ["Esperados", String(t.expectedTotal)],
    ["  recibidos de lo esperado", String(t.expectedReceived)],
    ["  siguen con el motorizado (en plazo)", String(t.withRider)],
    ["Llegaron", String(t.arrived)],
    ["Recibidos", String(t.received)],
    ["  vuelven a por asignar", String(t.requeued)],
    ["  a inventario (anulados)", String(t.toInventory)],
    ["  a stock", String(t.toStock)],
    ["Con observación", String(t.withObservation)],
    ["Faltan", String(t.missing)],
    ["Declaró", t.declared == null ? "—" : String(t.declared)],
    ["Diferencia declaró - llegaron", t.declaredGap == null ? "—" : String(t.declaredGap)],
  ];
}

const COLUMNS: { key: keyof ReturnManifestActa["rows"][number]; title: string; width: number }[] = [
  { key: "n", title: "#", width: 22 },
  { key: "orderName", title: "Pedido", width: 74 },
  { key: "outputCode", title: "Salida", width: 92 },
  { key: "boxDay", title: "Caja del", width: 50 },
  { key: "reported", title: "Reportado", width: 120 },
  { key: "result", title: "Resultado", width: 165 },
];

function text(page: PDFPage, value: string, x: number, y: number, font: PDFFont, size: number, color = INK) {
  page.drawText(sanitizeWinAnsi(value), { x, y, size, font, color });
}

/** El acta en PDF, A4, con tantas páginas como haga falta. */
export async function buildReturnManifestActaPdf(acta: ReturnManifestActa): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(sanitizeWinAnsi(acta.title));
  doc.setProducer("Kapta");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  text(page, acta.title, MARGIN, y - 14, bold, 14);
  y -= 34;
  for (const [k, v] of actaHeaderLines(acta)) {
    text(page, `${k}:`, MARGIN, y, bold, 9);
    text(page, v, MARGIN + 80, y, regular, 9);
    y -= 13;
  }
  if (acta.header.note) {
    for (const line of wrapText(`Nota: ${acta.header.note}`, regular, 9, PAGE_W - 2 * MARGIN, 3)) {
      text(page, line, MARGIN, y, regular, 9, MUTED);
      y -= 12;
    }
  }
  y -= 8;

  const drawHead = () => {
    let x = MARGIN;
    for (const col of COLUMNS) {
      text(page, col.title, x, y, bold, 8);
      x += col.width;
    }
    y -= 4;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.6, color: LINE });
    y -= 11;
  };
  drawHead();
  for (const row of acta.rows) {
    const cells = COLUMNS.map((col) => wrapText(String(row[col.key]), regular, 8, col.width - 4, 3));
    const height = Math.max(...cells.map((c) => Math.max(c.length, 1))) * 10 + 2;
    if (y - height < MARGIN + 160) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      drawHead();
    }
    let x = MARGIN;
    cells.forEach((lines, i) => {
      lines.forEach((line, j) => text(page, line, x, y - j * 10, regular, 8));
      x += COLUMNS[i]!.width;
    });
    y -= height;
  }
  if (!acta.rows.length) {
    text(page, "Sin cajas registradas.", MARGIN, y, regular, 9, MUTED);
    y -= 14;
  }

  y -= 10;
  if (y < MARGIN + 170) {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  }
  text(page, "Totales", MARGIN, y, bold, 10);
  y -= 14;
  for (const [k, v] of actaTotalsLines(acta)) {
    text(page, k, MARGIN, y, regular, 9);
    text(page, v, MARGIN + 170, y, bold, 9);
    y -= 12;
  }

  // Firmas.
  const sigY = Math.max(MARGIN + 30, y - 60);
  const boxW = (PAGE_W - 2 * MARGIN - 40) / 2;
  acta.signatures.forEach((who, i) => {
    const x = MARGIN + i * (boxW + 40);
    page.drawLine({ start: { x, y: sigY }, end: { x: x + boxW, y: sigY }, thickness: 0.8, color: INK });
    text(page, who, x, sigY - 12, bold, 9);
    const name = i === 0 ? acta.header.handedOverBy : acta.header.receivedBy;
    if (name) text(page, name, x, sigY - 24, regular, 9, MUTED);
  });
  return doc.save();
}

/** El acta en Excel: una hoja con cabecera, tabla, totales y firmas. */
export async function buildReturnManifestActaWorkbook(acta: ReturnManifestActa): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Kapta";
  const ws = wb.addWorksheet("Acta");
  ws.addRow([acta.title]).font = { bold: true, size: 13 };
  ws.addRow([]);
  for (const [k, v] of actaHeaderLines(acta)) ws.addRow([k, v]).getCell(1).font = { bold: true };
  if (acta.header.note) ws.addRow(["Nota", acta.header.note]).getCell(1).font = { bold: true };
  ws.addRow([]);
  const head = ws.addRow(COLUMNS.map((c) => c.title));
  head.font = { bold: true };
  for (const row of acta.rows) {
    const r = ws.addRow(COLUMNS.map((c) => row[c.key]));
    r.getCell(6).alignment = { wrapText: true, vertical: "top" };
  }
  ws.addRow([]);
  ws.addRow(["Totales"]).font = { bold: true };
  for (const [k, v] of actaTotalsLines(acta)) ws.addRow([k.trim(), v]);
  ws.addRow([]);
  ws.addRow(["Entregó", acta.header.handedOverBy ?? "", "", "Recibió", acta.header.receivedBy ?? ""]).font = { bold: true };
  [6, 14, 18, 10, 28, 40].forEach((width, index) => {
    ws.getColumn(index + 1).width = width;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** «acta-devolucion-alexis-04-11.pdf». */
export function actaFilename(acta: ReturnManifestActa, ext: "pdf" | "xlsx"): string {
  const base = `acta-${acta.header.label}`
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base}.${ext}`;
}
