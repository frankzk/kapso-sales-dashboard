"use server";

// Subir el historial de Shopify (MOM §37). El archivo lo lee el navegador
// (lib/shopify-history.ts) y aquí llegan los pedidos o clientes ya armados, por
// tandas; el original va directo a Storage con una URL firmada, comprimido.
// Nada de esto toca `orders` ni el Master: es un archivo de consulta.

import { revalidatePath } from "next/cache";
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { getStoreCreds } from "@/lib/ingest";
import { shopifyGraphQL } from "@/lib/shopify";
import { cleanDeep, clip, uniqueOrderNames, type HistoryCustomer, type HistoryFileKind, type HistoryLineItem, type HistoryOrder } from "@/lib/shopify-history";
import { BULK_KINDS, hasFullOrderAccess, mergeLineItems, type BulkKind } from "@/lib/shopify-history-bulk";
import { copyPendingProductImages } from "@/lib/shopify-history-images";
import {
  IMPORT_COLUMNS,
  advanceHistoryImport as advanceImport,
  startHistoryImport as startImport,
  type HistoryImportRow,
  type RowWriter,
} from "@/lib/shopify-history-import";

const BUCKET = "shopify-history";
const PATH = "/dashboard/stores/historial";
const KINDS: readonly HistoryFileKind[] = ["pedidos", "clientes", "productos", "otro"];

let bucketReady = false;

async function guard(): Promise<{ userId: string; storeIds: Set<string> } | { error: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: "Inicia sesión." };
  if (!(await getMasterPermissions()).can("data.export")) {
    return { error: "Tu rol no permite cargar el historial (hace falta «Descargar la base de pedidos»)." };
  }
  const stores = await getAccessibleStores();
  return { userId: user.id, storeIds: new Set(stores.map((s) => s.id)) };
}

async function fileOf(fileId: string, storeIds: Set<string>) {
  const admin = createAdminSupabase();
  const { data } = await admin.from("shopify_history_files").select("id,store_id,kind,status").eq("id", fileId).maybeSingle();
  const file = data as { id: string; store_id: string; kind: HistoryFileKind; status: string } | null;
  if (!file || !storeIds.has(file.store_id)) return null;
  return { admin, file };
}

/** Registra el archivo y devuelve dónde subir el original. */
export async function prepareHistoryUpload(input: {
  storeId: string;
  filename: string;
  sizeBytes: number;
  kind: HistoryFileKind;
}): Promise<{ fileId: string; path: string; token: string } | { error: string }> {
  const g = await guard();
  if ("error" in g) return g;
  if (!g.storeIds.has(input.storeId)) return { error: "Tienda inválida o sin acceso." };
  const kind = KINDS.includes(input.kind) ? input.kind : "otro";
  const admin = createAdminSupabase();
  if (!bucketReady) {
    const { error } = await admin.storage.createBucket(BUCKET, { public: false });
    if (error && !error.message.toLowerCase().includes("already exists")) {
      return { error: `No se pudo preparar el almacén del historial: ${error.message}` };
    }
    bucketReady = true;
  }
  const filename = String(input.filename ?? "archivo.csv").slice(0, 200);
  const { data, error } = await admin
    .from("shopify_history_files")
    .insert({
      store_id: input.storeId,
      kind,
      filename,
      size_bytes: Number.isFinite(input.sizeBytes) ? Math.round(input.sizeBytes) : null,
      status: "subiendo",
      uploaded_by: g.userId,
    })
    .select("id")
    .single();
  if (error || !data) return { error: `No se pudo registrar el archivo: ${error?.message ?? "sin respuesta"}` };
  const fileId = (data as { id: string }).id;
  const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "archivo.csv";
  const path = `${input.storeId}/${fileId}/${safe}.gz`;
  const signed = await admin.storage.from(BUCKET).createSignedUploadUrl(path);
  if (signed.error || !signed.data) return { error: `No se pudo preparar la subida: ${signed.error?.message ?? "sin respuesta"}` };
  await admin.from("shopify_history_files").update({ storage_path: path }).eq("id", fileId);
  return { fileId, path: signed.data.path, token: signed.data.token };
}

const str = (v: unknown, max = 2000): string | null => {
  if (typeof v !== "string") return null;
  const t = clip(v.trim(), max).trim();
  return t ? t : null;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const iso = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
const rawOf = (v: unknown): Record<string, string> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[clip(k, 120)] = clip(val, 4000);
  }
  return out;
};

