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
  PAD,
  PAGE_H,
  PAGE_W,
  PRODUCT_LINE_H,
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
 * Alto MÍNIMO de nuestra banda, y con eso el máximo que puede ocupar el courier.
 *
 * Es un suelo, no un reparto. La primera versión partía la hoja en dos cajas
 * fijas —88 mm arriba, 46 abajo— y el rótulo de Shalom resultó ser APAISADO: a
 * todo el ancho ocupa unos 45 mm de alto, así que dejaba 43 mm de aire muerto en
 * el centro de la etiqueta. Un reparto fijo solo acierta con una proporción, y
 * la de cada courier es la suya.
 *
 * Ahora la banda arranca donde termina su etiqueta, sea donde sea. Este número
 * solo garantiza que un rótulo desproporcionadamente alto no la deje sin sitio.
 */
const BAND_MIN_H = 34 * MM;

/** Aire entre su etiqueta y nuestra línea divisoria. */
const GAP = 3 * MM;

/**
 * El QR crece con el sitio disponible, entre estos dos topes.
 *
 * El suelo es lo que necesita la cámara: el token es un UUID, que a corrección M
 * son 29 módulos, y a 20 mm da 0,7 mm por módulo. El techo existe porque pasado
 * cierto tamaño ya no se lee mejor y sí le quita líneas al producto.
 */
const QR_MIN = 20 * MM;
const QR_MAX = 30 * MM;

/** Alto máximo que se le concede al rótulo del courier. */
export function maxCourierHeight(): number {
  return PAGE_H - PAD * 2 - BAND_MIN_H - GAP;
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
 * Alto que va a ocupar de verdad la etiqueta del courier en la hoja.
 *
 * Existe como función aparte para poder AFIRMAR sobre ella: es el número que
 * decide dónde empieza nuestra banda, y el que la primera versión daba por
 * supuesto. Con el rótulo apaisado de Shalom vale unos 45 mm de los 100 que se
 * le reservaban.
 */
export function courierDrawHeight(w: number, h: number): number {
  const innerW = PAGE_W - PAD * 2;
  return h * fitScale(w, h, innerW, maxCourierHeight());
}

/** Alto que le queda a nuestra banda con esa etiqueta encima. */
export function bandHeight(w: number, h: number): number {
  return PAGE_H - PAD * 2 - courierDrawHeight(w, h) - GAP;
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

  const page = doc.addPage([PAGE_W, PAGE_H]);
  const innerW = PAGE_W - PAD * 2;

  // Su página va PRIMERO y arriba: es la que se lee en el mostrador. Si viniera
  // con varias páginas se toma la primera, que es la etiqueta; las siguientes
  // suelen ser condiciones del servicio y no viajan pegadas a la caja.
  const [courierPage] = await doc.embedPdf(courierLabelPdf, [0]);
  let courierH = 0;
  if (courierPage) {
    const scale = fitScale(courierPage.width, courierPage.height, innerW, maxCourierHeight());
    const drawW = courierPage.width * scale;
    courierH = courierPage.height * scale;
    page.drawPage(courierPage, {
      x: PAD + (innerW - drawW) / 2,
      y: PAGE_H - PAD - courierH,
      width: drawW,
      height: courierH,
    });
  }

  // La banda EMPIEZA DONDE TERMINA SU ETIQUETA, no en una altura fija. Es la
  // diferencia entre ajustarse a cualquier proporción y acertar solo con una.
  let y = PAGE_H - PAD - courierH - GAP;

  page.drawLine({
    start: { x: PAD, y },
    end: { x: PAGE_W - PAD, y },
    thickness: 1.4,
    color: INK,
  });
  y -= 3.5 * MM;

  // Cabecera de la banda: de qué pedido es esta caja y con qué guía viaja. El
  // número del courier se repite acá a propósito, aunque esté en su papel: si
  // alguien despega su etiqueta, la caja todavía dice a dónde iba.
  const store = sanitizeWinAnsi(data.storeName).toUpperCase() || "-";
  page.drawText(store, { x: PAD, y: y - 9, size: 9, font: fonts.bold, color: INK });
  const order = sanitizeWinAnsi(data.orderName) || sanitizeWinAnsi(data.code);
  page.drawText(order, {
    x: PAGE_W - PAD - fonts.bold.widthOfTextAtSize(order, 11),
    y: y - 11,
    size: 11,
    font: fonts.bold,
    color: INK,
  });
  y -= 11 + 1.6 * MM;

  const guide = sanitizeWinAnsi(data.guideCode ?? "");
  const codeLine = guide ? `${sanitizeWinAnsi(data.code)}  ·  GUIA ${guide}` : sanitizeWinAnsi(data.code);
  page.drawText(codeLine, { x: PAD, y: y - 8, size: 8, font: fonts.regular, color: MUTED });
  y -= 8 + 1.4 * MM;

  // El destinatario va aquí, bajo el código, y no suelto al pie: es dato de la
  // caja, no un adorno del margen.
  const legend = sanitizeWinAnsi(data.customerName);
  if (legend) {
    page.drawText(legend, { x: PAD, y: y - 8, size: 8, font: fonts.regular, color: MUTED });
    y -= 8 + 1.2 * MM;
  }
  y -= 1.4 * MM;

  // EL SITIO QUE SOBRA SE REPARTE, no se deja en blanco. Con un rótulo apaisado
  // como el de Shalom la banda hereda casi la mitad de la hoja, y ese aire vale
  // más como QR grande y más líneas de producto que como margen: el QR se
  // escanea desde una faja transportadora y el operario lee el producto de pie.
  const available = y - PAD;
  const qrSize = Math.max(QR_MIN, Math.min(QR_MAX, available * 0.45));
  const qr = await doc.embedPng(data.qrPng);
  page.drawImage(qr, {
    x: PAGE_W - PAD - qrSize,
    y: y - qrSize,
    width: qrSize,
    height: qrSize,
  });

  // Los productos ocupan lo que el QR no usa, y bajan hasta el borde: el bloque
  // recorta por producto entero y avisa de las líneas que dejó fuera.
  const maxLines = Math.max(3, Math.floor((available - 4 * MM) / PRODUCT_LINE_H));
  drawProducts(page, fonts, {
    x: PAD,
    y,
    width: innerW - qrSize - 4 * MM,
    items: data.items,
    minY: PAD,
    maxLines,
  });

  return doc.save();
}
