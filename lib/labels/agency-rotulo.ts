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
  LINE,
  MM,
  MUTED,
  PAD,
  PAGE_H,
  PAGE_W,
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
 * Alto reservado a nuestra banda inferior.
 *
 * Es el mínimo que deja legible lo que el almacén busca en ella: el QR a 22 mm
 * —el token es un UUID y a corrección M entra de sobra para la cámara de un
 * celular—, la cabecera con pedido y guía, y tres o cuatro líneas de producto.
 * Todo lo que sobra se lo queda el papel del courier, que es el que va a leer
 * una persona en el mostrador.
 */
const BAND_H = 46 * MM;
const QR_SIZE = 22 * MM;

/** Lo que queda para el courier una vez servida la banda. */
export function courierBoxHeight(): number {
  return PAGE_H - PAD * 2 - BAND_H;
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
  const boxH = courierBoxHeight();
  if (courierPage) {
    const scale = fitScale(courierPage.width, courierPage.height, innerW, boxH);
    const drawW = courierPage.width * scale;
    const drawH = courierPage.height * scale;
    page.drawPage(courierPage, {
      x: PAD + (innerW - drawW) / 2,
      // Pegado al borde superior de su caja: si su etiqueta es más baja que la
      // caja, el aire sobrante cae del lado de la banda, no entre los dos.
      y: PAGE_H - PAD - drawH,
      width: drawW,
      height: drawH,
    });
  }

  let y = PAGE_H - PAD - boxH;

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
  y -= 8 + 2.4 * MM;

  // QR a la derecha, productos a la izquierda: el QR se escanea sin leer y los
  // productos se leen sin escanear, así que no compiten por el mismo sitio.
  const qr = await doc.embedPng(data.qrPng);
  const qrX = PAGE_W - PAD - QR_SIZE;
  const qrY = PAD;
  page.drawImage(qr, { x: qrX, y: qrY, width: QR_SIZE, height: QR_SIZE });

  const productsW = innerW - QR_SIZE - 4 * MM;
  drawProducts(page, fonts, {
    x: PAD,
    y,
    width: productsW,
    items: data.items,
    minY: PAD,
    // Lo que cabe entre la cabecera de la banda y el borde inferior. El bloque
    // recorta por producto entero y avisa de lo que dejó fuera.
    maxLines: 4,
  });

  const legend = sanitizeWinAnsi(data.customerName) || "";
  if (legend) {
    page.drawText(legend, {
      x: PAD,
      y: PAD,
      size: 7.5,
      font: fonts.regular,
      color: MUTED,
    });
  }

  page.drawLine({
    start: { x: PAD, y: PAD + QR_SIZE + 1.5 * MM },
    end: { x: PAGE_W - PAD, y: PAD + QR_SIZE + 1.5 * MM },
    thickness: 0.5,
    color: LINE,
  });

  return doc.save();
}