/** Un pedido del historial, saneado, como fila de `shopify_history_orders`. */
function orderRow(storeId: string, o: HistoryOrder, link: { file_id: string } | { import_id: string }) {
  return {
    store_id: storeId,
    order_name: str(o?.order_name, 60),
    shopify_order_id: str(o.shopify_order_id, 40),
    created_at: iso(o.created_at),
    paid_at: iso(o.paid_at),
    fulfilled_at: iso(o.fulfilled_at),
    cancelled_at: iso(o.cancelled_at),
    financial_status: str(o.financial_status, 60),
    fulfillment_status: str(o.fulfillment_status, 60),
    currency: str(o.currency, 10),
    subtotal: num(o.subtotal),
    shipping: num(o.shipping),
    taxes: num(o.taxes),
    total: num(o.total),
    discount_code: str(o.discount_code, 200),
    discount_amount: num(o.discount_amount),
    refunded_amount: num(o.refunded_amount),
    payment_method: str(o.payment_method, 200),
    email: str(o.email, 320),
    phone: str(o.phone, 40),
    phone_norm: str(o.phone_norm, 20),
    customer_name: str(o.customer_name, 200),
    shipping_name: str(o.shipping_name, 200),
    shipping_address1: str(o.shipping_address1, 500),
    shipping_address2: str(o.shipping_address2, 500),
    shipping_city: str(o.shipping_city, 200),
    shipping_province: str(o.shipping_province, 200),
    shipping_zip: str(o.shipping_zip, 20),
    shipping_country: str(o.shipping_country, 60),
    shipping_phone: str(o.shipping_phone, 40),
    notes: str(o.notes, 4000),
    tags: str(o.tags, 2000),
    source: str(o.source, 100),
    line_items: Array.isArray(o.line_items) ? cleanDeep(o.line_items.slice(0, 200)) : [],
    raw: rawOf(o.raw),
    // Lo que solo trae la API (§37.6): un CSV no lo pisa con vacío.
    ...(o.fulfillments !== undefined
      ? {
          shipping_method: str(o.shipping_method, 200),
          fulfillments: cleanDeep(o.fulfillments ?? []),
          refunds: cleanDeep(o.refunds ?? []),
          attribution: o.attribution ? cleanDeep(o.attribution) : null,
        }
      : {}),
    ...link,
    imported_at: new Date().toISOString(),
  };
}

/** Un cliente del historial, saneado, como fila de `shopify_history_customers`. */
function customerRow(storeId: string, c: HistoryCustomer, link: { file_id: string } | { import_id: string }) {
  return {
    store_id: storeId,
    customer_key: str(c?.customer_key, 320),
    shopify_customer_id: str(c.shopify_customer_id, 40),
    first_name: str(c.first_name, 200),
    last_name: str(c.last_name, 200),
    email: str(c.email, 320),
    phone: str(c.phone, 40),
    phone_norm: str(c.phone_norm, 20),
    company: str(c.company, 200),
    address1: str(c.address1, 500),
    address2: str(c.address2, 500),
    city: str(c.city, 200),
    province: str(c.province, 200),
    country: str(c.country, 60),
    zip: str(c.zip, 20),
    total_spent: num(c.total_spent),
    total_orders: num(c.total_orders),
    accepts_marketing: str(c.accepts_marketing, 40),
    tags: str(c.tags, 2000),
    note: str(c.note, 4000),
    raw: rawOf(c.raw),
    ...(c.addresses !== undefined
      ? {
          sms_marketing: str(c.sms_marketing, 40),
          whatsapp_marketing: str(c.whatsapp_marketing, 40),
          addresses: cleanDeep((c.addresses ?? []).slice(0, 50)),
          customer_since: iso(c.customer_since),
          account_state: str(c.account_state, 40),
        }
      : {}),
    ...link,
    imported_at: new Date().toISOString(),
  };
}

/**
 * Guarda pedidos del historial sin que un número repetido en Shopify detenga
 * la tanda ni pise a otro pedido (`uniqueOrderNames`, MOM §37.3).
 */
async function upsertHistoryOrders(
  admin: ReturnType<typeof createAdminSupabase>,
  storeId: string,
  rows: ReturnType<typeof orderRow>[],
): Promise<number> {
  const names = [...new Set(rows.map((r) => r.order_name).filter((n): n is string => !!n))];
  if (!names.length) return 0;
  const { data: existing, error: readError } = await admin
    .from("shopify_history_orders")
    .select("order_name,shopify_order_id")
    .eq("store_id", storeId)
    .in("order_name", names);
  if (readError) throw new Error(`No se pudo revisar la tanda: ${readError.message}`);
  const owners = new Map(((existing ?? []) as { order_name: string; shopify_order_id: string | null }[]).map((e) => [e.order_name, e.shopify_order_id]));
  const unique = uniqueOrderNames(rows, owners);
  const { error } = await admin.from("shopify_history_orders").upsert(unique, { onConflict: "store_id,order_name" });
  if (error) throw new Error(`No se pudo guardar la tanda: ${error.message}`);
  return unique.length;
}

