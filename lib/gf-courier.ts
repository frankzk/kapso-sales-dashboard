// Cliente de la API de GF Courier (sistema independiente; reemplaza al módulo interno de Grupo GF, MOM §29).
// Base: env GF_COURIER_API_BASE (por defecto https://gf-courier.vercel.app). Un token Bearer por tienda.
//
// Endpoints cubiertos (especificación "GF Courier — Especificación API"):
//   POST /v1/orders                       — crear contraentrega Lima (COD_LIMA), con Idempotency-Key
//   GET  /v1/orders/{tracking}            — consultar por guía GF
//   GET  /v1/orders?external_id=          — consultar por id del pedido en Kapta
//   POST /v1/orders/{tracking}/cancel     — anular (sin costo antes de la preparación)
//   GET  /v1/products                     — catálogo de la tienda en GF (SKU, modo, disponibilidad)
//   POST /v1/products/batch               — crear o actualizar hasta 200 productos por SKU (catalogue:write)
//   GET  /v1/me                           — comprobar el token al guardarlo
//
// CONVENCIONES (las mismas del cliente de Aliclik, lib/aliclik.ts)
// 1. Nunca lanza: devuelve GfResult<T>.
// 2. Los errores de GF traen {error:{code,message,field,allowed}} en español y accionable: se propagan tal cual.
// 3. `timedOut` se distingue: en una creación, un timeout NO significa "no se creó". A diferencia de Aliclik, GF sí
//    tiene Idempotency-Key, así que el mismo pedido se reintenta con la MISMA clave y GF devuelve la misma guía.
import { createHmac, timingSafeEqual } from "node:crypto";

export type GfStatusCode =
  | "CREATED" | "READY_FOR_PICKUP" | "PICKED_UP" | "IN_WAREHOUSE" | "OUT_FOR_DELIVERY" | "INCIDENT"
  | "DELIVERED" | "REFUSED" | "RETURNING" | "RETURNED" | "HANDED_TO_CARRIER" | "CANCELLED" | "LOST";
export interface GfStatus { code: GfStatusCode; name?: string; sub_status: string | null; final: boolean }
export interface GfOrder {
  tracking_id: string; external_id: string; service: "COD_LIMA"; status: GfStatus; shipping_cost: number;
  currency: "PEN"; estimated_delivery_date: string; label_url: string; tracking_url: string | null; created_at?: string;
}
export interface GfOrderInput {
  external_id: string; service: "COD_LIMA";
  recipient: { first_name: string; last_name?: string; second_last_name?: string; phone: string; document?: string };
  destination: { ubigeo?: string; district?: string; address: string; reference?: string; gps?: string };
  items: { sku: string; name?: string; quantity: number; unit_price: number }[];
  payment: { total: number; advance_paid: number; amount_to_collect: number };
  scheduled_date?: string; observations?: string;
}
export interface GfError { code: string; message: string; field?: string; allowed?: unknown[]; tracking_id?: string }
export type GfResult<T> =
  | { ok: true; data: T; replayed?: boolean }
  | { ok: false; status: number | null; error: GfError; timedOut: boolean };

export interface GfClientOpts { apiToken: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number }

export function gfApiBase(): string {
  return (process.env.GF_COURIER_API_BASE ?? "https://gf-courier.vercel.app").trim().replace(/\/$/, "");
}

/** Clave de idempotencia estable por salida: el mismo pedido y la misma salida siempre reintentan con la misma. */
export function gfIdempotencyKey(orderId: string, shipmentId: string): string {
  return `KP-${orderId}-${shipmentId}`.slice(0, 128);
}

