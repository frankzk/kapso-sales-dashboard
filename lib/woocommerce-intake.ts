// La entrada de pedidos de WooCommerce (MOM §37.11, plan del sábado 25-10-2026):
// las piezas que comparten el webhook (`processWooWebhook`) y la pasada
// `woo_orders` de la sincronización (`syncWooOrders`), las dos en lib/ingest.ts.
//
// Solo servidor: descifra las claves de la tienda (lib/crypto) y calcula el
// sha256 de los avisos. Nada de aquí viaja al navegador.
//
// LA REGLA DE AISLAMIENTO. Kenku Perú y Aurela siguen en Shopify hasta el
// cierre (28-10-2026). Nada de este archivo lee ni escribe lo de Shopify:
// `loadWooStoreCreds` pide solo las columnas `woo_*` (0273) y descifra cada
// secreto por su cuenta, de modo que un secreto de WooCommerce que no se pueda
// descifrar no tumba ni la tienda ni su sincronización de Shopify.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptOrNull } from "@/lib/crypto";
import {
  WOO_ORDER_TOPICS,
  WooError,
  isValidWooSiteKey,
  normalizeWooSiteUrl,
  wooGmt,
  type WooClientOpts,
  type WooOrder,
} from "@/lib/woocommerce";

/** La fuente de `sync_state` de la pasada de pedidos de WooCommerce. */
export const WOO_SYNC_SOURCE = "woo_orders";

/**
 * Los temas de pedido que se procesan: los de `WOO_ORDER_TOPICS` (lib/woocommerce.ts,
 * una sola lista). Los demás (productos, clientes, `action.*`) se ignoran con 200.
 */
export const WOO_INTAKE_TOPICS = WOO_ORDER_TOPICS;
export type WooIntakeTopic = (typeof WOO_INTAKE_TOPICS)[number];

/**
 * Lo que la pasada lee de la tienda: solo lo de WooCommerce, más la zona
 * horaria (rollups) y el estado. Ninguna columna de Shopify.
 */
export const WOO_STORE_COLUMNS =
  "id,status,timezone,platform,woo_site_url,woo_site_key,woo_consumer_key_enc,woo_consumer_secret_enc,woo_webhook_secret_enc,woo_last_error";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Las credenciales de WooCommerce de una tienda, descifradas. Solo servidor. */
export interface WooStoreCreds {
  id: string;
  status: string;
  timezone: string;
  /** `stores.platform` (0273): dónde crea Kapta los pedidos nuevos. No decide la entrada. */
  platform: string;
  /** `woo_site_url` limpia (`normalizeWooSiteUrl`), o null. */
  siteUrl: string | null;
  siteKey: string | null;
  consumerKey: string | null;
  consumerSecret: string | null;
  webhookSecret: string | null;
  lastError: string | null;
  /** Columnas `*_enc` que no se pudieron descifrar (solo el nombre). */
  undecryptable: string[];
}

function decryptColumn(row: Record<string, unknown>, column: string, bad: string[]): string | null {
  const value = row[column];
  if (typeof value !== "string" || !value) return null;
  try {
    return decryptOrNull(value)?.trim() || null;
  } catch {
    bad.push(column);
    return null;
  }
}

/** La fila de `stores` (con las columnas de `WOO_STORE_COLUMNS`) → credenciales. Nunca lanza. */
export function wooCredsFromRow(row: Record<string, unknown>): WooStoreCreds {
  const undecryptable: string[] = [];
  const siteKey = typeof row.woo_site_key === "string" ? row.woo_site_key.trim() : "";
  return {
    id: String(row.id ?? ""),
    status: typeof row.status === "string" ? row.status : "active",
    timezone: typeof row.timezone === "string" && row.timezone ? row.timezone : "America/Lima",
    platform: typeof row.platform === "string" ? row.platform : "shopify",
    siteUrl: normalizeWooSiteUrl(row.woo_site_url),
    siteKey: isValidWooSiteKey(siteKey) ? siteKey : null,
    consumerKey: decryptColumn(row, "woo_consumer_key_enc", undecryptable),
    consumerSecret: decryptColumn(row, "woo_consumer_secret_enc", undecryptable),
    webhookSecret: decryptColumn(row, "woo_webhook_secret_enc", undecryptable),
    lastError: typeof row.woo_last_error === "string" ? row.woo_last_error : null,
    undecryptable,
  };
}