/** Una tanda de pedidos. Volver a mandarla no duplica: (tienda, número) es la clave. */
export async function importHistoryOrders(fileId: string, orders: HistoryOrder[]): Promise<{ saved: number } | { error: string }> {
  const g = await guard();
  if ("error" in g) return g;
  const found = await fileOf(fileId, g.storeIds);
  if (!found) return { error: "Archivo inexistente o sin acceso." };
  if (!Array.isArray(orders) || orders.length > 2000) return { error: "Tanda inválida." };
  const rows = orders
    .map((o) => orderRow(found.file.store_id, o, { file_id: found.file.id }))
    .filter((r) => r.order_name);
  if (!rows.length) return { saved: 0 };
  let saved: number;
  try {
    saved = await upsertHistoryOrders(found.admin, found.file.store_id, rows);
  } catch (cause) {
    return { error: (cause as Error).message };
  }
  if (found.file.status === "subiendo") {
    await found.admin.from("shopify_history_files").update({ status: "cargando" }).eq("id", fileId);
    found.file.status = "cargando";
  }
  return { saved };
}

/** Una tanda de clientes. Clave: (tienda, cliente). */
export async function importHistoryCustomers(
  fileId: string,
  customers: HistoryCustomer[],
): Promise<{ saved: number } | { error: string }> {
  const g = await guard();
  if ("error" in g) return g;
  const found = await fileOf(fileId, g.storeIds);
  if (!found) return { error: "Archivo inexistente o sin acceso." };
  if (!Array.isArray(customers) || customers.length > 5000) return { error: "Tanda inválida." };
  const rows = customers
    .map((c) => customerRow(found.file.store_id, c, { file_id: found.file.id }))
    .filter((r) => r.customer_key);
  if (!rows.length) return { saved: 0 };
  const { error } = await found.admin.from("shopify_history_customers").upsert(rows, { onConflict: "store_id,customer_key" });
  if (error) return { error: `No se pudo guardar la tanda: ${error.message}` };
  if (found.file.status === "subiendo") {
    await found.admin.from("shopify_history_files").update({ status: "cargando" }).eq("id", fileId);
    found.file.status = "cargando";
  }
  return { saved: rows.length };
}

/** Cierra el archivo: cuántas filas leyó, cuántos registros dejó, o el error. */
export async function finishHistoryFile(
  fileId: string,
  input: { rowsRead: number; records: number; firstAt: string | null; lastAt: string | null; error?: string | null },
): Promise<{ ok: true } | { error: string }> {
  const g = await guard();
  if ("error" in g) return g;
  const found = await fileOf(fileId, g.storeIds);
  if (!found) return { error: "Archivo inexistente o sin acceso." };
  const failed = typeof input.error === "string" && input.error.trim() !== "";
  const { error } = await found.admin
    .from("shopify_history_files")
    .update({
      status: failed ? "error" : "listo",
      error: failed ? input.error!.slice(0, 1000) : null,
      rows_read: Math.max(0, Math.round(num(input.rowsRead) ?? 0)),
      records: Math.max(0, Math.round(num(input.records) ?? 0)),
      first_at: iso(input.firstAt),
      last_at: iso(input.lastAt),
      finished_at: new Date().toISOString(),
    })
    .eq("id", fileId);
  if (error) return { error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

export interface HistoryAccessProbe {
  /** Pedidos anteriores a 2022 que el token de la tienda alcanza a ver. */
  before2022: number;
  /** Si Shopify dice que son «al menos» (pasa de 10.000). */
  before2022AtLeast: boolean;
  /** El pedido más antiguo que ve el token. */
  oldest: { name: string; createdAt: string } | null;
  scopes: string[];
  /** Ve todos los pedidos de la tienda (`hasFullOrderAccess`): se puede traer por API. */
  fullAccess: boolean;
}

/**
 * ¿El token de la tienda ve todos sus pedidos, no solo los últimos 60 días?
 * Una consulta de solo lectura a Shopify: no guarda nada.
 */
export async function probeShopifyHistoryAccess(storeId: string): Promise<HistoryAccessProbe | { error: string }> {
  const g = await guard();
  if ("error" in g) return g;
  if (!g.storeIds.has(storeId)) return { error: "Tienda inválida o sin acceso." };
  const creds = await getStoreCreds(storeId);
  if (!creds?.shopify_domain || !creds.shopify_token) return { error: "La tienda no tiene conexión con Shopify en Kapta." };
  try {
    const data = await shopifyGraphQL<{
      currentAppInstallation: { accessScopes: { handle: string }[] } | null;
      antiguos: { count: number; precision: string } | null;
      primero: { nodes: { name: string; createdAt: string }[] };
    }>({
      domain: creds.shopify_domain,
      token: creds.shopify_token,
      query: `query {
        currentAppInstallation { accessScopes { handle } }
        antiguos: ordersCount(query: "created_at:<2022-01-01") { count precision }
        primero: orders(first: 1, sortKey: CREATED_AT) { nodes { name createdAt } }
      }`,
    });
    const oldest = data.primero?.nodes?.[0] ?? null;
    const scopes = (data.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle).sort();
    return {
      before2022: data.antiguos?.count ?? 0,
      before2022AtLeast: data.antiguos?.precision === "AT_LEAST",
      oldest,
      scopes,
      fullAccess: hasFullOrderAccess({ scopes, oldestCreatedAt: oldest?.createdAt ?? null, now: new Date() }),
    };
  } catch (cause) {
    return { error: `Shopify no respondió: ${(cause as Error).message.slice(0, 300)}` };
  }
}

/** Lo que la pantalla necesita de una traída por API. */
export type HistoryImportView = Pick<
  HistoryImportRow,
  "id" | "kind" | "status" | "file_size" | "object_count" | "bytes_done" | "records" | "first_at" | "last_at" | "error" | "created_at" | "finished_at"
> & { busy?: boolean };

const view = (r: HistoryImportRow & { busy?: boolean }): HistoryImportView => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  file_size: r.file_size,
  object_count: r.object_count,
  bytes_done: r.bytes_done,
  records: r.records,
  first_at: r.first_at,
  last_at: r.last_at,
  error: r.error,
  created_at: r.created_at,
  finished_at: r.finished_at,
  ...(r.busy ? { busy: true } : {}),
});

