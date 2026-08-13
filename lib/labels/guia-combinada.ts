// Guía combinada: el rótulo del courier y el interno en una sola hoja (0120).
//
// EL PROBLEMA. Un paquete de Tanders necesita dos papeles: SU rótulo —el que
// lee el repartidor y el que escanean ellos— y el nuestro —el QR de la salida y
// qué hay dentro de la caja—. Hoy son dos impresiones, dos formatos y dos
// clics, y quien arma la caja tiene que juntarlos a mano.
//
// POR QUÉ SE PUEDE. El rótulo de Tanders lo componemos NOSOTROS: su API no tiene
// endpoint de PDF —su panel lo arma en el navegador— así que ya lo dibujamos
// campo por campo desde `tanders_raw` y el QR se genera en local. Combinar no es
// integrar nada con ellos; es maquetar dos bloques que ya controlamos.
//
// POR QUÉ EN PDF Y NO EN UNA PÁGINA HTML NUEVA. El rótulo interno TUVO versión
// HTML y se quitó a propósito (ver app/api/pedidos/rotulo/[shipmentId]): al ser
// un renderizador aparte se quedó sin la tabla de productos, sin la variante y
// sin el monto, y «dos rótulos distintos para el mismo paquete es una fuente
// permanente de errores de almacén». Añadir ahora un tercer renderizador HTML
// repetiría ese error, así que la combinada vive en el mismo generador de PDF y
// las REGLAS de contenido se importan —qué productos caben, cómo se agrupan las
// variantes, qué se sanea para WinAnsi— en vez de reescribirse. Lo único propio
// de este archivo es la geometría.
//
// QUÉ LLEVA CADA BLOQUE, y por qué el de abajo es corto. En A4 (297 mm) no caben
// los dos rótulos completos: el de Tanders y el interno miden ~150 mm cada uno.
// Tampoco hace falta. El de Tanders ya trae destinatario, teléfono, destino y
// monto a cobrar; repetirlos debajo gasta el sitio que necesita lo único que el
// suyo NO tiene: el QR de la salida y qué productos van dentro.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { TandersLabel } from "@/lib/tanders/label";
import { groupLabelItems, type LabelLineItem } from "@/lib/labels/line-items";
import { fitProducts, groupLines, sanitizeWinAnsi, wrapText } from "@/lib/labels/rotulo-pdf";

/** 1 mm en puntos PostScript (72 dpi). */
const MM = 72 / 25.4;
const PAGE_W = 210 * MM;
const PAGE_H = 297 * MM;
/** Margen de hoja. Cualquier láser doméstica imprime dentro de 10 mm. */
const MARGIN = 10 * MM;
/** El bloque de Tanders va a 100 mm: es SU etiqueta y se imprime tal cual, de
 *  modo que el día que se pase a rollo continuo se recorta y ya está. */
const BLOCK_W = 100 * MM;
/**
 * La franja interna, en cambio, usa el ancho útil de la hoja.
 *
 * A 100 mm la columna de productos quedaba en 64 mm, y con un título real de
 * Shopify —«BeeWax - Cera de Abeja Natural para el Cuidado y Protección de
 * Muebles 300 gramos», 97 caracteres— se leía «BeeWax - Cera de Abeja Natural
 * para e...». Quien arma la caja no puede trabajar con eso, y al lado había
 * media hoja en blanco. La franja no se pega en el paquete —se lee mientras se
 * empaca—, así que no gana nada por medir lo mismo que la etiqueta.
 */
const STRIP_W = PAGE_W - MARGIN * 2;
const PAD = 3 * MM;

const INK = rgb(0.008, 0.023, 0.09);
const MUTED = rgb(0.39, 0.45, 0.55);
const LINE = rgb(0.8, 0.84, 0.88);
/** El amarillo de su marca. El repartidor de Tanders reconoce la cabecera antes
 *  de leer nada, y es la mitad de por qué el rótulo se identifica de un vistazo. */