/**
 * Lee y descifra lo de WooCommerce de una tienda. `creds: null` sin `error` es
 * «la tienda no existe». Un `error` es que la lectura falló (por ejemplo, el
 * código llegó antes que la 0273): quien llama decide qué hacer con él.
 */
export async function loadWooStoreCreds(
  admin: SupabaseClient,
  storeId: string,
): Promise<{ creds: WooStoreCreds | null; error: string | null }> {
  // `stores.id` es uuid: otra cosa en la URL es una tienda que no existe, no un
  // error de la base.
  if (!UUID_RE.test(storeId ?? "")) return { creds: null, error: null };
  const { data, error } = await admin.from("stores").select(WOO_STORE_COLUMNS).eq("id", storeId).maybeSingle();
  if (error) return { creds: null, error: error.message };
  if (!data) return { creds: null, error: null };
  return { creds: wooCredsFromRow(data as Record<string, unknown>), error: null };
}

/** ¿Tiene todo lo que hace falta para leer pedidos por la API REST? */
export function hasWooApiCredentials(
  creds: Pick<WooStoreCreds, "siteUrl" | "siteKey" | "consumerKey" | "consumerSecret"> | null | undefined,
): creds is WooStoreCreds & { siteUrl: string; siteKey: string; consumerKey: string; consumerSecret: string } {
  return Boolean(creds?.siteUrl && creds.siteKey && creds.consumerKey && creds.consumerSecret);
}

/** Las opciones del cliente REST (lib/woocommerce.ts) con las credenciales de la tienda. */
export function wooClientOpts(
  creds: { siteUrl: string; consumerKey: string; consumerSecret: string },
  extra: Partial<WooClientOpts> = {},
): WooClientOpts {
  return { siteUrl: creds.siteUrl, consumerKey: creds.consumerKey, consumerSecret: creds.consumerSecret, ...extra };
}

/**
 * ¿El 401 es el de un hosting que BORRA la cabecera Authorization? WooCommerce
 * contesta `woocommerce_rest_cannot_view` (o `_list`, `_create`…) con claves
 * buenas cuando no le llegó la cabecera. Entonces se reintenta UNA vez con las
 * claves en la query string (por https; la URL nunca se registra).
 */
export function isStrippedAuthHeaderError(e: unknown): boolean {
  return (
    e instanceof WooError &&
    e.status === 401 &&
    typeof e.code === "string" &&
    e.code.startsWith("woocommerce_rest_cannot_")
  );
}

/**
 * Corre `fn` con autenticación Basic y, si el hosting borró la cabecera, otra
 * vez con la query string. Devuelve el resultado y con qué modo salió, para
 * que una pasada no vuelva a probar Basic en cada página.
 */
