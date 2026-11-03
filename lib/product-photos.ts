// Las fotos de producto de las plantillas de WhatsApp, guardadas en Kapta para
// cuando Shopify ya no las sirva (MOM §39, 23-10-2026).
//
// POR QUÉ. La cabecera de imagen de las plantillas (prueba de carritos 0233,
// recordatorio de recojo 0242, recordatorio de reposición §34) apunta a
// /api/wa-image, que bajaba la foto del CDN de Shopify EN CADA envío. Shopify
// cierra Kenku Perú y Aurela el 28-10-2026 00:00 UTC; cuando su CDN deje de
// servir esos archivos, la ruta daría 502 y Meta rechazaría la plantilla,
// en vez de caer a la imagen de respaldo de la tienda. El cron
// /api/cron/product-photos (lib/product-photos-copy.ts) copia cada foto del
// espejo `shopify_product_images` (0164) aquí mientras el CDN responde.
//
// DÓNDE. Bucket PRIVADO `product-photos`, como todos los del repositorio salvo
// el de los adjuntos de WhatsApp. Nadie lo lee directo: la foto sale por
// /api/wa-image, que sigue siendo la única puerta y sigue sin ser un proxy
// abierto.
//
// LA RUTA LLEVA LA HUELLA DE LA URL: `<storeId>/<productId>-<huella>.jpg`, con
// la huella = 16 caracteres del sha256 de `image_url`. Así:
//   · si la foto cambia en Shopify, cambia la URL (Shopify le pone `?v=`), cambia
//     la ruta y la copia nueva se hace sola; la vieja nunca se sirve por la
//     nueva, porque /api/wa-image pide la ruta de la URL ACTUAL;
//   · lo que hay en una ruta es siempre la copia de esa URL: no hay un momento
//     en que el archivo sea uno y sus metadatos digan otro, y como nada se
//     sobrescribe (subida sin `upsert`), una copia buena no se puede pisar;
//   · saber qué está copiado es UN listado de la carpeta de la tienda, sin leer
//     metadatos objeto por objeto.
// El costo: una versión vieja queda en el bucket (unos KB, y pasa poco). Nada
// aquí borra: después del cierre, una copia es irrecuperable.
//
// QUIÉN LA USA DESPUÉS DEL CIERRE. Se decide POR TIENDA (`shopifyGoneForStore`):
// mientras Shopify le sirve las fotos a una tienda nada cambia, los envíos
// eligen foto como siempre y /api/wa-image, si la copia todavía no está, la
// baja en vivo. Para una tienda que Shopify ya no sirve —sin token, a cualquier
// hora; o, desde el cierre (`SHOPIFY_SHUTDOWN_AT`), la que pasa a WooCommerce—
// una foto sin copia guardada no se usa como cabecera: el producto cuenta como
// «sin foto» (`productPhotosThatLoad`). Las tiendas cliente siguen en Shopify
// (MOM §35.10) y no cambian.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAfterShopifyShutdown } from "@/lib/invoicing/shopify-cutoff";

export const PRODUCT_PHOTO_BUCKET = "product-photos";

/** Lo único que /api/wa-image acepta servir y el cron acepta copiar. */
const SHOPIFY_CDN = /^https:\/\/cdn\.shopify\.com\//;

/** El id de producto que la ruta entiende: el numérico de Shopify REST. */
const PRODUCT_ID = /^\d{1,20}$/;

/** Cuántos objetos pide cada página del listado de una carpeta. */
const LIST_PAGE = 1000;
/**
 * Tope de páginas: una tienda tiene unos cientos de fotos, no decenas de miles.
 * Alcanza aunque Storage devolviera 100 por página en vez de 1000.
 */
const LIST_MAX_PAGES = 50;

/**
 * Tope de cada página del listado. Lo piden los envíos (desde el cierre) y el
 * cron: un Storage colgado no puede trabar una pasada entera.
 */
export const PRODUCT_PHOTO_LIST_TIMEOUT_MS = 5_000;
/**
 * Tope de la lectura de una copia en /api/wa-image. Corto, porque después viene
 * el CDN: antes de esta copia la ruta no tocaba Storage, y un Storage lento no
 * puede hacer que Meta se canse de esperar una foto que el CDN sí da.
 */
export const PRODUCT_PHOTO_DOWNLOAD_TIMEOUT_MS = 3_000;

export function isShopifyCdnUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && SHOPIFY_CDN.test(url);
}

/** 16 caracteres del sha256 de la URL de origen. */
export function photoSourceTag(imageUrl: string): string {
  return createHash("sha256").update(imageUrl, "utf8").digest("hex").slice(0, 16);
}

/** El nombre del archivo dentro de la carpeta de la tienda. */
export function productPhotoName(productId: string, imageUrl: string): string {
  return `${productId}-${photoSourceTag(imageUrl)}.jpg`;
}

/** `<storeId>/<productId>-<huella>.jpg`. */
export function productPhotoPath(storeId: string, productId: string, imageUrl: string): string {
  return `${storeId}/${productPhotoName(productId, imageUrl)}`;
}

/** ¿Esta fila se puede copiar y servir? Foto del CDN e id numérico. */
export function isCopyableProductPhoto(productId: string, imageUrl: string | null | undefined): imageUrl is string {
  return PRODUCT_ID.test(productId) && isShopifyCdnUrl(imageUrl);
}