const TANDER_YELLOW = rgb(1, 0.831, 0);

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

/** Lo que necesita la mitad de abajo: la salida y qué va dentro de la caja. */
export interface CombinadaInterno {
  /** Código visible de la salida (`AUR175306-S01`). */
  code: string;
  storeName: string | null;
  orderName: string | null;
  items: LabelLineItem[];
  /** PNG del QR de la SALIDA, ya renderizado. */
  qrPng: Uint8Array;
}

export interface CombinadaEntry {
  tanders: TandersLabel;
  /** PNG del QR con el N° de seguimiento de Tanders. */
  tandersQrPng: Uint8Array;
  interno: CombinadaInterno;
}

const text = (v: string | null | undefined) => sanitizeWinAnsi(v) || "";

/**
 * El bloque de Tanders, igual que el que ya se imprime desde el navegador.
 * Devuelve la `y` en la que termina, para que quien compone la hoja no tenga
 * que adivinar cuánto ocupó una nota larga.
 */
function drawTandersBlock(
  page: PDFPage,
  fonts: Fonts,
  label: TandersLabel,
  qr: unknown,
  box: { x: number; top: number; width: number },
): number {
  const { x, width } = box;
  let y = box.top;

  // Cabecera amarilla.
  const headerH = 8 * MM;
  page.drawRectangle({ x, y: y - headerH, width, height: headerH, color: TANDER_YELLOW });
  page.drawText("TANDER", { x: x + PAD, y: y - headerH + 2.6 * MM, size: 12, font: fonts.bold, color: INK });
  const tag = "ROTULO DE ENVIO";
  const tagSize = 7;
  page.drawText(tag, {
    x: x + width - PAD - fonts.bold.widthOfTextAtSize(tag, tagSize),
    y: y - headerH + 3 * MM,
    size: tagSize,
    font: fonts.bold,
    color: INK,
  });
  y -= headerH;

  // Nº de seguimiento: es lo que se teclea en su panel para buscar el envío.
  y -= 4 * MM;
  page.drawText("N° SEGUIMIENTO", { x: x + PAD, y: y - 6, size: 6, font: fonts.bold, color: MUTED });
  y -= 6 + 1.5 * MM;
  page.drawText(text(label.trackingCode), { x: x + PAD, y: y - 10, size: 10, font: fonts.bold, color: INK });
  y -= 10 + 2 * MM;

  // QR centrado, del tamaño de su rótulo.
  const qrSide = 28 * MM;
  page.drawImage(qr as never, { x: x + (width - qrSide) / 2, y: y - qrSide, width: qrSide, height: qrSide });
  y -= qrSide + 2.5 * MM;

  // Las filas, en el mismo orden que su panel.
  const rows: [string, string][] = [
    ["DESTINATARIO", label.recipientName],
    ["TELEFONO", label.recipientPhone],
    ["DESTINO", label.destination],
    ["ORIGEN", label.origin],
    ["PAQUETE", label.packageType],
    ["PESO", `${label.weightGrams} g`],
  ];
  if (label.collectionAmount) rows.push(["COBRO", `S/ ${label.collectionAmount}`]);

  const labelW = 24 * MM;
  const valueSize = 8.5;
  for (const [caption, value] of rows) {
    page.drawLine({
      start: { x, y },
      end: { x: x + width, y },
      thickness: 0.5,
      color: LINE,
    });
    y -= 2 * MM;
    page.drawText(caption, { x: x + PAD, y: y - 6, size: 6, font: fonts.bold, color: MUTED });
    const lines = wrapText(value || "-", fonts.bold, valueSize, width - PAD * 2 - labelW, 2);
    let ly = y - valueSize;
    for (const line of lines.length ? lines : ["-"]) {
      page.drawText(line, { x: x + PAD + labelW, y: ly, size: valueSize, font: fonts.bold, color: INK });
      ly -= valueSize + 1;
    }
    y = Math.min(y - valueSize - 1, ly) - 1.4 * MM;
  }

  if (text(label.note)) {
    page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.5, color: LINE });
    y -= 2 * MM;
    page.drawText("NOTA", { x: x + PAD, y: y - 6, size: 6, font: fonts.bold, color: MUTED });
    y -= 6 + 1.2 * MM;
    // Cinco líneas, no tres: la nota de Tanders termina con los datos de cobro
    // —Yape y cuenta— y a tres líneas se cortaban a media cuenta bancaria. Es
    // información que usa quien cobra en la puerta, y en la hoja sobra alto.
    for (const line of wrapText(label.note, fonts.regular, 8, width - PAD * 2, 5)) {
      page.drawText(line, { x: x + PAD, y: y - 8, size: 8, font: fonts.regular, color: INK });
      y -= 9;
    }
    y -= 1.4 * MM;
  }

  // Pie: estado y fecha, en gris, como el suyo.
  page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.5, color: LINE });
  y -= 2 * MM;
  page.drawText(text(label.status), { x: x + PAD, y: y - 6, size: 6.5, font: fonts.regular, color: MUTED });
  const created = text(label.createdAt);
  page.drawText(created, {
    x: x + width - PAD - fonts.regular.widthOfTextAtSize(created, 6.5),
    y: y - 6,
    size: 6.5,
    font: fonts.regular,
    color: MUTED,
  });
  y -= 6 + 2 * MM;

  // Marco, dibujado al final porque solo ahora se sabe cuánto midió.
  page.drawRectangle({
    x,
    y,
    width,
    height: box.top - y,
    borderColor: LINE,
    borderWidth: 0.7,
  });
  return y;
}