export async function withWooAuthFallback<T>(
  opts: WooClientOpts,
  fn: (o: WooClientOpts) => Promise<T>,
): Promise<{ value: T; auth: "basic" | "query" }> {
  if (opts.auth === "query") return { value: await fn(opts), auth: "query" };
  try {
    return { value: await fn({ ...opts, auth: "basic" }), auth: "basic" };
  } catch (e) {
    if (!isStrippedAuthHeaderError(e)) throw e;
    return { value: await fn({ ...opts, auth: "query" }), auth: "query" };
  }
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * El tema del aviso: `X-WC-Webhook-Topic` («order.updated»), o si falta,
 * `X-WC-Webhook-Resource` + `X-WC-Webhook-Event`. En minúsculas; "" si no hay.
 */
export function wooWebhookTopic(
  topic: string | null | undefined,
  resource?: string | null,
  event?: string | null,
): string {
  const t = (topic ?? "").trim().toLowerCase();
  if (t) return t;
  const r = (resource ?? "").trim().toLowerCase();
  const ev = (event ?? "").trim().toLowerCase();
  return r && ev ? `${r}.${ev}` : "";
}

export function isWooIntakeTopic(topic: string): topic is WooIntakeTopic {
  return (WOO_INTAKE_TOPICS as readonly string[]).includes(topic);
}

/**
 * La clave de `webhook_events.webhook_id` (única por tienda) que descarta un
 * aviso repetido: el sha256 del cuerpo crudo, con «wc:» delante.
 *
 * NUNCA `X-WC-Webhook-Delivery-ID` sola: es `wp_hash(id del webhook . segundo)`
 * y dos pedidos distintos del mismo segundo la comparten (uno se perdería). El
 * cuerpo de un pedido lleva su `date_modified`, así que cada cambio real tiene
 * otro cuerpo, y el mismo cuerpo dos veces es el mismo estado.
 *
 * `order.deleted` es la excepción: su cuerpo es solo `{"id":N}`, igual cada vez
 * que el mismo pedido va a la papelera. Si se mandara, se restaurara y se
 * volviera a mandar, la segunda vez se tomaría por repetida y Kapta lo daría por
 * vivo (la pasada no ve la papelera). Ahí la clave lleva además el Delivery-ID,
 * o la hora si no vino. Marcarlo anulado es idempotente: procesarlo dos veces
 * no cambia nada.
 */
export function wooWebhookEventKey(
  topic: string,
  rawBody: string,
  deliveryId: string | null | undefined,
  now: Date = new Date(),
): string {
  const h = createHash("sha256").update(rawBody, "utf8");
  if (topic === "order.deleted") {
    h.update(`\n${topic}\n${(deliveryId ?? "").trim() || now.toISOString()}`, "utf8");
  }
  return `wc:${h.digest("hex")}`;
}

function siteIdentity(url: string): { host: string; path: string } | null {
  try {
    const u = new URL(url);
    return {
      host: u.hostname.toLowerCase().replace(/^www\./, ""),
      path: u.pathname.replace(/\/+$/, ""),
    };
  } catch {
    return null;
  }
}

/**
 * ¿El aviso viene del sitio guardado? `X-WC-Webhook-Source` es el `home_url`
 * del WordPress que lo mandó («https://kenku.pe/»). Con `www.` o sin él, y con
 * o sin barra final, es el mismo sitio. Sin cabecera, o sin sitio guardado, no
 * hay con qué comparar y se acepta: la firma ya dijo que es de quien tiene el
 * secreto. Sirve para que un sitio de prueba que comparte secreto con el de
 * producción no meta sus pedidos de prueba al Master.
 */
export function wooSourceMatchesSite(source: string | null | undefined, siteUrl: string | null | undefined): boolean {
  const s = (source ?? "").trim();
  if (!s || !siteUrl) return true;
  const a = siteIdentity(s);
  const b = siteIdentity(siteUrl);
  if (!a || !b) return false;
  return a.host === b.host && a.path === b.path;
}

/** Lo que la ruta necesita del resultado de `processWooWebhook` (lib/ingest.ts). */
export interface WooWebhookOutcome {
  status: "ok" | "duplicate" | "ping" | "ignored" | "unauthorized" | "unknown_store" | "error";
  ping?: boolean;
}

/**
 * El código HTTP de cada resultado del webhook. WooCommerce no reintenta y
 * desactiva el webhook tras 5 fallos seguidos, así que todo es 200 salvo:
 *   · 401: la firma no cuadra (el secreto está mal, que se vea en WooCommerce);
 *   · 404: el ping de alta de una tienda que no existe (dirección mal pegada:
 *     WooCommerce lo muestra al crear el webhook);
 *   · 503: el ping cuando no se pudo leer la tienda (se vuelve a guardar).
 */
export function wooWebhookHttpStatus(result: WooWebhookOutcome): number {
  switch (result.status) {
    case "unauthorized":
      return 401;
    case "unknown_store":
      return result.ping ? 404 : 200;
    case "error":
      return result.ping ? 503 : 200;
    default:
      return 200;
  }
}

/** El host de una dirección, para los mensajes (sin ruta ni query). */
export function wooHostOf(url: string | null | undefined): string {
  try {
    return new URL(String(url ?? "")).hostname || "(sin dirección)";
  } catch {
    return "(sin dirección)";
  }
}

/** La dirección que se pega en WooCommerce → Ajustes → Avanzado → Webhooks. */
export function wooWebhookDeliveryUrl(appUrl: string, storeId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhooks/woocommerce/${storeId}`;
}

/**
 * Deja el último fallo en `stores.woo_last_error` (o lo limpia con null), sin
 * escribir si ya dice eso. Nunca lanza: es un aviso para Ajustes, no un paso
 * del proceso. El texto no lleva secretos (los mensajes de lib/woocommerce no
 * los llevan) y se corta a 500 caracteres.
 */
export async function recordWooLastError(
  admin: SupabaseClient,
  storeId: string,
  message: string | null,
  current?: string | null,
): Promise<void> {
  const next = message ? message.slice(0, 500) : null;
  if (current !== undefined && (current ?? null) === next) return;
  try {
    await admin.from("stores").update({ woo_last_error: next }).eq("id", storeId);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Sincronización: el cursor
// ---------------------------------------------------------------------------

/** Pedidos por página: el máximo de WooCommerce. */
export const WOO_SYNC_PER_PAGE = 100;
/** Páginas por pasada como mucho (1.000 pedidos): lo que quede sigue en la siguiente. */
export const WOO_SYNC_MAX_PAGES = 10;
/**
 * Reloj de la pasada por tienda. El cron recorre todas las tiendas en serie con
 * 300 s: WooCommerce no puede comerse el tiempo de Kapso y de los leads. Cada
 * llamada corta además a los 15 s (`WOO_TIMEOUT_MS`).
 */
export const WOO_SYNC_BUDGET_MS = 40_000;
/**
 * Cada pasada vuelve a leer los últimos 2 minutos antes del cursor. WooCommerce
 * fija `date_modified` al empezar a guardar, no al terminar: un pedido que se
 * guardaba mientras corría la pasada anterior puede tener una fecha anterior al
 * cursor. Releerlo es inocuo (upsert).
 */
export const WOO_SYNC_OVERLAP_MS = 2 * 60_000;

/**
 * Desde cuándo pedir (`modified_after`): el cursor menos el solape, o el piso
 * (`ORDERS_SYNC_FROM`, como `shopify_all`) la primera vez.
 */
export function wooSyncStart(cursor: string | null | undefined, floor: string): string {
  const c = Date.parse(cursor ?? "");
  if (Number.isFinite(c)) return new Date(c - WOO_SYNC_OVERLAP_MS).toISOString();
  const f = Date.parse(floor);
  return Number.isFinite(f) ? new Date(f).toISOString() : new Date(0).toISOString();
}

/** El `date_modified_gmt` más nuevo de una página, en ISO con «Z», o null. */
export function maxWooModified(orders: readonly Pick<WooOrder, "date_modified_gmt" | "date_created_gmt">[]): string | null {
  let max: string | null = null;
  let maxMs = -Infinity;
  for (const o of orders) {
    const iso = wooGmt(o?.date_modified_gmt) ?? wooGmt(o?.date_created_gmt);
    const ms = Date.parse(iso ?? "");
    if (Number.isFinite(ms) && ms > maxMs) {
      maxMs = ms;
      max = new Date(ms).toISOString();
    }
  }
  return max;
}

/** El mayor de dos instantes ISO (null si ninguno vale). */
export function laterIso(a: string | null | undefined, b: string | null | undefined): string | null {
  const ma = Date.parse(a ?? "");
  const mb = Date.parse(b ?? "");
  if (!Number.isFinite(ma) && !Number.isFinite(mb)) return null;
  if (!Number.isFinite(mb) || (Number.isFinite(ma) && ma >= mb)) return new Date(ma).toISOString();
  return new Date(mb).toISOString();
}

/**
 * La siguiente página de una pasada, por «llave» y no por número: se vuelve a
 * pedir la página 1 desde un segundo antes del último pedido leído. Con
 * `page=N` sobre un conjunto que cambia mientras se pagina (un pedido que se
 * modifica salta al final de la lista ordenada por `modified`), los demás se
 * corren un lugar y uno quedaría sin leer para siempre. Si la página entera es
 * de un mismo segundo (más de 100 pedidos guardados juntos), no hay avance por
 * fecha y se pasa a la página siguiente con el mismo `modified_after`.
 */
export function nextWooPage(
  current: { modifiedAfter: string; page: number },
  pageMax: string | null,
): { modifiedAfter: string; page: number } {
  const m = Date.parse(pageMax ?? "");
  const after = Date.parse(current.modifiedAfter);
  if (Number.isFinite(m)) {
    const next = m - 1000;
    if (!Number.isFinite(after) || next > after) return { modifiedAfter: new Date(next).toISOString(), page: 1 };
  }
  return { modifiedAfter: current.modifiedAfter, page: current.page + 1 };
}
