// Rótulo interno de Kapta en PDF, listo para descargar e imprimir en lote.
//
// El rótulo HTML (`/api/pedidos/rotulo/[shipmentId]`) sirve para imprimir uno
// desde el navegador. Cuando el almacén prepara la tanda del día necesita lo
// contrario: UN archivo con los N rótulos, que se descarga y se manda a la
// impresora de etiquetas. Eso es lo que arma este módulo.
//
// Se conserva el mismo formato físico que el HTML —100 × 150 mm, una etiqueta
// por página— para que la impresora de etiquetas no necesite reconfigurarse.
//
// pdf-lib es JS puro (sin binarios): se ejecuta en el runtime nodejs de Vercel
// sin depender de un navegador headless.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { LabelLineItem } from "@/lib/labels/line-items";

/** 1 mm en puntos PostScript (72 dpi). */
const MM = 72 / 25.4;

const PAGE_W = 100 * MM;
const PAGE_H = 150 * MM;
const PAD = 8 * MM;

const INK = rgb(0.008, 0.023, 0.09); // slate-950, igual que el HTML
const MUTED = rgb(0.39, 0.45, 0.55); // slate-500
const LINE = rgb(0.8, 0.84, 0.88); // slate-300

export interface RotuloData {
  /** Código visible de la salida (output_code o guide_code). */
  code: string;
  courier: string;
  orderName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  /** Líneas del pedido: cantidad, producto y variante. */
  items: LabelLineItem[];
  destination: string | null;
  address: string | null;
  reference: string | null;
  /** Contenido del QR: identifica la SALIDA, no el pedido. */
  qrPayload: string;
  /** PNG del QR ya renderizado. */
  qrPng: Uint8Array;
}

/**
 * Las fuentes estándar de PDF usan WinAnsi: cubre acentos y ñ, pero no todo
 * Unicode. Un carácter fuera de la tabla hace fallar la escritura entera, así
 * que se reemplaza en vez de romper el rótulo (un pedido con un emoji en el
 * nombre no puede impedir que el almacén imprima).
 */
export function sanitizeWinAnsi(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/—|–/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/•|·/g, "-")
    .replace(/€/g, "EUR")
    .split("")
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp === 10 || cp === 13) return " ";
      // Latin-1 imprimible; el resto se descarta.
      return (cp >= 32 && cp <= 126) || (cp >= 160 && cp <= 255) ? ch : "";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parte el texto en líneas que quepan en `maxWidth`, cortando palabras larguísimas. */
export function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
  maxLines: number,
): string[] {
  const clean = sanitizeWinAnsi(text);
  if (!clean) return [];
  const lines: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current) lines.push(current);
    current = "";
  };

  for (const word of clean.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    pushCurrent();
    // Palabra sola más ancha que la caja (una URL, un código): se parte.
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
      let cut = rest.length;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut -= 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
      if (lines.length >= maxLines) break;
    }
    current = rest;
    if (lines.length >= maxLines) break;
  }
  pushCurrent();

  if (lines.length <= maxLines) return lines;
  const trimmed = lines.slice(0, maxLines);
  trimmed[maxLines - 1] = `${trimmed[maxLines - 1]!.replace(/.{1}$/, "")}…`.replace("…", "...");
  return trimmed;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

/** Alto que consume un campo de `lines` líneas, incluido su separador. */
export function fieldHeight(lines: number, valueSize: number): number {
  return 1.4 * MM + lines * (valueSize + 1.2) + 1.5 * MM + 2.6 * MM;
}

/**
 * Cuántas líneas de un campo caben entre `y` y `minY`. Cero significa que el
 * campo no cabe y debe omitirse: es lo que impide que el texto invada el QR.
 */
export function linesThatFit(
  y: number,
  minY: number,
  valueSize: number,
  requested: number,
): number {
  const lineHeight = valueSize + 1.2;
  // El epsilon evita que el redondeo binario (10.699999… / 10.7) descarte una
  // línea que en realidad entra justo.
  const room = Math.floor((y - minY - fieldHeight(0, valueSize)) / lineHeight + 1e-9);
  return Math.max(0, Math.min(requested, room));
}

/**
 * Dibuja un campo y devuelve la `y` donde puede empezar el siguiente.
 *
 * `minY` es la frontera del pie (QR): el campo recorta sus líneas para no
 * cruzarla, y se omite entero si ni siquiera cabe una. Sin este tope, una
 * dirección larga más una lista larga de productos se montarían encima del QR
 * —y un rótulo con el QR tapado es un paquete que no se puede cotejar.
 */