/** Escribe en las tablas del historial, nunca en `orders` (§37.1). */
function historyWriter(admin: ReturnType<typeof createAdminSupabase>, storeId: string): RowWriter {
  return {
    async orders(orders, importId) {
      const rows = orders.map((o) => orderRow(storeId, o, { import_id: importId })).filter((r) => r.order_name);
      if (!rows.length) return 0;
      return upsertHistoryOrders(admin, storeId, rows);
    },
    async customers(customers, importId) {
      const rows = customers.map((c) => customerRow(storeId, c, { import_id: importId })).filter((r) => r.customer_key);
      if (!rows.length) return 0;
      const { error } = await admin.from("shopify_history_customers").upsert(rows, { onConflict: "store_id,customer_key" });
      if (error) throw new Error(`No se pudo guardar la tanda: ${error.message}`);
      return rows.length;
    },
    async products(products, images, importId) {
      const now = new Date().toISOString();
      const rows = products.map((p) => ({
        store_id: storeId,
        product_id: str(p.product_id, 40),
        handle: str(p.handle, 300),
        title: str(p.title, 500),
        status: str(p.status, 40),
        vendor: str(p.vendor, 200),
        product_type: str(p.product_type, 200),
        tags: str(p.tags, 2000),
        description_html: typeof p.description_html === "string" ? clip(p.description_html, 200_000) : null,
        seo_title: str(p.seo_title, 500),
        seo_description: str(p.seo_description, 2000),
        created_at: iso(p.created_at),
        updated_at: iso(p.updated_at),
        published_at: iso(p.published_at),
        options: cleanDeep(p.options),
        variants: cleanDeep(p.variants.slice(0, 500)),
        collections: cleanDeep(p.collections.slice(0, 200)),
        metafields: cleanDeep(p.metafields.slice(0, 200).map((m) => ({ ...m, value: m.value ? clip(m.value, 20_000) : null }))),
        import_id: importId,
        imported_at: now,
      })).filter((r) => r.product_id);
      if (rows.length) {
        const { error } = await admin.from("shopify_history_products").upsert(rows, { onConflict: "store_id,product_id" });
        if (error) throw new Error(`No se pudo guardar la tanda: ${error.message}`);
      }
      // Sin `storage_path`: una foto ya copiada conserva su copia.
      const imageRows = images.map((i) => ({
        store_id: storeId,
        image_id: str(i.image_id, 40),
        product_id: str(i.product_id, 40),
        position: i.position,
        src_url: str(i.src_url, 2000),
        alt: str(i.alt, 500),
        width: i.width,
        height: i.height,
        import_id: importId,
        imported_at: now,
      })).filter((r) => r.image_id && r.product_id && r.src_url);
      for (let k = 0; k < imageRows.length; k += 1000) {
        const { error } = await admin
          .from("shopify_history_product_images")
          .upsert(imageRows.slice(k, k + 1000), { onConflict: "store_id,image_id" });
        if (error) throw new Error(`No se pudieron guardar las fotos: ${error.message}`);
      }
      return rows.length;
    },
    async carts(carts, importId) {
      const now = new Date().toISOString();
      const rows = carts.map((c) => ({
        store_id: storeId,
        cart_key: str(c.cart_key, 80),
        kind: c.kind,
        name: str(c.name, 100),
        status: str(c.status, 40),
        created_at: iso(c.created_at),
        updated_at: iso(c.updated_at),
        completed_at: iso(c.completed_at),
        email: str(c.email, 320),
        phone: str(c.phone, 40),
        phone_norm: str(c.phone_norm, 20),
        customer_name: str(c.customer_name, 200),
        address1: str(c.address1, 500),
        address2: str(c.address2, 500),
        city: str(c.city, 200),
        province: str(c.province, 200),
        total: num(c.total),
        currency: str(c.currency, 10),
        url: str(c.url, 2000),
        order_name: str(c.order_name, 60),
        tags: str(c.tags, 2000),
        line_items: cleanDeep(c.line_items.slice(0, 200)),
        raw: rawOf(c.raw),
        import_id: importId,
        imported_at: now,
      })).filter((r) => r.cart_key);
      if (!rows.length) return 0;
      const { error } = await admin.from("shopify_history_carts").upsert(rows, { onConflict: "store_id,cart_key" });
      if (error) throw new Error(`No se pudo guardar la tanda: ${error.message}`);
      return rows.length;
    },
    async orphans(orphans) {
      const ids = [...orphans.keys()];
      const { data } = await admin
        .from("shopify_history_orders")
        .select("order_name,shopify_order_id,line_items")
        .eq("store_id", storeId)
        .in("shopify_order_id", ids);
      for (const row of (data ?? []) as { order_name: string; shopify_order_id: string; line_items: HistoryLineItem[] | null }[]) {
        const extra = orphans.get(row.shopify_order_id);
        if (!extra?.length) continue;
        await admin
          .from("shopify_history_orders")
          .update({ line_items: cleanDeep(mergeLineItems(row.line_items ?? [], extra).slice(0, 200)) })
          .eq("store_id", storeId)
          .eq("order_name", row.order_name);
      }
    },
  };
}

