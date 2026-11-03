// Fotos del catálogo de Shopify, copiadas a Kapta antes del cierre (MOM §37.6).
// Solo servidor. Cada foto se baja en su tamaño original desde el CDN de
// Shopify y se guarda tal cual en el bucket privado `shopify-history`. Es un
// respaldo: no es la foto que mandan las plantillas de WhatsApp (§39).
//
// Va por tandas de ~60 s; la pantalla repite hasta que no falte ninguna. Una
// foto que falla tres veces queda marcada y deja de intentarse.

import type { SupabaseClient } from "@supabase/supabase-js";

export const HISTORY_BUCKET = "shopify-history";
export const IMAGE_COPY_BUDGET_MS = 60_000;
export const IMAGE_MAX_ATTEMPTS = 3;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;
const CONCURRENCY = 4;
const PAGE = 40;

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/svg+xml": "svg",
};

/** La extensión del archivo: por su tipo; si no, por la URL; si no, jpg. */
export function imageExtension(url: string, contentType: string | null): string {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (EXT_BY_TYPE[type]) return EXT_BY_TYPE[type]!;
  const m = url.split("?")[0]!.match(/\.([a-z0-9]{2,5})$/i);
  const ext = m?.[1]?.toLowerCase();
  if (ext && Object.values(EXT_BY_TYPE).includes(ext === "jpeg" ? "jpg" : ext)) return ext === "jpeg" ? "jpg" : ext;
  return "jpg";
}

/** Dónde queda la copia: `<tienda>/productos/<producto>/<foto>.<ext>`. */
export function imageStoragePath(storeId: string, productId: string, imageId: string, ext: string): string {
  return `${storeId}/productos/${productId}/${imageId}.${ext}`;
}

let bucketReady = false;

async function ensureBucket(admin: SupabaseClient) {
  if (bucketReady) return;
  const { error } = await admin.storage.createBucket(HISTORY_BUCKET, { public: false });
  if (error && !error.message.toLowerCase().includes("already exists")) {
    throw new Error(`No se pudo preparar el almacén del historial: ${error.message}`);
  }
  bucketReady = true;
}

type PendingImage = { image_id: string; product_id: string; src_url: string; attempts: number };

async function countImages(admin: SupabaseClient, storeId: string, filter: "pendientes" | "fallidas" | "todas") {
  let q = admin.from("shopify_history_product_images").select("image_id", { count: "exact", head: true }).eq("store_id", storeId);
  if (filter === "pendientes") q = q.is("storage_path", null).lt("attempts", IMAGE_MAX_ATTEMPTS);
  if (filter === "fallidas") q = q.is("storage_path", null).gte("attempts", IMAGE_MAX_ATTEMPTS);
  const { count } = await q;
  return count ?? 0;
}

/** Copia las fotos que faltan de una tienda hasta agotar el tiempo. */
export async function copyPendingProductImages(
  admin: SupabaseClient,
  storeId: string,
  opts: { budgetMs?: number; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<{ copied: number; failed: number; remaining: number; total: number }> {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  const budget = opts.budgetMs ?? IMAGE_COPY_BUDGET_MS;
  const started = now();
  let copied = 0;
  await ensureBucket(admin);

  const copyOne = async (img: PendingImage) => {
    try {
      const res = await doFetch(img.src_url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get("content-type");
      const bytes = new Uint8Array(await res.arrayBuffer());
      const path = imageStoragePath(storeId, img.product_id, img.image_id, imageExtension(img.src_url, type));
      const up = await admin.storage
        .from(HISTORY_BUCKET)
        .upload(path, bytes, { contentType: type ?? "application/octet-stream", upsert: true });
      if (up.error) throw new Error(up.error.message);
      await admin
        .from("shopify_history_product_images")
        .update({ storage_path: path, copied_at: new Date().toISOString(), error: null })
        .eq("store_id", storeId)
        .eq("image_id", img.image_id);
      copied++;
    } catch (cause) {
      await admin
        .from("shopify_history_product_images")
        .update({ attempts: img.attempts + 1, error: String((cause as Error).message ?? cause).slice(0, 500) })
        .eq("store_id", storeId)
        .eq("image_id", img.image_id);
    }
  };

  while (now() - started < budget) {
    const { data, error } = await admin
      .from("shopify_history_product_images")
      .select("image_id,product_id,src_url,attempts")
      .eq("store_id", storeId)
      .is("storage_path", null)
      .lt("attempts", IMAGE_MAX_ATTEMPTS)
      .order("product_id")
      .order("position")
      .limit(PAGE);
    if (error) throw new Error(`No se pudieron leer las fotos pendientes: ${error.message}`);
    const rows = (data ?? []) as PendingImage[];
    if (!rows.length) break;
    for (let i = 0; i < rows.length && now() - started < budget; i += CONCURRENCY) {
      await Promise.all(rows.slice(i, i + CONCURRENCY).map(copyOne));
    }
  }

  const [remaining, failed, total] = await Promise.all([
    countImages(admin, storeId, "pendientes"),
    countImages(admin, storeId, "fallidas"),
    countImages(admin, storeId, "todas"),
  ]);
  return { copied, failed, remaining, total };
}
