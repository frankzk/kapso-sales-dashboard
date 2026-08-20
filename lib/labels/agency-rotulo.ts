// Rótulo compuesto de agencia: el papel del courier arriba, lo nuestro abajo.
//
// POR QUÉ EXISTE. Un envío por agencia viaja con DOS papeles que hoy se imprimen
// por separado: el rótulo del courier —que es el que manda en su mostrador— y el
// rótulo interno de Kapta, que es el que sabe QUÉ va dentro de la caja y trae el
// QR de la salida. Quien arma la caja necesita los dos, y dos impresiones para
// un mismo bulto es una que se olvida.
//
// Peor: para tener el papel interno el almacén acababa creando una salida
// `por definir` desde «Descargar rótulos (PDF)», y esa salida después bloquea la
// emisión de la guía de agencia —el pedido no puede tener dos salidas vivas—.
// El compuesto cuelga de la PROPIA salida del courier, que ya trae su `qr_token`,
// así que el rodeo deja de hacer falta.
//
// EL PDF DEL COURIER NO SE REDIBUJA, SE EMBEBE. Shalom sirve su rótulo como PDF
// por API. Copiarlo a mano —como sí hay que hacer con Tanders, que no expone
// PDF— sería inventar un documento que en su mostrador vale y en el nuestro no.
// Se incrusta su página tal cual y se escala; lo que el courier lee sigue siendo
// suyo, letra por letra.
//
// LA MEDIDA DE SU PÁGINA NO SE SUPONE. No está fijada en ningún contrato: puede
// llegar A4, puede llegar en etiqueta térmica, y puede cambiar el día que ellos
// rehagan su plantilla. Por eso la escala se calcula en tiempo de ejecución
// contra el alto real de la página embebida, conservando la proporción. Fijar un
// número medido de una muestra habría funcionado hasta la primera vez que
// cambiaran de formato, y habría fallado en silencio: el rótulo saldría
// deformado o cortado, no con un error.

import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  drawProducts,
  sanitizeWinAnsi,
  INK,
  MM,
  MUTED,
  PAGE_H,
  PAGE_W,
  productsHeight,
  type Fonts,
} from "./rotulo-pdf";
import type { LabelLineItem } from "./line-items";

export interface AgencyRotuloData {
  /** Código de la salida: `KP127579-S02`. */
  code: string;
  /** Número de guía del courier, para cotejar contra su papel. */
  guideCode: string | null;
  /** La marca que el cliente reconoce, no "Kapta". */
  storeName: string | null;
  /** Pedido de Shopify: `#KP127579`. */
  orderName: string | null;
  customerName: string | null;
  /** Líneas del pedido: cantidad, producto y variante. */
  items: LabelLineItem[];
  /** PNG del QR de la SALIDA ya renderizado. */
  qrPng: Uint8Array;
}

/**
 * Márgenes propios, más estrechos que los del rótulo interno.
 *
 * POR QUÉ NO SON LOS 8 mm DE `PAD`. Este papel se imprime 4 por hoja en A4, y
 * ahí manda el ancho: la celda son 105 mm y nuestra página 100, así que sale
 * casi 1:1 y la etiqueta de Shalom hereda lo que le dejemos de ancho útil. Con
 * 8 mm por lado eran 84; con 4 son 92 — un 10% más de etiqueta sin tocar nada
 * más. El rótulo interno conserva los suyos: ese sí lleva dirección larga y
 * banda de cobro, y necesita el aire.
 */
const AGENCY_PAD = 4 * MM;

/** Aire entre su etiqueta y nuestra línea divisoria. */
const GAP = 3 * MM;

/**
 * El QR ya no crece con el hueco: ahora la página se ajusta al contenido, así
 * que no hay hueco que rellenar. 26 mm es cómodo de escanear —el token es un
 * UUID, 29 módulos a corrección M, casi 0,9 mm por módulo— sin robarle ancho a
 * los productos.
 */
const QR_SIZE = 26 * MM;

/** Tope de líneas de producto. Más que esto y el papel deja de ser una etiqueta. */
const MAX_PRODUCT_LINES = 6;

/** Ancho útil: lo que le queda a su etiqueta después de los márgenes. */
export function agencyInnerWidth(): number {
  return PAGE_W - AGENCY_PAD * 2;
}

/**
 * Escala para meter una página de `w × h` en la caja, sin deformarla.
 *
 * Nunca amplía por encima de 1: agrandar un rótulo térmico pequeño hasta llenar
 * la caja lo dejaría borroso, y su código de barras es lo único que el courier
 * escanea de verdad.
 */
export function fitScale(w: number, h: number, boxW: number, boxH: number): number {
  if (w <= 0 || h <= 0) return 1;
  return Math.min(boxW / w, boxH / h, 1);
}

/**
 * Techo del rótulo del courier: lo que quede del papel tras servir a la banda.
 *
 * Depende del contenido a propósito. Un número fijo se pasaba: con una etiqueta
 * vertical —un A4 suyo— la página salía de 156 mm y ya no cabía en el papel de
 * 100 × 150. La página crece con el contenido, pero nunca más allá de la hoja.
 */
export function maxCourierHeight(
  items: readonly LabelLineItem[] = [],
  hasName = true,
): number {
  return PAGE_H - AGENCY_PAD * 2 - GAP - 3.5 * MM - bandContentHeight(items, hasName);
}

/**
 * Alto que va a ocupar de verdad la etiqueta del courier en la hoja.
 *
 * Existe como función aparte para poder AFIRMAR sobre ella: es el número que
 * decide el alto de toda la página, y el que la primera versión daba por
 * supuesto.
 */