async function call<T>(opts: GfClientOpts, method: "GET" | "POST", path: string, body?: unknown, key?: string): Promise<GfResult<T>> {
  const url = `${(opts.baseUrl ?? gfApiBase()).replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.apiToken.trim()}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (key) headers["Idempotency-Key"] = key;
  let response: Response;
  try {
    response = await (opts.fetchImpl ?? fetch)(url, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000), redirect: "error",
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, status: null, timedOut, error: { code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
      message: timedOut ? "GF Courier no respondió a tiempo. El pedido pudo haberse creado: reintenta con la misma clave." : "No se pudo conectar con GF Courier." } };
  }
  let json: unknown = null;
  try { json = await response.json(); } catch { json = null; }
  if (response.ok) return { ok: true, data: json as T, replayed: response.headers.get("idempotent-replayed") === "true" };
  const raw = (json ?? {}) as { error?: GfError; code?: string; message?: string; field?: string };
  const error: GfError = raw.error ?? { code: raw.code ?? `HTTP_${response.status}`, message: raw.message ?? `GF Courier respondió ${response.status}.`, field: raw.field };
  return { ok: false, status: response.status, error, timedOut: false };
}

export const gfCourier = {
  me: (o: GfClientOpts) => call<{ merchant_id: string; business_name: string | null; permissions: string[] }>(o, "GET", "/v1/me"),
  createOrder: (o: GfClientOpts, input: GfOrderInput, idempotencyKey: string) => call<GfOrder>(o, "POST", "/v1/orders", input, idempotencyKey),
  getOrder: (o: GfClientOpts, tracking: string) => call<GfOrder>(o, "GET", `/v1/orders/${encodeURIComponent(tracking)}`),
  findByExternalId: (o: GfClientOpts, externalId: string) => call<GfOrder>(o, "GET", `/v1/orders?external_id=${encodeURIComponent(externalId)}`),
  cancelOrder: (o: GfClientOpts, tracking: string, reason: string, idempotencyKey: string, note?: string) =>
    call<{ tracking_id: string; status: { code: "CANCELLED" }; cancel_cost: number }>(o, "POST", `/v1/orders/${encodeURIComponent(tracking)}/cancel`, { reason, ...(note ? { note } : {}) }, idempotencyKey),
  products: (o: GfClientOpts, after?: string) => call<{ data: { sku: string; merchant_sku: string; name: string; mode: string; sales_status?: string; variant_id: string }[]; next_cursor: string | null }>(
    o, "GET", `/v1/products?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`),
  productsBatch: (o: GfClientOpts, items: { sku: string; name: string; sales_status: "IN_STOCK" | "OUT_OF_STOCK" }[], idempotencyKey: string) =>
    call<{ results: { sku: string; status: "created" | "updated" | "unchanged" | "error"; error?: { code: string; message: string } }[] }>(o, "POST", "/v1/products/batch", { items }, idempotencyKey),
};

// ---- Webhooks de GF (sección 8): X-GF-Signature = v1=HMAC_SHA256(secret, timestamp + "." + body) ----
export const GF_WEBHOOK_TOLERANCE_S = 300;
export type GfWebhookCheck = { ok: true } | { ok: false; reason: "missing_headers" | "stale_timestamp" | "bad_signature" };
/** Verifica la firma sobre el cuerpo CRUDO (antes de parsear) y rechaza timestamps de más de 5 minutos. */
export function verifyGfWebhook(rawBody: string, headers: { signature: string | null; timestamp: string | null }, secret: string, nowMs = Date.now()): GfWebhookCheck {
  if (!headers.signature || !headers.timestamp || !/^\d{9,12}$/.test(headers.timestamp)) return { ok: false, reason: "missing_headers" };
  if (Math.abs(nowMs / 1000 - Number(headers.timestamp)) > GF_WEBHOOK_TOLERANCE_S) return { ok: false, reason: "stale_timestamp" };
  const expected = Buffer.from(`v1=${createHmac("sha256", secret).update(`${headers.timestamp}.${rawBody}`).digest("hex")}`);
  const given = Buffer.from(headers.signature.trim());
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}
export interface GfWebhookEnvelope { id: string; type: string; created_at: string; merchant_id: string; data: Record<string, unknown> }
