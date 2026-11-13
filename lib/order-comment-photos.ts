// Las fotos de un comentario del pedido (owner, 10-11-2026: «quiero subir
// constancias o sustentos de los comentarios. Por ejemplo: intenté contactar y
// le dejé WhatsApp, subo captura»).
//
// - Se pegan con Ctrl+V dentro de la tarjeta «Comentario» —como el comprobante
//   del Yape en «Registrar un pago»—, se arrastran o se eligen. Hasta
//   `ORDER_COMMENT_MAX_PHOTOS` por comentario.
// - El navegador las sube DIRECTO a Storage con una URL firmada que da el
//   servidor (sin el corte de 4,5 MB de Vercel), al bucket privado
//   `ORDER_COMMENT_PHOTO_BUCKET`, bajo `<tienda>/<pedido>/comment-…`.
// - El comentario guarda las rutas en `order_events.payload.photos`. El hecho
//   es append-only (0045): una foto no se quita ni se cambia, como el texto.
// - Se ven en la Actividad del pedido por `/api/pedidos/<id>/comentario-foto`,
//   que solo entrega rutas de ESE pedido a quien puede leerlo (RLS).
//
// Sin migración: el bucket se crea solo en la primera subida.

/** Bucket privado de las fotos de los comentarios. */
export const ORDER_COMMENT_PHOTO_BUCKET = "order-comment-photos";

/** Fotos por comentario. */
export const ORDER_COMMENT_MAX_PHOTOS = 4;

/** Lo más pesado que se acepta (una foto del celular sin achicar). */
export const ORDER_COMMENT_PHOTO_MAX_BYTES = 15 * 1024 * 1024;

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** La extensión para un tipo de imagen; null si no es una imagen aceptada. */
export function orderCommentPhotoExt(contentType: string): string | null {
  return EXT_BY_TYPE[contentType.trim().toLowerCase()] ?? null;
}

/** La carpeta de las fotos de un pedido. */
export function orderCommentPhotoFolder(storeId: string, orderId: string): string {
  return `${storeId}/${orderId}`;
}

/** ¿Es esta ruta una foto de comentario de ESE pedido? */
export function isOrderCommentPhotoPath(path: string, storeId: string, orderId: string): boolean {
  const prefix = `${orderCommentPhotoFolder(storeId, orderId)}/comment-`;
  return (
    typeof path === "string" &&
    path.startsWith(prefix) &&
    !path.includes("..") &&
    /^[A-Za-z0-9._-]+$/.test(path.slice(prefix.length))
  );
}

/**
 * Las rutas que trae el navegador, limpias: sin repetir, todas del pedido y
 * no más del tope. Devuelve el error tal cual se le dice a la persona.
 */
export function validateOrderCommentPhotos(
  paths: readonly string[] | null | undefined,
  storeId: string,
  orderId: string,
): { paths: string[] } | { error: string } {
  const unique = [...new Set((paths ?? []).map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean))];
  if (unique.length > ORDER_COMMENT_MAX_PHOTOS) {
    return { error: `Máximo ${ORDER_COMMENT_MAX_PHOTOS} fotos por comentario.` };
  }
  if (unique.some((p) => !isOrderCommentPhotoPath(p, storeId, orderId))) {
    return { error: "Una de las fotos no pertenece a este pedido." };
  }
  return { paths: unique };
}

/** Las fotos guardadas en un hecho (`payload.photos`); vacío si no hay. */
export function orderCommentPhotosFromPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const photos = (payload as { photos?: unknown }).photos;
  if (!Array.isArray(photos)) return [];
  return photos.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, ORDER_COMMENT_MAX_PHOTOS);
}

/** La URL con la que la Actividad pinta una foto. */
export function orderCommentPhotoUrl(orderId: string, path: string): string {
  return `/api/pedidos/${encodeURIComponent(orderId)}/comentario-foto?path=${encodeURIComponent(path)}`;
}

/**
 * Las imágenes de un pegado, un arrastre o el selector. Solo las que el
 * navegador sabe pintar (un HEIC no se ve en la Actividad).
 */
export function imageFilesFrom(list: FileList | readonly File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => orderCommentPhotoExt(f.type) !== null);
}

/**
 * Tipos sugeridos para el comentario (texto libre: se puede escribir otro).
 * Sirven para leer la gestión del equipo de un vistazo en la Actividad, como
 * la de «Pendiente de pago de diferencia» (owner, 10-11-2026).
 */
export const ORDER_COMMENT_TYPE_SUGGESTIONS = [
  "Llamada",
  "WhatsApp",
  "Pago de diferencia",
  "Dirección",
  "Reprogramación",
  "Agencia",
] as const;