function drawField(
  page: PDFPage,
  fonts: Fonts,
  opts: {
    x: number;
    y: number;
    width: number;
    label: string;
    value: string | null;
    valueSize?: number;
    maxLines?: number;
    minY: number;
  },
): number {
  const valueSize = opts.valueSize ?? 9.5;
  const requested = opts.maxLines ?? 2;

  const maxLines = linesThatFit(opts.y, opts.minY, valueSize, requested);
  if (maxLines < 1) return opts.y;

  page.drawText(sanitizeWinAnsi(opts.label).toUpperCase(), {
    x: opts.x,
    y: opts.y,
    size: 6,
    font: fonts.bold,
    color: MUTED,
  });

  const lines = wrapText(opts.value || "-", fonts.bold, valueSize, opts.width, maxLines);
  let cursor = opts.y - valueSize - 1.4 * MM;
  for (const line of lines.length ? lines : ["-"]) {
    page.drawText(line, { x: opts.x, y: cursor, size: valueSize, font: fonts.bold, color: INK });
    cursor -= valueSize + 1.2;
  }

  const bottom = cursor + valueSize - 1.5 * MM;
  page.drawLine({
    start: { x: opts.x, y: bottom },
    end: { x: opts.x + opts.width, y: bottom },
    thickness: 0.5,
    color: LINE,
  });
  return bottom - 2.6 * MM;
}

/**
 * Tabla de productos: una fila por producto, con la cantidad a la izquierda.
 *
 * Quien arma la caja necesita CUÁNTOS y CUÁL. El título de Shopify puede traer
 * 200 caracteres de copy publicitario, así que se recorta a una línea; la
 * VARIANTE (talla, color) va en su propia línea porque es lo que distingue dos
 * líneas del mismo producto —y empacar la talla equivocada es un reenvío.
 */
function drawProducts(
  page: PDFPage,
  fonts: Fonts,
  opts: { x: number; y: number; width: number; items: readonly LabelLineItem[]; minY: number },
): number {
  const size = 8.5;
  const qtyW = 9 * MM;
  const nameX = opts.x + qtyW;
  const nameW = opts.width - qtyW;
  const lineH = size + 1.4;

  page.drawText("PRODUCTOS", {
    x: opts.x,
    y: opts.y,
    size: 6,
    font: fonts.bold,
    color: MUTED,
  });

  let cursor = opts.y - size - 1.4 * MM;
  let shown = 0;

  for (const item of opts.items) {
    // Cada fila necesita su línea de nombre; la de variante solo si hay.
    const rowLines = item.variant ? 2 : 1;
    if (cursor - rowLines * lineH < opts.minY) break;

    // Más de una unidad se imprime más grande. Empacar una sola cuando iban dos
    // es un reenvío completo, así que la cantidad tiene que saltar a la vista y
    // no depender de que alguien lea un número del mismo tamaño que el resto.
    const qty = `${item.quantity}`;
    const qtySize = item.quantity > 1 ? size + 2.5 : size;
    page.drawText(qty, { x: opts.x, y: cursor, size: qtySize, font: fonts.bold, color: INK });
    page.drawText("x", {
      x: opts.x + fonts.bold.widthOfTextAtSize(qty, qtySize) + 1.5,
      y: cursor,
      size: size - 2,
      font: fonts.regular,
      color: MUTED,
    });

    const [nameLine] = wrapText(item.name, fonts.bold, size, nameW, 1);
    page.drawText(nameLine ?? "Producto", {
      x: nameX,
      y: cursor,
      size,
      font: fonts.bold,
      color: INK,
    });
    cursor -= lineH;

    if (item.variant) {
      const [variantLine] = wrapText(item.variant, fonts.bold, size, nameW, 1);
      page.drawText(variantLine ?? "", {
        x: nameX,
        y: cursor,
        size,
        font: fonts.bold,
        color: INK,
      });
      cursor -= lineH;
    }
    shown += 1;
  }

  if (!shown) {
    page.drawText("-", { x: opts.x, y: cursor, size, font: fonts.bold, color: INK });
    cursor -= lineH;
  } else if (shown < opts.items.length) {
    // Nunca callar lo que no cupo: el almacén tiene que saber que faltan líneas.
    const rest = opts.items.length - shown;
    page.drawText(`+ ${rest} producto${rest === 1 ? "" : "s"} mas (ver el pedido)`, {
      x: opts.x,
      y: cursor,
      size: 7,
      font: fonts.regular,
      color: MUTED,
    });
    cursor -= lineH;
  }

  const bottom = cursor + size - 1.5 * MM;
  page.drawLine({
    start: { x: opts.x, y: bottom },
    end: { x: opts.x + opts.width, y: bottom },
    thickness: 0.5,
    color: LINE,
  });
  return bottom - 2.6 * MM;
}

