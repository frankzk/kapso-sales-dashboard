// El tamaño de la foto que sube el motorizado (30-09-2026).
//
// Las cámaras de los celulares sacan fotos de 8 a 50 MP (4 a 12 MB). Subirlas
// tal cual gasta los datos del motorizado, tarda en la calle y, pasados
// 4,5 MB, ni siquiera llega: Vercel corta el cuerpo de la petición antes de la
// función. Para una fachada, una cara o un Yape basta el lado mayor en 1600 px
// en JPEG al 72 %: entre 150 y 400 KB.

/** Lado mayor de la foto que se sube, en píxeles. */
export const PHOTO_MAX_SIDE = 1600;

/** Calidad del JPEG (0–1). */
export const PHOTO_QUALITY = 0.72;

/** Un JPEG que ya cumple y pesa menos que esto se sube tal cual. */
export const PHOTO_AS_IS_BYTES = 600 * 1024;

/** Lo que el servidor acepta: por debajo del corte de Vercel (4,5 MB). */
export const PHOTO_UPLOAD_LIMIT = 4 * 1024 * 1024;

/** Las medidas que caben en `maxSide` sin deformar la foto; nunca la agranda. */
export function fitWithin(width: number, height: number, maxSide: number = PHOTO_MAX_SIDE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** ¿Se sube sin volver a codificar? Solo un JPEG ya chico y liviano. */
export function canUploadAsIs(file: { size: number; type: string }, dims: { width: number; height: number }): boolean {
  return /^image\/jpe?g$/i.test(file.type) && file.size <= PHOTO_AS_IS_BYTES && Math.max(dims.width, dims.height) <= PHOTO_MAX_SIDE;
}

/** Cuánto de la foto se lee para encontrar sus medidas (el EXIF puede traer una miniatura). */
export const PHOTO_HEADER_BYTES = 256 * 1024;

function u32be(b: Uint8Array, i: number): number {
  return ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
}

function ascii(b: Uint8Array, i: number, n: number): string {
  let out = "";
  for (let k = 0; k < n; k++) out += String.fromCharCode(b[i + k] ?? 0);
  return out;
}

/**
 * Las medidas guardadas de una foto, leídas de su cabecera sin decodificarla:
 * JPEG (marcador SOF), PNG (IHDR) y WebP (VP8, VP8L, VP8X). Con ellas se le
 * pide al navegador que la decodifique YA reducida y una foto de 12 MP no
 * ocupa 48 MB de memoria antes de achicarse (revisión del 30-09-2026). Null si
 * no se reconoce: entonces se decodifica entera, como antes.
 */
export function readImageSize(b: Uint8Array): { width: number; height: number } | null {
  const ok = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  // PNG: firma de 8 bytes y el IHDR con ancho y alto en big endian.
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return ok(u32be(b, 16), u32be(b, 20));
  // JPEG: se recorren los segmentos hasta el primer SOF.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 8 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) return null;
      const length = (b[i + 2]! << 8) | b[i + 3]!;
      if (length < 2) return null;
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return ok((b[i + 7]! << 8) | b[i + 8]!, (b[i + 5]! << 8) | b[i + 6]!);
      i += 2 + length;
    }
    return null;
  }
  // WebP: contenedor RIFF con un trozo VP8X, VP8 (con pérdida) o VP8L.
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8X") return ok(1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)));
    if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return ok((b[26]! | (b[27]! << 8)) & 0x3fff, (b[28]! | (b[29]! << 8)) & 0x3fff);
    }
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
      return ok(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
    }
  }
  return null;
}

/**
 * Cómo decodificar la foto: ya reducida por su lado mayor, o entera si ya es
 * chica. Se pide UN solo lado para que el navegador conserve la proporción,
 * también cuando la orientación EXIF gira la foto: en el peor caso sale algo
 * más grande que 1600 px y el lienzo la termina de ajustar, nunca deformada.
 */
export function decodeResize(size: { width: number; height: number } | null): { resizeWidth?: number; resizeHeight?: number } {
  if (!size || Math.max(size.width, size.height) <= PHOTO_MAX_SIDE) return {};
  return size.width >= size.height ? { resizeWidth: PHOTO_MAX_SIDE } : { resizeHeight: PHOTO_MAX_SIDE };
}

/**
 * Lo más grande que se acepta por la subida directa a Storage (08-10-2026): la
 * foto que el celular no pudo abrir para achicarla —una de 50 MP de la
 * pantalla del cliente, o un HEIC— sube entera y la reduce el servidor.
 */
export const PHOTO_DIRECT_LIMIT = 25 * 1024 * 1024;

/** El formato por la firma de los primeros bytes, sin fiarse de la extensión. */
export function imageKind(b: Uint8Array): "jpeg" | "png" | "webp" | "gif" | "heic" | "avif" | "otro" {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 4 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return "png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if (b.length >= 4 && ascii(b, 0, 4) === "GIF8") return "gif";
  // ISO BMFF: «ftyp» en el byte 4 y la marca detrás.
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
  }
  return "otro";
}