/** Empieza a traer pedidos o clientes por API, o retoma la traída en curso. */
export async function startHistoryImport(storeId: string, kind: BulkKind): Promise<HistoryImportView | { error: string }> {
  const g = await guard();
  if ("error" in g) return g;
  if (!g.storeIds.has(storeId)) return { error: "Tienda inválida o sin acceso." };
  if (!BULK_KINDS.includes(kind)) return { error: "Tipo inválido." };
  try {
    return view(await startImport(createAdminSupabase(), storeId, kind, g.userId));
  } catch (cause) {
    return { error: (cause as Error).message.slice(0, 500) };
  }
}

/** Un paso de la traída: preguntar a Shopify si el archivo está, o leer una tanda (~100 s). */
export async function advanceHistoryImport(importId: string): Promise<HistoryImportView | { error: string }> {
  const g = await guard();
  if ("error" in g) return g;
  const admin = createAdminSupabase();
  const { data } = await admin.from("shopify_history_imports").select(IMPORT_COLUMNS).eq("id", importId).maybeSingle();
  const row = data as HistoryImportRow | null;
  if (!row || !g.storeIds.has(row.store_id)) return { error: "Traída inexistente o sin acceso." };
  try {
    const next = await advanceImport(admin, row, historyWriter(admin, row.store_id));
    if (next.status === "listo") revalidatePath(PATH);
    return view(next);
  } catch (cause) {
    return { error: (cause as Error).message.slice(0, 500) };
  }
}

/**
 * Copia a Storage las fotos de productos que faltan (§37.6), ~60 s por
 * llamada. La pantalla la llama hasta que no quede ninguna.
 */
export async function copyHistoryImages(storeId: string): Promise<{ copied: number; failed: number; remaining: number; total: number } | { error: string }> {
  const g = await guard();
  if ("error" in g) return g;
  if (!g.storeIds.has(storeId)) return { error: "Tienda inválida o sin acceso." };
  try {
    return await copyPendingProductImages(createAdminSupabase(), storeId);
  } catch (cause) {
    return { error: (cause as Error).message.slice(0, 500) };
  }
}