/**
 * La franja de abajo: QR de la salida a la izquierda, productos a la derecha.
 *
 * En dos columnas y no apiladas porque el QR es cuadrado y deja a su lado una
 * banda de 60 mm que, apilando, se desperdiciaría: ahí caben los productos con
 * su cantidad y su variante, que es lo que hay que leer para armar la caja.
 */
function drawInternoStrip(
  page: PDFPage,
  fonts: Fonts,
  data: CombinadaInterno,
  qr: unknown,
  box: { x: number; top: number; width: number },
): number {
  const { x, width } = box;
  let y = box.top;

  const store = text(data.storeName).toUpperCase() || "KAPTA";
  page.drawText(store, { x: x + PAD, y: y - 8, size: 8, font: fonts.bold, color: MUTED });
  const orderName = text(data.orderName);
  if (orderName) {
    page.drawText(orderName, {
      x: x + width - PAD - fonts.bold.widthOfTextAtSize(orderName, 8),
      y: y - 8,
      size: 8,
      font: fonts.bold,
      color: MUTED,
    });
  }
  y -= 8 + 2 * MM;

  page.drawText(text(data.code), { x: x + PAD, y: y - 12, size: 12, font: fonts.bold, color: INK });
  y -= 12 + 2.5 * MM;

  const qrSide = 26 * MM;
  page.drawImage(qr as never, { x: x + PAD, y: y - qrSide, width: qrSide, height: qrSide });

  // Productos, a la derecha del QR. Las REGLAS de qué cabe y cómo se agrupan
  // vienen del rótulo interno: si allá cambian, acá cambian solas.
  const colX = x + PAD + qrSide + 4 * MM;
  const colW = width - PAD * 2 - qrSide - 4 * MM;
  const size = 8.5;
  const lineH = size + 1.4;
  const maxLines = Math.floor((qrSide - 4 * MM) / lineH);
  const groups = groupLabelItems(data.items);
  const { drawn, hidden } = fitProducts(groups, maxLines);

  page.drawText("CONTENIDO", { x: colX, y: y - 6, size: 6, font: fonts.bold, color: MUTED });
  let py = y - 6 - 1.8 * MM;

  if (!drawn.length) {
    page.drawText("-", { x: colX, y: py - size, size, font: fonts.regular, color: INK });
    py -= lineH;
  }
  for (const group of drawn) {
    const single = group.variants[0];
    if (group.variants.length === 1 && !single?.variant) {
      const qty = `${single?.quantity ?? 1} x `;
      page.drawText(qty, { x: colX, y: py - size, size, font: fonts.bold, color: INK });
      const nameX = colX + fonts.bold.widthOfTextAtSize(qty, size);
      // Dos líneas para el título: en la hoja sobra alto y un producto a medio
      // nombre es justo lo que esta franja viene a evitar.
      const lines = wrapText(group.name, fonts.regular, size, colW - (nameX - colX), 2);
      let ny = py;
      for (const line of lines.length ? lines : ["-"]) {
        page.drawText(line, { x: nameX, y: ny - size, size, font: fonts.regular, color: INK });
        ny -= lineH;
      }
      py = ny;
      continue;
    }
    for (const title of wrapText(group.name, fonts.bold, size, colW, 2)) {
      page.drawText(title, { x: colX, y: py - size, size, font: fonts.bold, color: INK });
      py -= lineH;
    }
    for (const v of group.variants) {
      const line = `${v.quantity} x ${text(v.variant) || "-"}`;
      page.drawText(line, { x: colX + 3 * MM, y: py - size, size, font: fonts.regular, color: INK });
      py -= lineH;
    }
  }
  if (hidden > 0) {
    page.drawText(`+ ${hidden} producto${hidden === 1 ? "" : "s"} mas`, {
      x: colX,
      y: py - size,
      size,
      font: fonts.bold,
      color: MUTED,
    });
    py -= lineH;
  }

  y = Math.min(y - qrSide, py) - 2.5 * MM;
  page.drawRectangle({ x, y, width, height: box.top - y, borderColor: LINE, borderWidth: 0.7 });
  return y;
}

