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