/** Dibuja un rótulo completo en su propia página. */
function drawRotulo(doc: PDFDocument, fonts: Fonts, data: RotuloData, qr: unknown): void {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const innerW = PAGE_W - PAD * 2;
  let y = PAGE_H - PAD;

  // Cabecera: marca + código grande a la izquierda, courier a la derecha.
  page.drawText("KAPTA - SALIDA FISICA", {
    x: PAD,
    y: y - 7,
    size: 6.5,
    font: fonts.bold,
    color: MUTED,
  });

  const courier = sanitizeWinAnsi(data.courier).toUpperCase();
  const courierSize = 11;
  page.drawText(courier, {
    x: PAGE_W - PAD - fonts.bold.widthOfTextAtSize(courier, courierSize),
    y: y - 9,
    size: courierSize,
    font: fonts.bold,
    color: INK,
  });

  // El código se achica si es largo, para no invadir el courier.
  const code = sanitizeWinAnsi(data.code) || "-";
  let codeSize = 17;
  const codeMax = innerW * 0.62;
  while (codeSize > 9 && fonts.bold.widthOfTextAtSize(code, codeSize) > codeMax) codeSize -= 0.5;
  y -= 7 + 4.5 * MM;
  page.drawText(code, { x: PAD, y: y - codeSize, size: codeSize, font: fonts.bold, color: INK });

  y -= codeSize + 3 * MM;
  page.drawLine({
    start: { x: PAD, y },
    end: { x: PAGE_W - PAD, y },
    thickness: 1.4,
    color: INK,
  });
  y -= 5 * MM;

  // Pie fijo: QR + leyenda. Se ancla abajo para que todas las etiquetas lo
  // tengan en el mismo sitio, aunque los datos de arriba varíen de alto. Los
  // campos de arriba nunca pueden bajar de `fieldsFloor`.
  const qrSize = 30 * MM;
  const footerTop = PAD + qrSize + 4 * MM;
  const fieldsFloor = footerTop + 2 * MM;

  // Dos columnas arriba, ancho completo abajo (igual que el rótulo HTML).
  const colW = (innerW - 4 * MM) / 2;
  const leftAfter = drawField(page, fonts, {
    x: PAD,
    y,
    width: colW,
    label: "Pedido Shopify",
    value: data.orderName,
    maxLines: 1,
    minY: fieldsFloor,
  });
  const rightAfter = drawField(page, fonts, {
    x: PAD + colW + 4 * MM,
    y,
    width: colW,
    label: "Celular",
    value: data.customerPhone,
    maxLines: 1,
    minY: fieldsFloor,
  });
  y = Math.min(leftAfter, rightAfter);

  y = drawField(page, fonts, {
    x: PAD,
    y,
    width: innerW,
    label: "Cliente",
    value: data.customerName,
    maxLines: 1,
    minY: fieldsFloor,
  });
  // La dirección es lo que decide si el paquete llega: va más grande y se lleva
  // el espacio sobrante antes que los campos de abajo.
  y = drawField(page, fonts, {
    x: PAD,
    y,
    width: innerW,
    label: "Direccion",
    value: data.address,
    valueSize: 11,
    maxLines: 3,
    minY: fieldsFloor,
  });
  y = drawField(page, fonts, {
    x: PAD,
    y,
    width: innerW,
    label: "Distrito / Provincia / Region",
    value: data.destination,
    maxLines: 2,
    minY: fieldsFloor,
  });
  y = drawField(page, fonts, {
    x: PAD,
    y,
    width: innerW,
    label: "Referencia",
    value: data.reference,
    maxLines: 2,
    minY: fieldsFloor,
  });
  y = drawProducts(page, fonts, {
    x: PAD,
    y,
    width: innerW,
    items: data.items,
    minY: fieldsFloor,
  });
  page.drawLine({
    start: { x: PAD, y: footerTop },
    end: { x: PAGE_W - PAD, y: footerTop },
    thickness: 1.4,
    color: INK,
  });

  page.drawImage(qr as never, { x: PAD, y: PAD, width: qrSize, height: qrSize });

  const copyX = PAD + qrSize + 5 * MM;
  const copyW = PAGE_W - PAD - copyX;
  page.drawText("Escanear en cada cotejo", {
    x: copyX,
    y: PAD + qrSize - 9,
    size: 9,
    font: fonts.bold,
    color: INK,
  });
  let copyY = PAD + qrSize - 9 - 4.5 * MM;
  for (const line of wrapText(
    "Este QR identifica esta salida, no el pedido completo.",
    fonts.regular,
    6.5,
    copyW,
    3,
  )) {
    page.drawText(line, { x: copyX, y: copyY, size: 6.5, font: fonts.regular, color: MUTED });
    copyY -= 8;
  }
  for (const line of wrapText(data.qrPayload, fonts.regular, 5.5, copyW, 3)) {
    page.drawText(line, { x: copyX, y: copyY, size: 5.5, font: fonts.regular, color: MUTED });
    copyY -= 6.5;
  }
}

/** Un PDF con una página por rótulo, en el orden recibido. */
export async function buildRotulosPdf(labels: readonly RotuloData[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(labels.length === 1 ? `Rotulo ${labels[0]!.code}` : `Rotulos (${labels.length})`);
  doc.setCreator("Kapta");

  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };

  for (const label of labels) {
    const qr = await doc.embedPng(label.qrPng);
    drawRotulo(doc, fonts, label, qr);
  }
  return doc.save();
}
