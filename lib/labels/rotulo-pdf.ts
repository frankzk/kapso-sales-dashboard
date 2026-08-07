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
import {
  groupLabelItems,
  type LabelLineItem,
  type LabelProductGroup,
} from "@/lib/labels/line-items";
import { formatCollectAmount } from "@/lib/labels/amount";
import { code39Layout } from "@/lib/labels/barcode39";
import { normalizeOrderCode } from "@/lib/shipment-output";

/** 1 mm en puntos PostScript (72 dpi). */
const MM = 72 / 25.4;

const PAGE_W = 100 * MM;
const PAGE_H = 150 * MM;
const PAD = 8 * MM;

const INK = rgb(0.008, 0.023, 0.09); // slate-950, igual que el HTML
const MUTED = rgb(0.39, 0.45, 0.55); // slate-500
const LINE = rgb(0.8, 0.84, 0.88); // slate-300
// Las barras van en negro puro, no en el gris azulado del texto: el lector
// decide por contraste, y ahí no se gana nada con un tono de marca.
const BARCODE_INK = rgb(0, 0, 0);

export interface RotuloData {
  /** Código visible de la salida (output_code o guide_code). */
  code: string;
  /** Tienda del pedido: es la marca que el cliente reconoce, no "Kapta". */
  storeName: string | null;
  /** Pedido de Shopify (`#KP126875`): es lo que va en el código de barras. */
  orderName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  /** Líneas del pedido: cantidad, producto y variante. */
  items: LabelLineItem[];
  /** Total del pedido = lo que se cobra en la puerta. `null` si no se conoce. */
  collectAmount: number | null;
  /** Moneda del pedido; por defecto PEN. */
  currency: string | null;
  destination: string | null;
  address: string | null;
  reference: string | null;
  /** Nota del pedido en Shopify: instrucciones que escribió quien lo tomó. */
  note: string | null;
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

/**
 * Alto que consume un campo de `lines` líneas, incluido su separador.
 *
 * Los márgenes son ajustados a propósito: en 100 × 150 mm compiten el monto a
 * cobrar, la dirección, los productos y el QR, y el aire entre campos es lo
 * primero que se sacrifica para que ninguno de esos cuatro desaparezca.
 */
export function fieldHeight(lines: number, valueSize: number): number {
  return 1.2 * MM + lines * (valueSize + 1.2) + 1.2 * MM + 1.8 * MM;
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
    /** Aire extra bajo el campo, repartido por el planificador. */
    gap?: number;
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
  let cursor = opts.y - valueSize - 1.2 * MM;
  for (const line of lines.length ? lines : ["-"]) {
    page.drawText(line, { x: opts.x, y: cursor, size: valueSize, font: fonts.bold, color: INK });
    cursor -= valueSize + 1.2;
  }

  const bottom = cursor + valueSize - 1.2 * MM;
  page.drawLine({
    start: { x: opts.x, y: bottom },
    end: { x: opts.x + opts.width, y: bottom },
    thickness: 0.5,
    color: LINE,
  });
  return bottom - 1.8 * MM - (opts.gap ?? 0);
}

/** Tamaño base de la tabla de productos y alto de cada línea suya. */
const PRODUCT_SIZE = 8.5;
const PRODUCT_LINE_H = PRODUCT_SIZE + 1.4;

/** Cuántas líneas ocupa un producto: el título, y una por variante si las tiene. */
export function groupLines(group: LabelProductGroup): number {
  const single = group.variants[0];
  if (group.variants.length === 1 && !single?.variant) return 1;
  return 1 + group.variants.length;
}

/**
 * Qué productos caben en `maxLines` y cuántos quedan fuera.
 *
 * Se corta por producto entero, nunca a media lista de tallas: media lista es
 * peor que ninguna, porque parece completa. La línea del aviso se descuenta
 * antes de decidir, así que "+ N productos mas" siempre tiene dónde escribirse.
 */
export function fitProducts(
  groups: readonly LabelProductGroup[],
  maxLines: number,
): { drawn: LabelProductGroup[]; hidden: number } {
  const drawn: LabelProductGroup[] = [];
  let used = 0;
  for (let i = 0; i < groups.length; i += 1) {
    const need = groupLines(groups[i]!);
    const noticeNeeded = i < groups.length - 1 ? 1 : 0;
    if (used + need + noticeNeeded > maxLines) break;
    drawn.push(groups[i]!);
    used += need;
  }
  return { drawn, hidden: groups.length - drawn.length };
}

/**
 * Alto del bloque de productos cuando se le conceden `maxLines` líneas.
 *
 * Lo usa el planificador para saber cuánto sitio pedir antes de dibujar nada.
 */
export function productsHeight(items: readonly LabelLineItem[], maxLines: number): number {
  const groups = groupLabelItems(items);
  const { drawn, hidden } = fitProducts(groups, maxLines);
  let lines = drawn.reduce((sum, group) => sum + groupLines(group), 0);
  if (hidden > 0) lines += 1; // "+ N productos mas"
  if (!lines) lines = 1; // el guion de "sin productos"
  // Cabecera del bloque + líneas + el separador que cierra.
  return PRODUCT_SIZE + 1.2 * MM + lines * PRODUCT_LINE_H + 1.8 * MM;
}

/** Total de líneas que pediría la lista completa, sin recortes. */
function productsNaturalLines(items: readonly LabelLineItem[]): number {
  return groupLabelItems(items).reduce((sum, group) => sum + groupLines(group), 0);
}

/**
 * Tabla de productos: el título una vez, y debajo una línea por variante.
 *
 * Quien arma la caja necesita CUÁNTOS y CUÁL. El título de Shopify puede traer
 * 200 caracteres de copy publicitario, así que se recorta a una línea — y por
 * eso NO se repite por talla: tres veces el mismo texto truncado se ve idéntico
 * y gastaba las líneas que necesitaban los demás productos. La VARIANTE (talla,
 * color) lleva su propia cantidad, porque empacar la talla equivocada es un
 * reenvío completo.
 */
function drawProducts(
  page: PDFPage,
  fonts: Fonts,
  opts: {
    x: number;
    y: number;
    width: number;
    items: readonly LabelLineItem[];
    minY: number;
    /** Líneas concedidas por el planificador; lo que no entra va como aviso. */
    maxLines?: number;
  },
): number {
  const size = PRODUCT_SIZE;
  const qtyW = 9 * MM;
  const nameX = opts.x + qtyW;
  const nameW = opts.width - qtyW;
  const lineH = PRODUCT_LINE_H;

  page.drawText("PRODUCTOS", {
    x: opts.x,
    y: opts.y,
    size: 6,
    font: fonts.bold,
    color: MUTED,
  });

  let cursor = opts.y - size - 1.2 * MM;

  /** Cantidad + "x". Más de una unidad se imprime más grande: empacar una sola
   * cuando iban dos es un reenvío, así que el número tiene que saltar a la vista. */
  const drawQty = (quantity: number, y: number) => {
    const qty = `${quantity}`;
    const qtySize = quantity > 1 ? size + 2.5 : size;
    page.drawText(qty, { x: opts.x, y, size: qtySize, font: fonts.bold, color: INK });
    page.drawText("x", {
      x: opts.x + fonts.bold.widthOfTextAtSize(qty, qtySize) + 1.5,
      y,
      size: size - 2,
      font: fonts.regular,
      color: MUTED,
    });
  };

  const groups = groupLabelItems(opts.items);
  const roomLines = Math.floor((cursor - opts.minY) / lineH + 1e-9);
  const { drawn, hidden } = fitProducts(groups, Math.min(opts.maxLines ?? roomLines, roomLines));

  for (const group of drawn) {
    const single = group.variants[0]!;
    const [nameLine] = wrapText(group.name, fonts.bold, size, nameW, 1);

    if (group.variants.length === 1 && !single.variant) {
      drawQty(single.quantity, cursor);
      page.drawText(nameLine ?? "Producto", {
        x: nameX,
        y: cursor,
        size,
        font: fonts.bold,
        color: INK,
      });
      cursor -= lineH;
      continue;
    }

    // Varias tallas del mismo producto: el título una vez, las variantes debajo.
    page.drawText(nameLine ?? "Producto", {
      x: nameX,
      y: cursor,
      size,
      font: fonts.bold,
      color: INK,
    });
    cursor -= lineH;
    for (const variant of group.variants) {
      drawQty(variant.quantity, cursor);
      const [variantLine] = wrapText(variant.variant ?? "-", fonts.bold, size, nameW, 1);
      page.drawText(variantLine ?? "-", {
        x: nameX,
        y: cursor,
        size,
        font: fonts.bold,
        color: INK,
      });
      cursor -= lineH;
    }
  }

  if (!drawn.length) {
    page.drawText("-", { x: opts.x, y: cursor, size, font: fonts.bold, color: INK });
    cursor -= lineH;
  } else if (hidden > 0) {
    // Nunca callar lo que no cupo: el almacén tiene que saber que faltan líneas.
    page.drawText(`+ ${hidden} producto${hidden === 1 ? "" : "s"} mas (ver el pedido)`, {
      x: opts.x,
      y: cursor,
      size: 7,
      font: fonts.regular,
      color: MUTED,
    });
    cursor -= lineH;
  }

  const bottom = cursor + size - 1.2 * MM;
  page.drawLine({
    start: { x: opts.x, y: bottom },
    end: { x: opts.x + opts.width, y: bottom },
    thickness: 0.5,
    color: LINE,
  });
  return bottom - 1.8 * MM;
}

/** Alto de las barras del código de barras del pedido. */
const BARCODE_H = 9 * MM;

/**
 * Qué se codifica en el código de barras: EL PEDIDO DE SHOPIFY, no la salida.
 *
 * Mientras la operación no esté migrada del todo, el almacén pistolea el rótulo
 * contra un Excel cuya clave es el número de pedido de Shopify. Un código de
 * barras con `KP126875-S01` obligaría a limpiar el sufijo a mano en cada fila —
 * y a inventar una regla nueva el día que un pedido tenga dos salidas.
 *
 * La fuente es `orderName`. Si falta, se acepta derivarlo del código de salida
 * SOLO cuando este tiene la forma `PEDIDO-Sxx` que construye `buildOutputCode`:
 * ahí el prefijo es, por construcción, el pedido. Un `guide_code` de courier no
 * pasa ese filtro y se queda sin código de barras, que es lo correcto —
 * pistolear un número de guía dentro de la columna del pedido contamina el
 * Excel en silencio, y eso se descubre tarde y mal.
 */
export function orderBarcodeValue(
  orderName: string | null | undefined,
  code: string | null | undefined,
): string {
  const fromOrder = normalizeOrderCode(orderName);
  if (fromOrder) return fromOrder;
  const derived = /^([A-Z0-9-]+?)-S\d{2}(?:-|$)/.exec((code ?? "").trim().toUpperCase());
  return derived?.[1] ?? "";
}

/** Alto de la banda del monto a cobrar. */
const AMOUNT_BAND_H = 14 * MM;

/**
 * La banda del monto a cobrar: lo más grande del rótulo.
 *
 * Es el dato que más caro sale equivocar —cobrar de menos es plata perdida,
 * cobrar de más es una devolución— y quien lo lee lo hace en la puerta, de pie y
 * con el paquete en la mano. Por eso ocupa el ancho completo, va en recuadro y
 * la cifra se dibuja al mayor tamaño que quepa, no a uno fijo.
 *
 * Sin monto conocido NO se escribe cero: un cero manda a entregar sin cobrar.
 * Se manda a mirar el pedido, que es lo que un motorizado puede hacer.
 */
function drawCollectBand(
  page: PDFPage,
  fonts: Fonts,
  opts: { x: number; y: number; width: number; amount: number | null; currency: string | null },
): number {
  const top = opts.y;
  const bottom = top - AMOUNT_BAND_H;

  page.drawRectangle({
    x: opts.x,
    y: bottom,
    width: opts.width,
    height: AMOUNT_BAND_H,
    borderColor: INK,
    borderWidth: 1.2,
  });

  page.drawText("COBRAR EN LA ENTREGA", {
    x: opts.x + 3 * MM,
    y: top - 3.6 * MM,
    size: 6.5,
    font: fonts.bold,
    color: MUTED,
  });

  const text = formatCollectAmount(opts.amount, opts.currency);
  // Sin cifra el mensaje es una instrucción, no un importe: va más pequeño para
  // que nadie lo confunda de lejos con un monto real.
  const value = sanitizeWinAnsi(text ?? "VER PEDIDO");
  let size = text ? 26 : 14;
  const maxW = opts.width - 6 * MM;
  while (size > 8 && fonts.bold.widthOfTextAtSize(value, size) > maxW) size -= 0.5;

  // La cifra se apoya en la base de la banda, no en su centro: así el aire libre
  // queda entre el rótulo pequeño y los dígitos, que es donde se leía apretado.
  page.drawText(value, {
    x: opts.x + (opts.width - fonts.bold.widthOfTextAtSize(value, size)) / 2,
    y: bottom + 2.4 * MM,
    size,
    font: fonts.bold,
    color: INK,
  });

  return bottom - 4.5 * MM;
}

/** Los cinco bloques de datos, en orden, tal como se dibujan. */
const FIELD_BLOCKS = 5;

/** Aire extra que puede repartirse entre bloques cuando sobra sitio. */
const MAX_EXTRA_GAP = 5 * MM;

/**
 * Cuántas líneas recibe cada campo y cuánto aire va entre ellos.
 *
 * POR QUÉ SE PLANIFICA ANTES DE DIBUJAR. Con los campos apretados al mínimo, un
 * rótulo de un solo producto quedaba denso arriba y con un hueco enorme sobre el
 * QR: feo y, peor, engañoso — parece que falta información. Midiendo primero se
 * sabe cuánto sobra y se reparte como aire entre bloques.
 *
 * Cuando en vez de sobrar FALTA, el orden en que se cede está fijado aquí y no
 * en el azar del orden de dibujo: primero la referencia, luego el distrito,
 * después los productos y solo al final la dirección, que es lo que decide si el
 * paquete llega.
 */
function planFields(
  fonts: Fonts,
  data: RotuloData,
  width: number,
  available: number,
): { address: number; destination: number; reference: number; productLines: number; gap: number } {
  const linesOf = (value: string | null, size: number, max: number) =>
    Math.max(1, wrapText(value || "-", fonts.bold, size, width, max).length);

  const plan = {
    address: linesOf(data.address, 11, 3),
    destination: linesOf(data.destination, 9.5, 2),
    reference: data.reference ? linesOf(data.reference, 9.5, 2) : 1,
    productLines: productsNaturalLines(data.items),
    gap: 0,
  };

  const height = () =>
    fieldHeight(1, 9.5) + // cliente + celular, en dos columnas
    fieldHeight(plan.address, 11) +
    (plan.destination > 0 ? fieldHeight(plan.destination, 9.5) : 0) +
    (plan.reference > 0 ? fieldHeight(plan.reference, 9.5) : 0) +
    productsHeight(data.items, plan.productLines);

  const shrink: (() => boolean)[] = [
    () => (plan.reference > 1 ? ((plan.reference = 1), true) : false),
    () => (plan.reference > 0 ? ((plan.reference = 0), true) : false),
    () => (plan.destination > 1 ? ((plan.destination = 1), true) : false),
    () => (plan.productLines > 1 ? ((plan.productLines -= 1), true) : false),
    () => (plan.address > 1 ? ((plan.address -= 1), true) : false),
  ];
  for (const step of shrink) {
    while (height() > available && step()) {
      /* seguir cediendo por este mismo concepto antes de pasar al siguiente */
    }
  }

  const blocks = FIELD_BLOCKS - (plan.destination ? 0 : 1) - (plan.reference ? 0 : 1);
  const slack = available - height();
  plan.gap = Math.max(0, Math.min(slack / blocks, MAX_EXTRA_GAP));
  return plan;
}

/** Dibuja un rótulo completo en su propia página. */
function drawRotulo(doc: PDFDocument, fonts: Fonts, data: RotuloData, qr: unknown): void {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const innerW = PAGE_W - PAD * 2;
  let y = PAGE_H - PAD;

  // Cabecera: la TIENDA, el código de salida y el código de barras del pedido,
  // centrados y en ese orden — el mismo bloque que traen las guías de Shopify
  // que el almacén todavía imprime, para que la mano no cambie de sitio al
  // pasar de un papel al otro.
  //
  // Antes decía "KAPTA - SALIDA FISICA" —que no le dice nada a nadie: quien
  // recibe la caja no conoce a Kapta— y el courier arriba a la derecha. El
  // courier ya viaja dentro del código cuando está decidido (KP123-S01-ALICLIK)
  // y, cuando no lo está, un "POR DEFINIR" grande en el rótulo es ruido: quien
  // lo decide es la Mesa de despacho, no quien lee la etiqueta.
  const centered = (text: string, size: number) =>
    PAD + (innerW - fonts.bold.widthOfTextAtSize(text, size)) / 2;

  const store = sanitizeWinAnsi(data.storeName).toUpperCase() || "-";
  const storeSize = 10.5;
  page.drawText(store, {
    x: centered(store, storeSize),
    y: y - storeSize,
    size: storeSize,
    font: fonts.bold,
    color: INK,
  });
  y -= storeSize + 1.6 * MM;

  // El código de salida se escribe entero —`KP124122-S01`— y ya no se repite el
  // pedido al costado: el número de Shopify está debajo, en las barras, y
  // gastar una fila del rótulo en decirlo tres veces era desperdiciarla.
  const code = sanitizeWinAnsi(data.code) || "-";
  let codeSize = 16;
  while (codeSize > 9 && fonts.bold.widthOfTextAtSize(code, codeSize) > innerW) codeSize -= 0.5;
  page.drawText(code, {
    x: centered(code, codeSize),
    y: y - codeSize,
    size: codeSize,
    font: fonts.bold,
    color: INK,
  });
  y -= codeSize + 2 * MM;

  // Las barras: el PEDIDO de Shopify, que es la clave del Excel con el que hoy
  // se cuadra la operación. Sin texto legible debajo —a diferencia del rótulo
  // de Shopify, que lo trae porque la fuente lo dibuja gratis—: el código de
  // arriba ya contiene el pedido, y esa línea repetida costaba 3 mm que aquí
  // los necesita la dirección.
  const barcode = code39Layout(orderBarcodeValue(data.orderName, data.code), innerW);
  if (barcode) {
    const barsX = PAD + (innerW - barcode.width) / 2;
    for (const bar of barcode.bars) {
      page.drawRectangle({
        x: barsX + bar.x,
        y: y - BARCODE_H,
        width: bar.width,
        height: BARCODE_H,
        color: BARCODE_INK,
      });
    }
    y -= BARCODE_H;
  }

  y -= 2.5 * MM;
  page.drawLine({
    start: { x: PAD, y },
    end: { x: PAGE_W - PAD, y },
    thickness: 1.4,
    color: INK,
  });
  y -= 4 * MM;

  // Lo más importante, arriba del todo y en recuadro: el monto a cobrar.
  y = drawCollectBand(page, fonts, {
    x: PAD,
    y,
    width: innerW,
    amount: data.collectAmount,
    currency: data.currency,
  });

  // Pie fijo: QR + leyenda. Se ancla abajo para que todas las etiquetas lo
  // tengan en el mismo sitio, aunque los datos de arriba varíen de alto. Los
  // campos de arriba nunca pueden bajar de `fieldsFloor`.
  // 24 mm de QR: el token es un UUID, que a corrección M cabe en 29 módulos —
  // 0,8 mm por módulo, de sobra para la cámara de un celular. Los 2 mm que se
  // le quitaron, más el aire de abajo, son los que financian el código de
  // barras de la cabecera sin que los campos pierdan una línea.
  const qrSize = 24 * MM;
  // La leyenda del QR baja a pie de página, en chico: se lee una vez en la vida
  // y estaba ocupando el mejor espacio del rótulo — el que ahora usan las NOTAS.
  const legendH = 4.5 * MM;
  const qrBottom = PAD + legendH;
  const footerTop = qrBottom + qrSize + 4 * MM;
  const fieldsFloor = footerTop + 2.5 * MM;

  // Se mide todo antes de escribir nada: así el aire sobrante se reparte entre
  // los bloques en vez de acumularse en un hueco encima del QR.
  const plan = planFields(fonts, data, innerW, y - fieldsFloor);
  const gap = plan.gap;

  // Cliente y celular comparten fila, pero NO a mitades: un celular son once
  // dígitos y un nombre completo no entra en media etiqueta —"Maria Fernanda de
  // lo..." no sirve para preguntar por nadie en la puerta.
  const phoneW = 26 * MM;
  const clientW = innerW - phoneW - 4 * MM;
  const leftAfter = drawField(page, fonts, {
    x: PAD,
    y,
    width: clientW,
    label: "Cliente",
    value: data.customerName,
    maxLines: 1,
    minY: fieldsFloor,
    gap,
  });
  const rightAfter = drawField(page, fonts, {
    x: PAD + clientW + 4 * MM,
    y,
    width: phoneW,
    label: "Celular",
    value: data.customerPhone,
    maxLines: 1,
    minY: fieldsFloor,
    gap,
  });
  y = Math.min(leftAfter, rightAfter);

  // La dirección es lo que decide si el paquete llega: va más grande y es la
  // última en ceder líneas cuando el rótulo va apretado.
  y = drawField(page, fonts, {
    x: PAD,
    y,
    width: innerW,
    label: "Direccion",
    value: data.address,
    valueSize: 11,
    maxLines: plan.address,
    minY: fieldsFloor,
    gap,
  });
  if (plan.destination > 0) {
    y = drawField(page, fonts, {
      x: PAD,
      y,
      width: innerW,
      label: "Distrito / Provincia",
      value: data.destination,
      maxLines: plan.destination,
      minY: fieldsFloor,
      gap,
    });
  }
  if (plan.reference > 0) {
    y = drawField(page, fonts, {
      x: PAD,
      y,
      width: innerW,
      label: "Referencia",
      value: data.reference,
      maxLines: plan.reference,
      minY: fieldsFloor,
      gap,
    });
  }
  y = drawProducts(page, fonts, {
    x: PAD,
    y,
    width: innerW,
    items: data.items,
    maxLines: plan.productLines,
    minY: fieldsFloor,
  });
  page.drawLine({
    start: { x: PAD, y: footerTop },
    end: { x: PAGE_W - PAD, y: footerTop },
    thickness: 1.4,
    color: INK,
  });

  page.drawImage(qr as never, { x: PAD, y: qrBottom, width: qrSize, height: qrSize });

  // A la derecha del QR, LA NOTA DEL PEDIDO. Es lo que escribió quien lo tomó
  // —"enviar con Tanders", "antes de la 1:30"— y quien arma la caja no la tenía
  // en ninguna parte del papel: había que abrir Shopify para enterarse.
  const noteX = PAD + qrSize + 5 * MM;
  const noteW = PAGE_W - PAD - noteX;
  const noteTop = qrBottom + qrSize - 7;
  page.drawText("NOTAS DEL PEDIDO", {
    x: noteX,
    y: noteTop,
    size: 6.5,
    font: fonts.bold,
    color: MUTED,
  });

  const noteSize = 8.5;
  const noteLineH = noteSize + 1.6;
  // Cuántas líneas caben junto al QR sin bajar de su base.
  const noteRoom = Math.floor((noteTop - 3.5 * MM - qrBottom) / noteLineH + 1e-9);
  const noteLines = wrapText(data.note ?? "", fonts.bold, noteSize, noteW, Math.max(0, noteRoom));
  let noteY = noteTop - 3.5 * MM;
  if (noteLines.length) {
    for (const line of noteLines) {
      page.drawText(line, { x: noteX, y: noteY, size: noteSize, font: fonts.bold, color: INK });
      noteY -= noteLineH;
    }
  } else {
    page.drawText("Sin notas", {
      x: noteX,
      y: noteY,
      size: noteSize - 1,
      font: fonts.regular,
      color: MUTED,
    });
  }

  // Pie: la instrucción del QR y su token, en el tamaño más chico del rótulo.
  const legend = `Escanear en cada cotejo - ${sanitizeWinAnsi(data.qrPayload)}`;
  const legendLine =
    wrapText(legend, fonts.regular, 5.5, innerW, 1)[0] ?? "Escanear en cada cotejo";
  page.drawText(legendLine, {
    x: PAD,
    y: PAD,
    size: 5.5,
    font: fonts.regular,
    color: MUTED,
  });
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
