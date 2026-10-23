// La copia de las fotos de producto a Storage (MOM §39, 23-10-2026). La ruta de
// cada copia, quién la lee y por qué: lib/product-photos.ts.
//
// Lo corre /api/cron/product-photos cada hora, en el minuto 48. Cada pasada:
//
//   1. lee del espejo (`shopify_product_images`) las filas con foto del CDN de
//      Shopify — unas 330-390 entre todas las tiendas;
//   2. lista la carpeta de cada tienda en el bucket: lo que ya tiene su copia
//      para la URL actual no se toca (sin bajar nada, sin subir nada);
//   3. lo que falta lo baja del CDN, lo convierte EXACTAMENTE como /api/wa-image
//      (`toWhatsappJpeg`) y lo sube sin `upsert`: una copia que ya está nunca
//      se pisa.
//
// Idempotente: una segunda pasada sobre lo ya copiado es la lectura del espejo,
// asegurar el bucket (crearlo, que falla si ya está, y forzarlo privado) y el
// listado de cada tienda (dos páginas: la de los nombres y la vacía que dice
// que no hay más), con cero descargas y cero subidas. Acotada: no empieza una
// copia pasados `PRODUCT_PHOTO_COPY_BUDGET_MS`, cada llamada a Storage tiene su
// tope, y lo que no cupo sigue en la próxima hora. Nunca borra nada.

import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PRODUCT_PHOTO_BUCKET,
  isCopyableProductPhoto,
  productPhotoName,
  productPhotoPath,
  storedPhotoNames,
} from "@/lib/product-photos";

/** Una foto de catálogo más grande que esto no es una foto de catálogo. */
export const PRODUCT_PHOTO_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
/** El tope de cada descarga del CDN, el mismo que tenía /api/wa-image. */
export const PRODUCT_PHOTO_FETCH_TIMEOUT_MS = 10_000;
/**
 * El tope de cada subida. `upload` de storage-js no acepta una señal para
 * cortarla, así que se deja de esperar: una subida colgada cuenta como
 * fallida (`subida`) y no retiene la pasada hasta que Vercel la mate sin log.
 * Si terminara después, la copia queda y la próxima pasada la ve.
 */
export const PRODUCT_PHOTO_UPLOAD_TIMEOUT_MS = 10_000;
/** El tope de crear el bucket o forzarlo privado. */
export const PRODUCT_PHOTO_BUCKET_TIMEOUT_MS = 5_000;
/** No se empieza una copia nueva pasado esto. */
export const PRODUCT_PHOTO_COPY_BUDGET_MS = 90_000;
/** El `maxDuration` de la ruta: el presupuesto, más una descarga, más la subida. */
export const PRODUCT_PHOTO_COPY_MAX_DURATION_S = 120;
/** Cuántas copias a la vez. Son fotos de unos cientos de KB: el CDN ni lo nota. */
export const PRODUCT_PHOTO_COPY_CONCURRENCY = 4;

const READ_PAGE = 1000;

/**
 * La foto que se manda a Meta: JPG de 800 px de ancho como mucho (basta para la
 * cabecera), sin agrandar, girada según su EXIF y con fondo blanco para los PNG
 * transparentes, que en JPG saldrían negros. Meta solo acepta JPG o PNG y el
 * 45 % de las fotos de catálogo de Shopify son WebP.
 *
 * La usan /api/wa-image y la copia: lo guardado es byte a byte lo que la ruta
 * habría servido en vivo.
 */
