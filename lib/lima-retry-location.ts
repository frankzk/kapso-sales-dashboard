import "server-only";

// Con qué coordenada se cotiza y se crea la guía de un reintento Aliclik de
// Lima (MOM §9.5): la del pedido, o la de su dirección en Google (el
// edificio). Una sola regla para la pasada automática y para «Aprobar» de Repro
// Lima (owner, 08-11-2026: «mismo candado»). Google se usa solo si:
//   * el owner encendió «Usar la ubicación por dirección (Google) si el pedido
//     no tiene» (`lima_retry_auto_settings.geocode_enabled`),
//   * la clave `GOOGLE_GEOCODING_API_KEY` está, y
//   * la ÚLTIMA medición de Lima cumple B con el edificio (`geocodeLimaGate`).
// Y solo con el edificio (`geocodeOrderAddress`, caché `order_geocodes`). El
// pin del pedido se usa tal cual, salvo que sea el punto de Google de ese
// mismo pedido (`googlePinnedOrderIds`): ese lo puso Kapta, no la clienta, y
// pasa por el mismo candado.
//
// Antes de Google, la ubicación que la clienta YA mandó por WhatsApp (owner,
// 08-11-2026): su conversación de Chatby (`fetchChatbyConversation`) y su
// último pin desde 3 días antes del pedido (`chatbyGuidePin`, la misma regla de
// la confirmación, MOM §6.1). Sin mandarle nada. Si el mismo celular tiene otro
// pedido creado entre este y ese pin (más 3 días), el pin puede ser del otro:
// no se usa.

import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { geocodeLimaGate } from "@/lib/geocode-google";
import { geocodeOrderAddress, googlePinnedOrderIds, latestGeocodeLimaRun } from "@/lib/geocode-google-server";
import { fetchChatbyConversation } from "@/lib/chatby-api";
import { CHATBY_PIN_MAX_DAYS_BEFORE_ORDER, chatbyGuidePin } from "@/lib/chatby-autoconfirm";
import type { RetryGeocodeMiss } from "@/lib/lima-retry-auto";

/**
 * La coordenada con la que se cotiza y se crea cuando no es la del pedido: la
 * que mandó la clienta por WhatsApp (`chatby`) o la del edificio en Google.
 */
export type RetryCoordinate = { value: string; source: "google" | "chatby" };
/** @deprecated nombre anterior de `RetryCoordinate`. */
export type GoogleCoordinate = RetryCoordinate;

/** Con qué coordenada se cotiza: la del pedido (`null`), la de WhatsApp o Google, o por qué no hay. */
export type RetryLocated = { coordinate: RetryCoordinate | null } | { miss: RetryGeocodeMiss };

