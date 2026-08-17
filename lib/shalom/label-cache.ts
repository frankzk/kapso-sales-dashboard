// El rótulo PDF de Shalom, guardado la primera vez que se pide.
//
// POR QUÉ. Pedirlo tarda ~45 s: su wrapper entra a pro.shalom.pe a buscar el
// documento. Y el timeout por defecto de esa llamada son exactamente 45 s, así
// que no es solo lentitud — es el filo del corte: un día que Shalom vaya un poco
// más lento, el almacén no recibe un rótulo tarde, recibe un error y se queda
// sin papel.
//
// EL DOCUMENTO ES INMUTABLE. Una vez emitida la guía, el rótulo de ese `ose_id`
// ya no cambia: es el papel que Shalom imprimió para ese envío. Volver a pedirlo
// en cada reimpresión —y cada vez que alguien abre el enlace— es pagar 45 s por
// un archivo que ya tuvimos.
//
// SE GUARDA EL SUYO, NO EL COMPUESTO. El compuesto se arma en el momento porque
// depende de datos nuestros que sí cambian —los productos del pedido, el nombre
// del destinatario—; el de Shalom es lo único congelado, y es lo único caro.
//
// Un fallo de caché nunca puede impedir imprimir: si el bucket no responde, se
// sirve lo que Shalom devolvió y ya está. Por eso todo aquí traga sus errores.

import type { SupabaseClient } from "@supabase/supabase-js";
import { readWithFreshSession, type StoreShalom } from "@/lib/shalom/session";

const BUCKET = "shalom-labels";

let bucketReady = false;

async function ensureBucket(admin: SupabaseClient): Promise<void> {
  if (bucketReady) return;
  // Privado: es el documento de un envío concreto, con nombre y dirección de una
  // persona. Se sirve por nuestra ruta, que comprueba RLS antes.
  await admin.storage.createBucket(BUCKET, { public: false }).catch(() => {});
  await admin.storage.updateBucket(BUCKET, { public: false }).catch(() => {});
  bucketReady = true;
}

/** La ruta es el `ose_id` y nada más: identifica al documento, no al pedido. */
export function labelPath(oseId: number): string {
  return `${oseId}.pdf`;
}

/** El PDF guardado, o `null` si no está. Nunca lanza. */
export async function readCachedLabel(
  admin: SupabaseClient,
  oseId: number,
): Promise<Uint8Array | null> {
  try {
    const { data, error } = await admin.storage.from(BUCKET).download(labelPath(oseId));
    if (error || !data) return null;
    const bytes = new Uint8Array(await data.arrayBuffer());
    // Un objeto vacío es basura de una subida a medias: se ignora y se vuelve a
    // pedir, en vez de servir un PDF de cero bytes que el visor no abre.
    return bytes.byteLength > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/** Guarda el PDF para la próxima vez. Nunca lanza: imprimir manda. */
export async function cacheLabel(
  admin: SupabaseClient,
  oseId: number,
  pdf: ArrayBuffer | Uint8Array,
): Promise<void> {
  try {
    await ensureBucket(admin);
    const body = pdf instanceof Uint8Array ? pdf : new Uint8Array(pdf);
    if (!body.byteLength) return;
    await admin.storage.from(BUCKET).upload(labelPath(oseId), body, {
      contentType: "application/pdf",
      // `upsert` porque dos personas pueden imprimir a la vez: el documento es
      // el mismo, así que la carrera no tiene perdedor.
      upsert: true,
    });
  } catch {
    /* la caché es una comodidad, no una garantía */
  }
}

/**
 * El rótulo de Shalom: de la caché si está, y si no del courier — guardándolo.
 *
 * Es el único sitio por el que se pide ese PDF, para que la caché no dependa de
 * que cada ruta se acuerde de usarla. Lanza lo que lance Shalom: quien llama ya
 * sabe traducir sus errores, y una caché vacía no debe disfrazar una caída.
 */
export async function shalomLabelPdf(
  admin: SupabaseClient,
  storeId: string,
  store: StoreShalom,
  oseId: number,
  client: { label: (oseId: number) => Promise<ArrayBuffer> } | null = null,
): Promise<Uint8Array> {
  const cached = await readCachedLabel(admin, oseId);
  if (cached) return cached;

  // Lectura: si el token murió se renueva y reintenta sola. Bajar el rótulo no
  // crea ni modifica nada, así que repetirlo es gratis.
  const fresh = client
    ? await client.label(oseId)
    : await readWithFreshSession(admin, storeId, store, (c) => c.label(oseId));
  const bytes = fresh instanceof Uint8Array ? fresh : new Uint8Array(fresh);
  await cacheLabel(admin, oseId, bytes);
  return bytes;
}

/**
 * Deja el rótulo listo antes de que nadie lo pida.
 *
 * Se llama justo después de crear la guía, sin esperar el resultado: los 45 s de
 * Shalom se pagan mientras la operadora sigue con lo suyo, y cuando el almacén
 * imprima ya estará. Si falla no se entera nadie — la impresión lo volverá a
 * pedir, que es exactamente lo que pasaba antes de existir esto.
 */
export async function warmShalomLabel(
  admin: SupabaseClient,
  storeId: string,
  store: StoreShalom,
  oseId: number | null,
  client: { label: (oseId: number) => Promise<ArrayBuffer> } | null = null,
): Promise<void> {
  if (!oseId) return;
  try {
    await shalomLabelPdf(admin, storeId, store, oseId, client);
  } catch {
    /* calentar es un adelanto, no un requisito */
  }
}