export async function toWhatsappJpeg(bytes: Uint8Array): Promise<Buffer> {
  return sharp(bytes, { animated: false })
    .rotate()
    .resize({ width: 800, withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}

/** Por qué no se pudo bajar o convertir una foto. */
export type PhotoSourceFailure = "http" | "vacia" | "grande" | "red" | "conversion";

/**
 * Deja de esperar una promesa pasado `ms`: rechaza con un error de tiempo. La
 * promesa sigue su curso; solo que nadie la espera.
 */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tiempo agotado (${ms} ms)`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Baja la foto del CDN y la convierte. Nunca lanza: devuelve el motivo.
 * Quien llama ya comprobó que la URL es del CDN de Shopify.
 */
export async function fetchProductPhotoJpeg(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; jpg: Buffer } | { ok: false; reason: PhotoSourceFailure; status?: number; error?: unknown }> {
  let bytes: Buffer;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(PRODUCT_PHOTO_FETCH_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, reason: "http", status: res.status };
    // Si el CDN ya dice que es demasiado grande, ni se baja: la copia corre
    // varias a la vez y no tiene por qué cargar 8 MB por nada.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > PRODUCT_PHOTO_MAX_SOURCE_BYTES) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: "grande" };
    }
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    return { ok: false, reason: "red", error };
  }
  if (!bytes.length) return { ok: false, reason: "vacia" };
  if (bytes.length > PRODUCT_PHOTO_MAX_SOURCE_BYTES) return { ok: false, reason: "grande" };
  try {
    return { ok: true, jpg: await toWhatsappJpeg(bytes) };
  } catch (error) {
    return { ok: false, reason: "conversion", error };
  }
}

/** Por qué una copia no quedó: lo de la fuente, o la subida. */
export type PhotoCopyFailure = PhotoSourceFailure | "subida";

export interface ProductPhotoStoreReport {
  storeId: string;
  /** Filas del espejo con foto del CDN de Shopify. */
  filas: number;
  /** Las que ya tenían su copia antes de esta pasada. */
  guardadas: number;
  /** Las copiadas en esta pasada. */
  copiadas: number;
  /** Las que se intentaron y no quedaron. */
  fallidas: number;
  /** Las fallidas, por motivo (`http_404`, `red`, `subida`…). */
  motivos: Record<string, number>;
  /** Las que siguen sin copia al terminar: fallidas más las que no cupieron. */
  pendientes: number;
  /** No se pudo leer la carpeta de la tienda: no se copió nada de ella. */
  error?: "bucket";
}

export interface ProductPhotoCopyReport {
  ok: boolean;
  dry: boolean;
  ms: number;
  filas: number;
  guardadas: number;
  copiadas: number;
  fallidas: number;
  pendientes: number;
  /** Quedaron copias sin intentar porque se acabó el presupuesto. */
  agotado: boolean;
  /** Solo en `dry`: el bucket todavía no existe (no se ha copiado nada). */
  sinBucket?: true;
  stores: ProductPhotoStoreReport[];
  /** Motivos cortos, sin URLs ni mensajes de la base. */
  errors: string[];
}

interface PhotoRow {
  store_id: string;
  product_id: string;
  image_url: string;
}

/** Las filas copiables del espejo, de todas las tiendas o de una. */
async function readMirror(admin: SupabaseClient, storeId?: string): Promise<PhotoRow[] | null> {
  const out: PhotoRow[] = [];
  for (let from = 0; ; from += READ_PAGE) {
    let q = admin
      .from("shopify_product_images")
      .select("store_id,product_id,image_url")
      .not("image_url", "is", null);
    if (storeId) q = q.eq("store_id", storeId);
    const { data, error } = await q
      .order("store_id", { ascending: true })
      .order("product_id", { ascending: true })
      .range(from, from + READ_PAGE - 1);
    if (error) return null;
    const rows = (data ?? []) as { store_id: string; product_id: unknown; image_url: string | null }[];
    for (const r of rows) {
      const productId = String(r.product_id ?? "");
      if (isCopyableProductPhoto(productId, r.image_url)) {
        out.push({ store_id: r.store_id, product_id: productId, image_url: r.image_url });
      }
    }
    if (rows.length < READ_PAGE) return out;
  }
}

/** Privado, como todos los buckets del repositorio salvo `whatsapp-media`. */
async function ensureBucket(admin: SupabaseClient): Promise<void> {
  // Crearlo da error si ya existe ⇒ bien. Y se fuerza privado por si alguien
  // lo hubiera creado público a mano: la única puerta es /api/wa-image. Si
  // Storage no contesta, el listado de cada tienda lo dirá.
  await withTimeout(admin.storage.createBucket(PRODUCT_PHOTO_BUCKET, { public: false }), PRODUCT_PHOTO_BUCKET_TIMEOUT_MS).catch(() => {});
  await withTimeout(admin.storage.updateBucket(PRODUCT_PHOTO_BUCKET, { public: false }), PRODUCT_PHOTO_BUCKET_TIMEOUT_MS).catch(() => {});
}

async function bucketExists(admin: SupabaseClient): Promise<boolean> {
  try {
    const { data, error } = await withTimeout(admin.storage.getBucket(PRODUCT_PHOTO_BUCKET), PRODUCT_PHOTO_BUCKET_TIMEOUT_MS);
    return !error && !!data;
  } catch {
    return false;
  }
}

/** ¿La subida falló porque el objeto ya estaba? Otra pasada lo copió antes. */
function alreadyExists(error: unknown): boolean {
  const e = error as { statusCode?: unknown; status?: unknown; message?: unknown } | null;
  const code = String(e?.statusCode ?? e?.status ?? "");
  return code === "409" || /already exists|duplicate/i.test(String(e?.message ?? ""));
}

/**
 * Una pasada de copia. Nunca lanza: lo que falla queda en el reporte.
 *
 * `dry` solo cuenta (filas, guardadas, pendientes): no crea el bucket, no baja
 * ni sube nada.
 */
export async function copyProductPhotos(
  admin: SupabaseClient,
  opts: {
    dry?: boolean;
    storeId?: string;
    budgetMs?: number;
    concurrency?: number;
    fetchImpl?: typeof fetch;
    /** Para las pruebas: el tope de cada subida (`PRODUCT_PHOTO_UPLOAD_TIMEOUT_MS`). */
    uploadTimeoutMs?: number;
    /** Reloj inyectable para las pruebas. */
    now?: () => number;
  } = {},
): Promise<ProductPhotoCopyReport> {
  const now = opts.now ?? Date.now;
  const started = now();
  const dry = opts.dry === true;
  const budgetMs = opts.budgetMs ?? PRODUCT_PHOTO_COPY_BUDGET_MS;
  const report: ProductPhotoCopyReport = {
    ok: true,
    dry,
    ms: 0,
    filas: 0,
    guardadas: 0,
    copiadas: 0,
    fallidas: 0,
    pendientes: 0,
    agotado: false,
    stores: [],
    errors: [],
  };
  const finish = (): ProductPhotoCopyReport => {
    for (const s of report.stores) {
      report.filas += s.filas;
      report.guardadas += s.guardadas;
      report.copiadas += s.copiadas;
      report.fallidas += s.fallidas;
      report.pendientes += s.pendientes;
    }
    report.ok = report.errors.length === 0;
    report.ms = now() - started;
    return report;
  };

  let rows: PhotoRow[] | null;
  try {
    rows = await readMirror(admin, opts.storeId);
  } catch {
    rows = null;
  }
  if (!rows) {
    report.errors.push("No se pudo leer el espejo de fotos.");
    return finish();
  }

  const byStore = new Map<string, PhotoRow[]>();
  for (const r of rows) {
    const list = byStore.get(r.store_id) ?? [];
    list.push(r);
    byStore.set(r.store_id, list);
  }

  let haveBucket = true;
  if (dry) {
    haveBucket = await bucketExists(admin);
    if (!haveBucket) report.sinBucket = true;
  } else if (byStore.size) {
    await ensureBucket(admin);
  }

  // Lo que falta, de todas las tiendas, en una sola cola.
  const queue: { row: PhotoRow; store: ProductPhotoStoreReport }[] = [];
  for (const [storeId, list] of byStore) {
    const store: ProductPhotoStoreReport = {
      storeId,
      filas: list.length,
      guardadas: 0,
      copiadas: 0,
      fallidas: 0,
      motivos: {},
      pendientes: 0,
    };
    report.stores.push(store);
    const names = haveBucket ? await storedPhotoNames(admin, storeId) : new Set<string>();
    if (!names) {
      store.error = "bucket";
      store.pendientes = list.length;
      report.errors.push(`No se pudo leer la carpeta de fotos de la tienda ${storeId}.`);
      continue;
    }
    for (const row of list) {
      if (names.has(productPhotoName(row.product_id, row.image_url))) store.guardadas += 1;
      else if (dry) store.pendientes += 1;
      else queue.push({ row, store });
    }
  }
  if (dry || !queue.length) return finish();

  const fetchImpl = opts.fetchImpl ?? fetch;
  const uploadTimeoutMs = opts.uploadTimeoutMs ?? PRODUCT_PHOTO_UPLOAD_TIMEOUT_MS;
  let uploadFailed = false;
  const fail = (store: ProductPhotoStoreReport, motivo: string) => {
    store.fallidas += 1;
    store.pendientes += 1;
    store.motivos[motivo] = (store.motivos[motivo] ?? 0) + 1;
  };
  const copyOne = async ({ row, store }: (typeof queue)[number]): Promise<void> => {
    const got = await fetchProductPhotoJpeg(row.image_url, fetchImpl);
    if (!got.ok) {
      fail(store, got.reason === "http" ? `http_${got.status ?? "?"}` : got.reason);
      return;
    }
    try {
      const { error } = await withTimeout(
        admin.storage
          .from(PRODUCT_PHOTO_BUCKET)
          .upload(productPhotoPath(row.store_id, row.product_id, row.image_url), got.jpg, {
            contentType: "image/jpeg",
            // Sin `upsert`: lo que está en una ruta es la copia de esa URL, y una
            // copia buena no se pisa nunca (después del cierre no habría con qué
            // reponerla).
            upsert: false,
            cacheControl: "604800",
          }),
        uploadTimeoutMs,
      );
      if (!error) store.copiadas += 1;
      else if (alreadyExists(error)) store.guardadas += 1;
      else {
        uploadFailed = true;
        fail(store, "subida");
      }
    } catch {
      uploadFailed = true;
      fail(store, "subida");
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      if (now() - started >= budgetMs) return;
      await copyOne(queue[next++]!);
    }
  };
  const workers = Math.max(1, Math.min(opts.concurrency ?? PRODUCT_PHOTO_COPY_CONCURRENCY, queue.length));
  await Promise.all(Array.from({ length: workers }, worker));

  // Lo que no cupo queda pendiente para la próxima hora.
  for (let i = next; i < queue.length; i++) queue[i]!.store.pendientes += 1;
  report.agotado = next < queue.length;
  // Una foto que el CDN no da (borrada, o el cierre) no pone el cron en rojo:
  // se cuenta y se reintenta. Una subida que Storage rechaza, sí.
  if (uploadFailed) report.errors.push("Storage rechazó alguna subida.");
  return finish();
}