/** Leer la conversación de Chatby de la clienta: la clave (`CHATBY_API_KEY`). */
export interface RetryChatbyRead {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** Lo que `locateRetryOrder` necesita del pedido. */
export interface RetryLocationRow {
  order_id: string;
  store_id: string;
  coverage?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  geo_source?: string | null;
  customer_phone?: string | null;
  order_created_at?: string | null;
  address?: string | null;
  district?: string | null;
  province?: string | null;
  region?: string | null;
}

/**
 * La clave de Google para esta organización, con el interruptor ya encendido:
 * solo si la clave está en el entorno y la ÚLTIMA medición de Lima sigue
 * cumpliendo B con el edificio (`geocodeLimaGate`). Si una medición nueva ya no
 * lo cumple, deja de usarse aunque el interruptor siga encendido. Lo que no se
 * pudo leer no enciende nada (`error`).
 */
export async function retryGeocodeKey(admin: SupabaseClient, orgId: string): Promise<{ key: string | null; error?: string }> {
  const key = env.googleGeocodingApiKey();
  if (!key) return { key: null };
  try {
    const latest = await latestGeocodeLimaRun(admin, orgId);
    return { key: geocodeLimaGate(latest?.summary ?? null).ok ? key : null };
  } catch (e) {
    return { key: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * La clave de Google para «Aprobar» de un pedido: lee el interruptor de su
 * organización y aplica `retryGeocodeKey`. Apagado, sin fila o sin poder
 * leerlo: null (sin Google, como la pasada).
 */
export async function retryGeocodeKeyForStore(admin: SupabaseClient, storeId: string): Promise<string | null> {
  const { data: store } = await admin.from("stores").select("org_id").eq("id", storeId).maybeSingle();
  const orgId = (store as { org_id?: string | null } | null)?.org_id ?? null;
  if (!orgId) return null;
  // `*`: sin la 0308, `geocode_enabled` no viene y se lee como apagado.
  const { data: settings, error } = await admin.from("lima_retry_auto_settings").select("*").eq("org_id", orgId).maybeSingle();
  if (error || (settings as { geocode_enabled?: boolean } | null)?.geocode_enabled !== true) return null;
  return (await retryGeocodeKey(admin, orgId)).key;
}

/**
 * El pin que la clienta ya mandó por WhatsApp para este pedido, como «lat, lng»,
 * o null: sin clave, sin celular, sin conversación o sin pin de esta compra, o
 * si el mismo celular tiene otro pedido creado entre este y ese pin (más 3
 * días). Nunca lanza: lo que falla es «sin pin» y sigue Google.
 */
export async function chatbyRetryPin(admin: SupabaseClient, row: RetryLocationRow, chatby: RetryChatbyRead | null | undefined): Promise<string | null> {
  if (!chatby?.apiKey || !row.customer_phone || !row.order_created_at) return null;
  try {
    const conversation = await fetchChatbyConversation({ phone: row.customer_phone, apiKey: chatby.apiKey, fetchImpl: chatby.fetchImpl });
    if (conversation.status !== "ok") return null;
    const pin = chatbyGuidePin(conversation.messages, row.order_created_at);
    if (!pin) return null;
    const until = new Date(Date.parse(pin.at) + CHATBY_PIN_MAX_DAYS_BEFORE_ORDER * 86_400_000).toISOString();
    const { data, error } = await admin.from("order_master").select("order_id")
      .eq("customer_phone", row.customer_phone).neq("order_id", row.order_id)
      .gt("order_created_at", row.order_created_at).lte("order_created_at", until).limit(1);
    if (error || (data ?? []).length) return null;
    return pin.coordinate;
  } catch {
    return null;
  }
}

/**
 * Con qué coordenada se cotiza el reintento de este pedido: su pin; si no, el
 * que la clienta mandó por WhatsApp (con `chatby`); si no, el edificio en
 * Google con el candado. `lookedUp` dice si se le preguntó a Google (la pasada
 * lo cuenta) y `quotaHit` si Google dijo que se acabó el cupo del día (la
 * pasada no le pregunta más). Con `quotaHit` de entrada no se le pregunta.
 */
export async function locateRetryOrder(
  admin: SupabaseClient,
  row: RetryLocationRow,
  geocodeKey: string | null,
  opts: { quotaHit?: boolean; chatby?: RetryChatbyRead | null } = {},
): Promise<{ located: RetryLocated; lookedUp: boolean; quotaHit: boolean }> {
  const done = (located: RetryLocated, lookedUp = false, quotaHit = false) => ({ located, lookedUp, quotaHit });
  if (row.latitude != null && row.longitude != null) {
    let google: boolean;
    try {
      google = (await googlePinnedOrderIds(admin, [row])).has(row.order_id);
    } catch {
      // Sin saber de dónde salió el pin, no se cotiza con él: se reintenta.
      return done({ miss: "error" });
    }
    if (!google) return done({ coordinate: null });
  }
  const whatsapp = await chatbyRetryPin(admin, row, opts.chatby);
  if (whatsapp) return done({ coordinate: { value: whatsapp, source: "chatby" } });
  if (!geocodeKey || row.coverage !== "lima") return done({ miss: "apagado" });
  if (opts.quotaHit) return done({ miss: "sin_cupo" });
  try {
    const geo = await geocodeOrderAddress(admin, {
      order_id: row.order_id,
      store_id: row.store_id,
      address: row.address ?? null,
      district: row.district ?? null,
      province: row.province ?? null,
      region: row.region ?? null,
    }, { key: geocodeKey });
    if (geo.kind === "ok") return done({ coordinate: { value: `${geo.lat}, ${geo.lng}`, source: "google" } }, true);
    if (geo.kind === "rejected") return done({ miss: "sin_edificio" }, true);
    if (geo.reason === "sin_cupo") return done({ miss: "sin_cupo" }, true, true);
    if (geo.reason === "sin_direccion") return done({ miss: "sin_direccion" }, true);
    if (geo.reason === "sin_clave") return done({ miss: "apagado" }, true);
    return done({ miss: "error" }, true);
  } catch {
    return done({ miss: "error" }, true);
  }
}
