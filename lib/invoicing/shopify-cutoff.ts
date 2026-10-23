// El cierre de Shopify para Kenku Perú y Aurela (MOM §35.10, owner 23-10-2026).
//
// Aparte de lib/invoicing/snapshots.ts para que la lectura de la boleta
// (lib/invoicing/shopify-order.ts) lo use sin importar el barrido, que ya
// importa la lectura.

/** El cierre: 28-10-2026 00:00 UTC (27-10 a las 19:00 de Lima, UTC−5). */
export const SHOPIFY_SHUTDOWN_AT = "2026-10-28T00:00:00.000Z";

/**
 * Desde cuándo un 401, 402, 403, 404 o 423 de Shopify hace que la boleta salga
 * de la foto. Es el cierre mismo, sin margen: Shopify cierra «el 28-10 (UTC)», y
 * antes de eso la tienda está viva, así que un 401 (token revocado al
 * reinstalar), un 403 o un 423 son un problema de Shopify que se arregla, no el
 * cierre, y la boleta se queda en `lectura_fallida` como siempre. Si Shopify
 * cerrara antes, la llave de la operación es vaciar el token de la tienda: sin
 * token, la foto se usa a cualquier hora.
 */
export const SNAPSHOT_FALLBACK_FROM = SHOPIFY_SHUTDOWN_AT;

/** ¿Ya pasó el cierre, a esta hora (milisegundos, como `Date.now()`)? */
export function isAfterShopifyShutdown(nowMs: number): boolean {
  return Number.isFinite(nowMs) && nowMs >= Date.parse(SNAPSHOT_FALLBACK_FROM);
}
