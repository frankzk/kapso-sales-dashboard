// Code 39 dibujado como barras, sin fuente de código de barras.
//
// POR QUÉ NO SE USA UNA FUENTE. El rótulo de Shopify resuelve esto con
// `Libre Barcode 39 Text`: el navegador descarga la fuente y el texto `*KP1234*`
// se ve como barras. Aquí el PDF lo arma el servidor con pdf-lib, así que esa
// vía obliga a incrustar un fichero de fuente en el bundle y a confiar en que
// cada carácter se renderice con el ancho exacto. Un rótulo cuya legibilidad
// depende de la métrica de una fuente es un rótulo que un día no escanea.
//
// Las barras son rectángulos: anchos exactos, negro puro y cero dependencias.
//
// Code 39 en una línea: cada carácter son 9 elementos que alternan
// barra/espacio empezando por barra, de los cuales 3 son anchos. Entre carácter
// y carácter va un espacio estrecho. El símbolo abre y cierra con `*`, que el
// lector no devuelve: quien escanea recibe exactamente el texto codificado.

/**
 * Patrón de cada carácter: 9 elementos, `1` = ancho, `0` = estrecho.
 * Posiciones pares = barra, impares = espacio.
 */
export const CODE39_PATTERNS: Readonly<Record<string, string>> = {
  "0": "000110100",
  "1": "100100001",
  "2": "001100001",
  "3": "101100000",
  "4": "000110001",
  "5": "100110000",
  "6": "001110000",
  "7": "000100101",
  "8": "100100100",
  "9": "001100100",
  A: "100001001",
  B: "001001001",
  C: "101001000",
  D: "000011001",
  E: "100011000",
  F: "001011000",
  G: "000001101",
  H: "100001100",
  I: "001001100",
  J: "000011100",
  K: "100000011",
  L: "001000011",
  M: "101000010",
  N: "000010011",
  O: "100010010",
  P: "001010010",
  Q: "000000111",
  R: "100000110",
  S: "001000110",
  T: "000010110",
  U: "110000001",
  V: "011000001",
  W: "111000000",
  X: "010010001",
  Y: "110010000",
  Z: "011010000",
  "-": "010000101",
  ".": "110000100",
  " ": "011000100",
  $: "010101000",
  "/": "010100010",
  "+": "010001010",
  "%": "000101010",
  "*": "010010100",
};

/** Delimitador de inicio y fin. El lector no lo entrega al PC. */
const GUARD = "*";

/**
 * Deja solo lo que Code 39 sabe representar.
 *
 * Un carácter fuera del alfabeto no se puede sustituir por otro: el lector
 * devolvería un texto distinto del pedido y el Excel quedaría con basura. Se
 * descarta. En la práctica no llega a ocurrir —los códigos de pedido ya vienen
 * normalizados a letras, dígitos y guion— y esto es la red de seguridad.
 */
export function code39Sanitize(value: string | null | undefined): string {
  return (value ?? "")
    .toUpperCase()
    .split("")
    .filter((ch) => ch !== GUARD && ch in CODE39_PATTERNS)
    .join("");
}

/**
 * Ancho de una barra ancha, en unidades de barra estrecha.
 *
 * 3:1 es la proporción clásica y la más tolerante a impresoras térmicas
 * gastadas; 2:1 sigue siendo válido y se reserva para códigos largos, donde el
 * símbolo a 3:1 obligaría a estrechar tanto la barra fina que dejaría de
 * imprimirse limpia.
 */
const WIDE_RATIOS = [3, 2] as const;

/**
 * Barra estrecha mínima, en puntos. Una térmica de 203 dpi imprime puntos de
 * 0,125 mm: por debajo de dos puntos (~0,7 pt) la barra fina sale mordida y el
 * lector empieza a fallar.
 */
const MIN_NARROW = 0.72;

/**
 * Barra estrecha máxima, en puntos. Sin tope, un pedido corto se comería el
 * ancho del rótulo con barras gordísimas.
 */
const MAX_NARROW = 1.8;

export interface Code39Layout {
  /** Barras a dibujar, en puntos, medidas desde el inicio del símbolo. */
  bars: { x: number; width: number }[];
  /** Ancho total del símbolo, en puntos. */
  width: number;
  /** Ancho de la barra estrecha, en puntos. */
  narrow: number;
  /** Zona muda exigida a cada lado: 10 barras estrechas. */
  quietZone: number;
  /** Texto realmente codificado, sin los delimitadores. */
  value: string;
}

/** Anchos de los elementos en unidades estrechas, alternando barra/espacio. */
function elementsFor(text: string, wide: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (i > 0) out.push(1); // separador entre caracteres: un espacio estrecho
    for (const bit of CODE39_PATTERNS[text[i]!]!) out.push(bit === "1" ? wide : 1);
  }
  return out;
}

/**
 * Geometría del símbolo para un ancho disponible dado.
 *
 * Devuelve `null` cuando no hay nada que codificar o cuando ni siquiera a 2:1
 * cabría con barras imprimibles: mejor un rótulo sin código de barras que uno
 * con un código que no escanea, porque el segundo se descubre en el almacén.
 */
export function code39Layout(value: string, maxWidth: number): Code39Layout | null {
  const clean = code39Sanitize(value);
  if (!clean) return null;

  const text = `${GUARD}${clean}${GUARD}`;
  for (const wide of WIDE_RATIOS) {
    const elements = elementsFor(text, wide);
    const units = elements.reduce((sum, width) => sum + width, 0);
    const narrow = Math.min(maxWidth / units, MAX_NARROW);
    if (narrow < MIN_NARROW && wide !== WIDE_RATIOS[WIDE_RATIOS.length - 1]) continue;
    if (narrow < MIN_NARROW) return null;

    const bars: { x: number; width: number }[] = [];
    let cursor = 0;
    elements.forEach((width, index) => {
      const size = width * narrow;
      if (index % 2 === 0) bars.push({ x: cursor, width: size });
      cursor += size;
    });
    return { bars, width: cursor, narrow, quietZone: narrow * 10, value: clean };
  }
  return null;
}