/**
 * Los nombres de los archivos guardados en la carpeta de una tienda, o `null`
 * si no se pudo leer entera. Nunca lanza.
 *
 * Lee hasta una página VACÍA, no hasta la primera corta: si Storage devolviera
 * menos de lo pedido por página, cortar ahí daría por faltantes copias que
 * están (y desde el cierre, esas fotos contarían como «sin foto»).
 */
export async function storedPhotoNames(admin: SupabaseClient, storeId: string): Promise<Set<string> | null> {
  try {
    const names = new Set<string>();
    let offset = 0;
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const { data, error } = await admin.storage
        .from(PRODUCT_PHOTO_BUCKET)
        .list(
          storeId,
          { limit: LIST_PAGE, offset, sortBy: { column: "name", order: "asc" } },
          { signal: AbortSignal.timeout(PRODUCT_PHOTO_LIST_TIMEOUT_MS) },
        );
      if (error) return null;
      const rows = (data ?? []) as { name?: unknown; id?: unknown }[];
      if (!rows.length) return names;
      // `id: null` es una subcarpeta, no un archivo.
      for (const r of rows) if (typeof r.name === "string" && r.id !== null) names.add(r.name);
      offset += rows.length;
    }
    // Una carpeta así no es de esta tabla: mejor «no se pudo leer» (el cron en
    // rojo) que una lista a medias que nadie ve.
    return null;
  } catch {
    return null;
  }
}

/** El JPG guardado, o `null` si no está, no se pudo leer o tardó. Nunca lanza. */
export async function readStoredPhoto(admin: SupabaseClient, path: string): Promise<Uint8Array | null> {
  try {
    const { data, error } = await admin.storage
      .from(PRODUCT_PHOTO_BUCKET)
      .download(path, {}, { signal: AbortSignal.timeout(PRODUCT_PHOTO_DOWNLOAD_TIMEOUT_MS) });
    if (error || !data) return null;
    const bytes = new Uint8Array(await data.arrayBuffer());
    // Un objeto vacío es una subida a medias: mejor la foto en vivo.
    return bytes.byteLength > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/** ¿Hay algo escrito en esta columna de texto? */
function filled(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * ¿Shopify ya no le sirve las fotos a esta tienda, a esta hora (milisegundos,
 * como `Date.now()`)? Se decide por tienda, no por la fecha sola:
 *
 *  · sin token de Shopify, sí, a cualquier hora. Es la llave de la operación
 *    (MOM §35.10): si Shopify cerrara antes del 28-10, se vacía el token de la
 *    tienda, y desde ese momento solo valen las copias;
 *  · desde el cierre (`isAfterShopifyShutdown`), la tienda que pasa a
 *    WooCommerce (§38: `platform = 'woocommerce'`, o su sitio ya guardado en
 *    `woo_site_url`). Son Kenku Perú y Aurela;
 *  · las demás, no: las tiendas cliente siguen en Shopify (§35.10) y su CDN
 *    sigue sirviendo, así que todo queda como siempre.
 *
 * Si la fila no se puede leer: antes del cierre, no (lo de siempre); desde el
 * cierre, sí (solo copias, que el cron hace para todas las tiendas). Antes de
 * la 0274 no hay columnas de WooCommerce: cuenta solo el token. Nunca lanza.
 */
export async function shopifyGoneForStore(admin: SupabaseClient, storeId: string, nowMs: number): Promise<boolean> {
  const afterShutdown = isAfterShopifyShutdown(nowMs);
  let row: Record<string, unknown> | null = null;
  try {
    const read = (columns: string) => admin.from("stores").select(columns).eq("id", storeId).maybeSingle();
    let res = await read("shopify_token_enc,platform,woo_site_url");
    // Antes de la 0274 esas dos columnas no existen.
    if (res.error) res = await read("shopify_token_enc");
    if (!res.error) row = (res.data as Record<string, unknown> | null) ?? null;
  } catch {
    row = null;
  }
  if (!row) return afterShutdown;
  if (!filled(row.shopify_token_enc)) return true;
  if (!afterShutdown) return false;
  return row.platform === "woocommerce" || filled(row.woo_site_url);
}

/**
 * De las filas del espejo con foto, las que la cabecera puede usar a esta
 * hora (milisegundos, como `Date.now()`), o `null` si no se puede saber.
 *
 * Mientras Shopify sirve las fotos de la tienda (`shopifyGoneForStore`),
 * TODAS, sin mirar Storage: /api/wa-image baja en vivo lo que todavía no está
 * copiado, como siempre. Cuando ya no, solo las que tienen su copia guardada
 * para la URL actual: una sin copia daría a Meta un 502 en la cabecera y el
 * envío fallaría, así que el producto cuenta como «sin foto» y cada envío hace
 * lo que ya hacía en ese caso (la imagen de respaldo, fuera de la prueba, o no
 * sale).
 *
 * `null` es «Storage no contestó»: ni «con foto» ni «sin foto». Quien llama
 * decide; el recordatorio de recojo lo reintenta en vez de darlo por omitido,
 * porque las copias pueden estar todas.
 */
export async function productPhotosThatLoad<T extends { product_id: string | number; image_url?: string | null }>(
  admin: SupabaseClient,
  storeId: string,
  rows: T[],
  nowMs: number,
): Promise<T[] | null> {
  if (!rows.length) return rows;
  if (!(await shopifyGoneForStore(admin, storeId, nowMs))) return rows;
  const names = await storedPhotoNames(admin, storeId);
  if (!names) return null;
  return rows.filter((r) => {
    const productId = String(r.product_id);
    return isCopyableProductPhoto(productId, r.image_url) && names.has(productPhotoName(productId, r.image_url));
  });
}