export function courierDrawHeight(
  w: number,
  h: number,
  items: readonly LabelLineItem[] = [],
  hasName = true,
): number {
  return h * fitScale(w, h, agencyInnerWidth(), maxCourierHeight(items, hasName));
}

/**
 * Alto de nuestra banda: lo que ocupa su contenido, ni un milímetro más.
 *
 * Es la mitad del arreglo. Antes la página medía 150 mm fijos y el contenido
 * llegaba a ~100: los 50 restantes salían impresos en blanco y, al imprimir 4
 * por hoja, se llevaban un tercio de la celda sin decir nada. Ahora la página
 * termina donde termina lo que hay que leer.
 */
export function bandContentHeight(
  items: readonly LabelLineItem[],
  hasName: boolean,
): number {
  const header =
    11 + 1.6 * MM + // tienda y pedido, en una fila
    8 + 1.4 * MM + // codigo de salida y guia
    (hasName ? 8 + 1.2 * MM : 0) +
    1.4 * MM;
  return header + Math.max(QR_SIZE, productsHeight(items, MAX_PRODUCT_LINES));
}

/** Alto total de la página, ya ajustado a lo que de verdad se imprime. */
export function agencyPageHeight(
  courierW: number,
  courierH: number,
  items: readonly LabelLineItem[],
  hasName: boolean,
): number {
  return (
    AGENCY_PAD * 2 +
    courierDrawHeight(courierW, courierH, items, hasName) +
    GAP +
    3.5 * MM +
    bandContentHeight(items, hasName)
  );
}

export async function buildAgencyRotuloPdf(
  courierLabelPdf: ArrayBuffer | Uint8Array,
  data: AgencyRotuloData,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Rotulo ${data.code}`);
  doc.setCreator("Kapta");

  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };

  // Su página va PRIMERO y arriba: es la que se lee en el mostrador. Si viniera
  // con varias páginas se toma la primera, que es la etiqueta; las siguientes
  // suelen ser condiciones del servicio y no viajan pegadas a la caja.
  const [courierPage] = await doc.embedPdf(courierLabelPdf, [0]);
  const innerW = agencyInnerWidth();
  const legend = sanitizeWinAnsi(data.customerName);

  // La página se mide ANTES de crearla: pdf-lib necesita el tamaño por
  // adelantado, y aquí eso juega a favor — obliga a saber cuánto ocupa el
  // contenido en vez de reservar de más «por si acaso», que es lo que dejaba
  // 50 mm en blanco al pie.
  const courierH = courierPage
    ? courierDrawHeight(courierPage.width, courierPage.height, data.items, Boolean(legend))
    : 0;
  const pageH = agencyPageHeight(
    courierPage?.width ?? 0,
    courierPage?.height ?? 0,
    data.items,
    Boolean(legend),
  );
  const page = doc.addPage([PAGE_W, pageH]);

  if (courierPage) {
    const drawW =
      courierPage.width *
      fitScale(
        courierPage.width,
        courierPage.height,
        innerW,
        maxCourierHeight(data.items, Boolean(legend)),
      );
    page.drawPage(courierPage, {
      x: AGENCY_PAD + (innerW - drawW) / 2,
      y: pageH - AGENCY_PAD - courierH,
      width: drawW,
      height: courierH,
    });
  }

  let y = pageH - AGENCY_PAD - courierH - GAP;

  page.drawLine({
    start: { x: AGENCY_PAD, y },
    end: { x: PAGE_W - AGENCY_PAD, y },
    thickness: 1.4,
    color: INK,
  });
  y -= 3.5 * MM;

  // Cabecera de la banda: de qué pedido es esta caja y con qué guía viaja. El
  // número del courier se repite acá a propósito, aunque esté en su papel: si
  // alguien despega su etiqueta, la caja todavía dice a dónde iba.
  const store = sanitizeWinAnsi(data.storeName).toUpperCase() || "-";
  page.drawText(store, { x: AGENCY_PAD, y: y - 9, size: 9, font: fonts.bold, color: INK });
  const order = sanitizeWinAnsi(data.orderName) || sanitizeWinAnsi(data.code);
  page.drawText(order, {
    x: PAGE_W - AGENCY_PAD - fonts.bold.widthOfTextAtSize(order, 11),
    y: y - 11,
    size: 11,
    font: fonts.bold,
    color: INK,
  });
  y -= 11 + 1.6 * MM;

  const guide = sanitizeWinAnsi(data.guideCode ?? "");
  const codeLine = guide ? `${sanitizeWinAnsi(data.code)}  ·  GUIA ${guide}` : sanitizeWinAnsi(data.code);
  page.drawText(codeLine, { x: AGENCY_PAD, y: y - 8, size: 8, font: fonts.regular, color: MUTED });
  y -= 8 + 1.4 * MM;

  // El destinatario va aquí, bajo el código, y no suelto al pie: es dato de la
  // caja, no un adorno del margen.
  if (legend) {
    page.drawText(legend, { x: AGENCY_PAD, y: y - 8, size: 8, font: fonts.regular, color: MUTED });
    y -= 8 + 1.2 * MM;
  }
  y -= 1.4 * MM;

  // QR a la derecha, productos a la izquierda: el QR se escanea sin leer y los
  // productos se leen sin escanear, así que no compiten por el mismo sitio.
  const qr = await doc.embedPng(data.qrPng);
  page.drawImage(qr, {
    x: PAGE_W - AGENCY_PAD - QR_SIZE,
    y: y - QR_SIZE,
    width: QR_SIZE,
    height: QR_SIZE,
  });

  drawProducts(page, fonts, {
    x: AGENCY_PAD,
    y,
    width: innerW - QR_SIZE - 4 * MM,
    items: data.items,
    minY: AGENCY_PAD,
    maxLines: MAX_PRODUCT_LINES,
  });

  return doc.save();
}
