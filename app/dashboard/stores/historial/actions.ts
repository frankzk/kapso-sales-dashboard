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
import type { HistoryCustomer, HistoryFileKind, HistoryOrder } from "@/lib/shopify-history";

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
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const iso = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
const rawOf = (v: unknown): Record<string, string> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k.slice(0, 120)] = val.slice(0, 4000);
  }
  return out;
};

/** Una tanda de pedidos. Volver a mandarla no duplica: (tienda, número) es la clave. */
export async function importHistoryOrders(fileId: string, orders: HistoryOrder[]): Promise<{ saved: number } | { error: string }> {
  const g = await guard();
  if ("error" in g) return g;
  const found = await fileOf(fileId, g.storeIds);
  if (!found) return { error: "Archivo inexistente o sin acceso." };
  if (!Array.isArray(orders) || orders.length > 2000) return { error: "Tanda inválida." };
  const rows = orders
    .map((o) => ({
      store_id: found.file.store_id,
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
      line_items: Array.isArray(o.line_items) ? o.line_items.slice(0, 200) : [],
      raw: rawOf(o.raw),
      file_id: found.file.id,
      imported_at: new Date().toISOString(),
    }))
    .filter((r) => r.order_name);
  if (!rows.length) return { saved: 0 };
  const { error } = await found.admin.from("shopify_history_orders").upsert(rows, { onConflict: "store_id,order_name" });
  if (error) return { error: `No se pudo guardar la tanda: ${error.message}` };
  if (found.file.status === "subiendo") {
    await found.admin.from("shopify_history_files").update({ status: "cargando" }).eq("id", fileId);
    found.file.status = "cargando";
  }
  return { saved: rows.length };
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
    .map((c) => ({
      store_id: found.file.store_id,
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
      file_id: found.file.id,
      imported_at: new Date().toISOString(),
    }))
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
}

/**
 * ¿El token de la tienda ve los pedidos de más de 60 días? Una consulta de solo
 * lectura a Shopify: no guarda nada. Sin `read_all_orders`, Shopify solo deja
 * ver los últimos 60 días y aquí sale 0 antes de 2022.
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
    return {
      before2022: data.antiguos?.count ?? 0,
      before2022AtLeast: data.antiguos?.precision === "AT_LEAST",
      oldest: data.primero?.nodes?.[0] ?? null,
      scopes: (data.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle).sort(),
    };
  } catch (cause) {
    return { error: `Shopify no respondió: ${(cause as Error).message.slice(0, 300)}` };
  }
}