/** La línea por donde se corta si se quieren separar los dos rótulos. */
function drawCutLine(page: PDFPage, fonts: Fonts, x: number, y: number, width: number): void {
  page.drawLine({
    start: { x, y },
    end: { x: x + width, y },
    thickness: 0.6,
    color: LINE,
    dashArray: [3, 3],
  });
  const caption = "cortar aqui";
  page.drawText(caption, {
    x: x + width - fonts.regular.widthOfTextAtSize(caption, 6),
    y: y + 1.4 * MM,
    size: 6,
    font: fonts.regular,
    color: MUTED,
  });
}

/**
 * Una hoja A4 por salida: rótulo de Tanders arriba, franja interna debajo.
 *
 * A4 porque el almacén imprime en láser normal. La maqueta deja los dos bloques
 * a 100 mm de ancho —la medida de la etiqueta— para que pasar a rollo continuo
 * el día de mañana sea cambiar el tamaño de página y nada más.
 */
export async function buildGuiaCombinadaPdf(
  entries: readonly CombinadaEntry[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(
    entries.length === 1
      ? `Guia combinada ${entries[0]!.interno.code}`
      : `Guias combinadas (${entries.length})`,
  );
  doc.setCreator("Kapta");

  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };

  for (const entry of entries) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    // Los dos alineados a la izquierda: así el corte de la etiqueta de Tanders
    // es una línea recta desde el borde y no hay que centrar nada a ojo.
    const afterTanders = drawTandersBlock(
      page,
      fonts,
      entry.tanders,
      await doc.embedPng(entry.tandersQrPng),
      { x: MARGIN, top: PAGE_H - MARGIN, width: BLOCK_W },
    );
    const cutY = afterTanders - 5 * MM;
    drawCutLine(page, fonts, MARGIN, cutY, STRIP_W);
    drawInternoStrip(page, fonts, entry.interno, await doc.embedPng(entry.interno.qrPng), {
      x: MARGIN,
      top: cutY - 5 * MM,
      width: STRIP_W,
    });
  }

  return doc.save();
}
