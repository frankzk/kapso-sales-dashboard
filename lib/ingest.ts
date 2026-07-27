// Ingestion orchestration shared by the webhook handler and the sync cron.
// All writes go through the service-role admin client (RLS-bypassing) and are
// idempotent. Per-store tokens are decrypted here, on demand, server-side only.

import { createHash, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { decryptOrNull } from "@/lib/crypto";
import { chunk } from "@/lib/access";
import { unlimitedDeadline, type Deadline } from "@/lib/deadline";
import { recomputeOrderMasterSafe, reconcileOrderMaster } from "@/lib/order-master";
import { fetchMetaAdMeta, normalizeMetaAdAccounts, type StoreMetaAdAccount } from "@/lib/meta-marketing";
import {
  buildAllOrdersSearchQuery,
  buildDraftOrdersSearchQuery,
  buildKapsoOrdersSearchQuery,
  DRAFT_OPEN_WINDOW_DAYS,
  fetchDraftOrdersPage,
  fetchOrdersPage,
  hasKapsoTag,
  mapRestDraftOrder,
  mapRestOrder,
  verifyShopifyHmac,
} from "@/lib/shopify";
import {
  classifyKapsoEvent,
  fetchConversationSignals,
  getPhoneHealth,
  listAllConversations,
  listApiLogs,
  listWhatsappNumbers,
  mapKapsoConversation,
  type KapsoPhoneNumber,
} from "@/lib/kapso";
import {
  buildOpsSnapshotPayload,
  summarizeApiLogs,
  tzParts,
} from "@/lib/metrics";
import { applyWhatsappStatusEvents, parseWhatsappStatusEvents } from "@/lib/whatsapp-outbox";
import {
  applyHandoff,
  archiveStaleLeads,
  eventOverridesDisposition,
  expireColdHandoffs,
  flagCartAttentionWaves,
  flagOverdueFollowups,
  ingestConversationEvent,
  lastDispositionAtByPhone,
  linkDraftOrdersToLeads,
  linkOrderToLead,
  linkOrdersToLeads,
  processBrowseAbandonment,
  processWinback,
  sendSeguimientoDrip,
  syncStoreLeads,
  type LeadEnrichStats,
} from "@/lib/leads-ingest";
import { runCartSequence } from "@/lib/cart-sequence";
import type { ConversationRow, DraftOrderRow, OrderRow } from "@/lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Max conversations to fetch message-timing for per sync run (bounds API cost).
const KAPSO_TIMING_CAP = 50;

export interface StoreCreds {
  id: string;
  org_id: string;
  name: string;
  shopify_domain: string;
  shopify_token: string | null;
  shopify_webhook_secret: string | null;
  kapso_project_id: string | null;
  kapso_api_key: string | null;
  flow_webhook_secret: string | null;
  kapso_webhook_secret: string | null;
  whatsapp_phone_number_id: string | null;
  currency: string;
  timezone: string;
  status: string;
  browse_template_enabled: boolean;
  browse_template_name: string | null;
  browse_template_language: string | null;
  winback_template_enabled: boolean;
  winback_template_name: string | null;
  winback_template_language: string | null;
  drip_template_enabled: boolean;
  drip_template_name: string | null;
  drip_template_language: string | null;
  cart_seq_enabled: boolean;
  cart_seq_template_1_name: string | null;
  cart_seq_template_1_language: string | null;
  cart_seq_template_2_name: string | null;
  cart_seq_template_2_language: string | null;
  cart_seq_hours_1: number;
  cart_seq_hours_2: number;
  cart_seq_hour_start: number;
  cart_seq_hour_end: number;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
  meta_access_token: string | null;
  /** API key de Anthropic de ESTA tienda; null = usa la del entorno. */
  anthropic_api_key: string | null;
  anthropic_model: string | null;
  /** Token de la API de integración de Aliclik (0054). */
  aliclik_api_token: string | null;
  /** Secreto del webhook de Aliclik: su API no firma las notificaciones. */
  aliclik_webhook_secret: string | null;
  /** Interruptor por tienda de la creación de guías. */
  aliclik_enabled: boolean;
  meta_ad_accounts: StoreMetaAdAccount[];
}

/** Load a store row and decrypt its credentials (service-role only). */
export async function getStoreCreds(
  storeId: string,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<StoreCreds | null> {
  const { data, error } = await admin
    .from("stores")
    .select("*")
    .eq("id", storeId)
    .single();
  if (error || !data) return null;
  return {
    id: data.id,
    org_id: data.org_id,
    name: data.name,
    shopify_domain: data.shopify_domain,
    shopify_token: decryptOrNull(data.shopify_token_enc),
    shopify_webhook_secret: decryptOrNull(data.shopify_webhook_secret_enc),
    kapso_project_id: data.kapso_project_id ?? null,
    kapso_api_key: decryptOrNull(data.kapso_api_key_enc),
    flow_webhook_secret: decryptOrNull(data.flow_webhook_secret_enc),
    kapso_webhook_secret: decryptOrNull(data.kapso_webhook_secret_enc),
    whatsapp_phone_number_id: data.whatsapp_phone_number_id ?? null,
    currency: data.currency ?? "PEN",
    timezone: data.timezone ?? "America/Lima",
    status: data.status ?? "active",
    browse_template_enabled: data.browse_template_enabled ?? false,
    browse_template_name: data.browse_template_name ?? null,
    browse_template_language: data.browse_template_language ?? null,
    winback_template_enabled: data.winback_template_enabled ?? false,
    winback_template_name: data.winback_template_name ?? null,
    winback_template_language: data.winback_template_language ?? null,
    // Pre-0035 las columnas no existen (select * → undefined) ⇒ drip apagado.
    drip_template_enabled: data.drip_template_enabled ?? false,
    drip_template_name: data.drip_template_name ?? null,
    drip_template_language: data.drip_template_language ?? null,
    // Pre-0040 ⇒ secuencia de carritos apagada, defaults espejo de la migración.
    cart_seq_enabled: data.cart_seq_enabled ?? false,
    cart_seq_template_1_name: data.cart_seq_template_1_name ?? null,
    cart_seq_template_1_language: data.cart_seq_template_1_language ?? null,
    cart_seq_template_2_name: data.cart_seq_template_2_name ?? null,
    cart_seq_template_2_language: data.cart_seq_template_2_language ?? null,
    cart_seq_hours_1: data.cart_seq_hours_1 ?? 3,
    cart_seq_hours_2: data.cart_seq_hours_2 ?? 24,
    cart_seq_hour_start: data.cart_seq_hour_start ?? 8,
    cart_seq_hour_end: data.cart_seq_hour_end ?? 21,
    telegram_bot_token: decryptOrNull(data.telegram_bot_token_enc),
    telegram_chat_id: data.telegram_chat_id ?? null,
    meta_access_token: decryptOrNull(data.meta_access_token_enc),
    // Pre-0052 la columna no existe (select * → undefined) ⇒ se usa la clave del
    // entorno como respaldo, que es el comportamiento anterior.
    anthropic_api_key: decryptOrNull(data.anthropic_api_key_enc),
    anthropic_model: data.anthropic_model ?? null,
    // Pre-0054 las columnas no existen (select * → undefined) ⇒ integración
    // apagada, que es exactamente el comportamiento anterior.
    aliclik_api_token: decryptOrNull(data.aliclik_api_token_enc),
    aliclik_webhook_secret: decryptOrNull(data.aliclik_webhook_secret_enc),
    aliclik_enabled: data.aliclik_enabled ?? false,
    meta_ad_accounts: normalizeMetaAdAccounts(
      data.meta_ad_accounts,
      data.meta_ad_account_id,
      data.meta_ad_account_name,
    ),
  };
}

/** Map a Kapso phone-number record → a `whatsapp_numbers` label row. `kind` is
 *  normalized to our 'api' | 'business' | 'sandbox' vocabulary: a sandbox number
 *  stays sandbox; a coexistence (Business app) number is 'business'; anything
 *  else on Cloud API is 'api'. */
export function mapKapsoNumber(
  n: KapsoPhoneNumber,
): { phone_number_id: string; name: string | null; display_phone: string | null; kind: string } | null {
  const id = n.phone_number_id ? String(n.phone_number_id) : null;
  if (!id) return null;
  const kind = n.kind === "sandbox" ? "sandbox" : n.is_coexistence ? "business" : "api";
  return {
    phone_number_id: id,
    name: n.name ?? n.verified_name ?? n.display_name ?? null,
    display_phone: n.display_phone_number ?? null,
    kind,
  };
}

/** Auto-populate the `whatsapp_numbers` label lookup from Kapso (one upsert per
 *  number, keyed by phone_number_id). Returns how many were written. Best-effort:
 *  the caller swallows errors so a label refresh never fails the sync. */
export async function upsertWhatsappNumbers(
  admin: SupabaseClient,
  numbers: KapsoPhoneNumber[],
): Promise<number> {
  const rows = numbers.map(mapKapsoNumber).filter((r): r is NonNullable<typeof r> => r !== null);
  if (!rows.length) return 0;
  const { error } = await admin
    .from("whatsapp_numbers")
    .upsert(
      rows.map((r) => ({ ...r, fetched_at: new Date().toISOString() })),
      { onConflict: "phone_number_id" },
    );
  if (error) throw new Error(`upsertWhatsappNumbers: ${error.message}`);
  return rows.length;
}

export async function upsertOrders(
  admin: SupabaseClient,
  rows: OrderRow[],
): Promise<void> {
  if (!rows.length) return;
  const { error } = await admin
    .from("orders")
    .upsert(rows, { onConflict: "store_id,shopify_order_id" });
  if (!error) return;
  // `discount_codes` is added by migration 0030; before it runs, writing that
  // column errors and would break the whole order sync. Drop it and retry once
  // so the sync keeps working — attribution just misses coupons until migrated.
  if (/discount_codes/.test(error.message)) {
    const stripped = rows.map(({ discount_codes: _drop, ...rest }) => rest);
    const retry = await admin
      .from("orders")
      .upsert(stripped, { onConflict: "store_id,shopify_order_id" });
    if (!retry.error) return;
    throw new Error(`upsertOrders: ${retry.error.message}`);
  }
  throw new Error(`upsertOrders: ${error.message}`);
}

export async function upsertDraftOrders(
  admin: SupabaseClient,
  rows: DraftOrderRow[],
): Promise<void> {
  if (!rows.length) return;
  const { error } = await admin
    .from("draft_orders")
    .upsert(rows, { onConflict: "store_id,shopify_draft_order_id" });
  if (error) throw new Error(`upsertDraftOrders: ${error.message}`);
}

export async function upsertConversations(
  admin: SupabaseClient,
  rows: ConversationRow[],
): Promise<void> {
  if (!rows.length) return;
  const { error } = await admin
    .from("conversations")
    .upsert(rows, { onConflict: "store_id,kapso_conversation_id" });
  if (error) throw new Error(`upsertConversations: ${error.message}`);
}

export async function recomputeRollups(
  admin: SupabaseClient,
  storeId: string,
  from: string,
  to: string,
): Promise<void> {
  const { error } = await admin.rpc("recompute_daily_rollups", {
    p_store_id: storeId,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(`recompute_daily_rollups: ${error.message}`);
}

async function getSyncCursor(
  admin: SupabaseClient,
  storeId: string,
  source: string,
): Promise<string | null> {
  const { data } = await admin
    .from("sync_state")
    .select("cursor")
    .match({ store_id: storeId, source })
    .maybeSingle();
  return data?.cursor ?? null;
}

async function setSyncState(
  admin: SupabaseClient,
  storeId: string,
  source: string,
  cursor: string | null,
  status: string,
  error?: string,
): Promise<void> {
  await admin.from("sync_state").upsert(
    {
      store_id: storeId,
      source,
      cursor,
      last_run_at: new Date().toISOString(),
      status,
      error: error ?? null,
    },
    { onConflict: "store_id,source" },
  );
}

// Rango de días con rollup pendiente de recalcular, guardado en `sync_state`
// bajo una fuente sintética (no hace falta migración: la tabla ya está indexada
// por store_id + source).
//
// POR QUÉ HACE FALTA. Las fechas afectadas por una corrida vivían solo en
// memoria (`affectedDates`). Mientras el cursor de Shopify se guardaba de una
// vez al final del bucle, eso era seguro por accidente: si la corrida moría a
// media, el cursor no había avanzado, la siguiente volvía a traer los mismos
// pedidos y las fechas se recalculaban solas.
//
// Al guardar el cursor página a página esa red desaparece: el cursor avanza,
// pero si la corrida muere antes de llegar al rollup, esos días se quedan con
// métricas viejas y nadie los vuelve a mirar. Así que las fechas pendientes
// pasan a ser durables, igual que el cursor.
const ROLLUP_PENDING_SOURCE = "rollup_pending";

/** Serializa/parsea el rango como `desde..hasta` (dos fechas `YYYY-MM-DD`). */
export function parseRollupPending(cursor: string | null): { from: string; to: string } | null {
  if (!cursor) return null;
  const [from, to] = cursor.split("..");
  return from && to ? { from, to } : null;
}

/** Une un conjunto de fechas con el rango pendiente y devuelve el rango nuevo. */
export function widenRollupPending(
  current: { from: string; to: string } | null,
  dates: string[],
): { from: string; to: string } | null {
  const all = [...dates, ...(current ? [current.from, current.to] : [])].filter(Boolean).sort();
  if (!all.length) return null;
  return { from: all[0]!, to: all[all.length - 1]! };
}

async function getRollupPending(
  admin: SupabaseClient,
  storeId: string,
): Promise<{ from: string; to: string } | null> {
  return parseRollupPending(await getSyncCursor(admin, storeId, ROLLUP_PENDING_SOURCE));
}

async function setRollupPending(
  admin: SupabaseClient,
  storeId: string,
  range: { from: string; to: string } | null,
): Promise<void> {
  await setSyncState(admin, storeId, ROLLUP_PENDING_SOURCE, range ? `${range.from}..${range.to}` : null, "ok");
}

// ---------------------------------------------------------------------------
// Webhook processing (HMAC + idempotency)
// ---------------------------------------------------------------------------

export type WebhookStatus = "ok" | "duplicate" | "unauthorized" | "error";
export interface WebhookResult {
  status: WebhookStatus;
  message?: string;
}

export interface ProcessWebhookParams {
  storeId: string;
  topic: string;
  rawBody: string;
  hmacHeader: string | null;
  webhookIdHeader?: string | null;
}

/**
 * Verify a Shopify webhook (HMAC), parse it, then route by topic: orders/* →
 * processOrderWebhook (upsert kapso order, recompute the day, link won);
 * draft_orders/* → processDraftOrderWebhook (upsert draft, (re)link the cart
 * lead). Idempotent: re-delivering the same webhook (same X-Shopify-Webhook-Id,
 * or identical body) is a no-op returning "duplicate".
 */
export async function processShopifyWebhook(
  params: ProcessWebhookParams,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<WebhookResult> {
  const creds = await getStoreCreds(params.storeId, admin);
  if (!creds) return { status: "error", message: "unknown store" };

  if (!verifyShopifyHmac(params.rawBody, params.hmacHeader, creds.shopify_webhook_secret)) {
    return { status: "unauthorized" };
  }

  const webhookId =
    params.webhookIdHeader ||
    createHash("sha256").update(params.rawBody, "utf8").digest("hex");

  let payload: any;
  try {
    payload = JSON.parse(params.rawBody);
  } catch {
    return { status: "error", message: "invalid json" };
  }

  // Route by topic. Order topics (orders/*) and draft topics (draft_orders/*)
  // share the HMAC/idempotency/JSON prefix above, then diverge.
  return params.topic.startsWith("draft_orders/")
    ? processDraftOrderWebhook(admin, creds, params, payload, webhookId)
    : processOrderWebhook(admin, creds, params, payload, webhookId);
}

export interface FlowWebhookParams {
  storeId: string;
  secretHeader: string | null;
  rawBody: string;
}

/** Constant-time compare of the X-RecoverOps-Secret header vs the store secret. */
function verifyFlowSecret(provided: string | null | undefined, expected: string | null): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Best-effort: record a REJECTED Flow webhook (bad secret / bad payload) in
 *  `webhook_events` so it shows in the store's webhook log — invaluable for
 *  debugging a 401/400 without guessing. Deduped by a body hash so a retried bad
 *  request doesn't pile up. (Logs unauthenticated POSTs to a valid store's flow
 *  URL; acceptable since the storeId is semi-secret.) Never throws. */
async function recordFlowRejection(
  admin: SupabaseClient,
  storeId: string,
  rawBody: string,
  topic: string,
  error: string,
): Promise<void> {
  try {
    const webhookId = "rej-" + createHash("sha256").update(rawBody, "utf8").digest("hex").slice(0, 40);
    await admin
      .from("webhook_events")
      .insert({ store_id: storeId, topic, shopify_id: null, webhook_id: webhookId, processed: false, error });
  } catch {
    /* logging is best-effort — never let it affect the webhook response */
  }
}

/**
 * Authenticate + route an inbound Shopify Flow webhook (shared per-store secret
 * in the X-RecoverOps-Secret header). Routes by `body.source`:
 * `abandoned_browse` (Búsquedas abandonadas) → processBrowseAbandonment;
 * `winback` (Recuperación de clientes 60d) → processWinback. Unknown sources
 * are accepted (no Flow retry) and ignored — extensible to more events.
 */
export async function processFlowWebhook(
  params: FlowWebhookParams,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<WebhookResult> {
  const creds = await getStoreCreds(params.storeId, admin);
  if (!creds) return { status: "error", message: "unknown store" };
  if (!verifyFlowSecret(params.secretHeader, creds.flow_webhook_secret)) {
    await recordFlowRejection(
      admin,
      params.storeId,
      params.rawBody,
      "flow/unauthorized",
      "Secreto X-RecoverOps-Secret inválido o ausente",
    );
    return { status: "unauthorized" };
  }

  let payload: any;
  try {
    payload = JSON.parse(params.rawBody);
  } catch {
    await recordFlowRejection(admin, params.storeId, params.rawBody, "flow/bad_request", "El body no es JSON válido");
    return { status: "error", message: "invalid json" };
  }

  if (String(payload?.source ?? "") === "abandoned_browse") {
    return processBrowseAbandonment(admin, params.storeId, payload, creds);
  }
  if (String(payload?.source ?? "") === "winback") {
    return processWinback(admin, params.storeId, payload, creds);
  }
  return { status: "ok" }; // unknown Flow source — accept + ignore
}

// ---------------------------------------------------------------------------
// Kapso webhook (per-store secret + tenant isolation)
// ---------------------------------------------------------------------------

export interface KapsoWebhookParams {
  storeId: string;
  /** Secret from the `?secret=` query param on the webhook URL. */
  providedSecret: string | null;
  /** The `X-Webhook-Event` header (used to classify the event). */
  eventHeader: string | null;
  body: any;
}

export interface KapsoWebhookResult {
  status: "ok" | "unauthorized";
  kind?: string;
  reason?: string;
}

/** Constant-time string compare (equal-length gate first, then timingSafeEqual). */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Authorize a Kapso webhook call. A store's OWN secret is authoritative: once
 * `perStoreSecret` is set, only it is accepted (the shared CRON_SECRET no longer
 * authorizes writes to that store, closing the cross-tenant injection hole).
 * Stores that have not set a per-store secret yet fall back to `cronSecret` so
 * existing wiring keeps working during migration. Pure + unit-tested.
 */
export function authorizeKapsoWebhook(
  provided: string | null | undefined,
  perStoreSecret: string | null,
  cronSecret: string | null,
): boolean {
  const expected = perStoreSecret ?? cronSecret;
  if (!expected || !provided) return false;
  return constantTimeEquals(provided, expected);
}

/**
 * Authenticate + dispatch an inbound Kapso webhook for a single store. Loads the
 * store's per-store secret, authorizes (see authorizeKapsoWebhook), then routes:
 * a Platform `workflow.execution.handoff` → hot lead; a WhatsApp
 * `conversation.ended/inactive` → abandono lead; message events are acked and
 * ignored. All writes are scoped to `storeId` by the callees.
 */
/**
 * Load a store and authorize a Kapso webhook request against its per-store
 * secret (with the CRON_SECRET fallback). Returns the decrypted creds when the
 * caller is authorized, or null when the store is unknown OR the secret is
 * wrong — callers must not distinguish the two (no store enumeration). Shared by
 * the POST handler and the GET validation ping.
 */
export async function authorizeKapsoRequest(
  storeId: string,
  providedSecret: string | null,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<StoreCreds | null> {
  const creds = await getStoreCreds(storeId, admin);
  if (!creds) return null;
  // Only need the shared CRON_SECRET as a fallback when this store has no secret
  // of its own; read it lazily so a per-store-secured store works even without
  // CRON_SECRET configured.
  let cronSecret: string | null = null;
  if (!creds.kapso_webhook_secret) {
    try {
      cronSecret = env.cronSecret();
    } catch {
      cronSecret = null;
    }
  }
  return authorizeKapsoWebhook(providedSecret, creds.kapso_webhook_secret, cronSecret) ? creds : null;
}

export async function processKapsoWebhook(
  params: KapsoWebhookParams,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<KapsoWebhookResult> {
  const creds = await authorizeKapsoRequest(params.storeId, params.providedSecret, admin);
  // Unknown store OR bad secret → unauthorized (don't reveal which).
  if (!creds) return { status: "unauthorized" };

  const kind = classifyKapsoEvent(params.eventHeader, params.body);
  if (kind === "handoff") {
    const res = await applyHandoff(admin, params.storeId, params.body);
    return { status: "ok", kind, reason: res.reason };
  }
  if (kind === "conversation") {
    const res = await ingestConversationEvent(admin, params.storeId, params.body);
    return { status: "ok", kind, reason: res.reason };
  }
  if (kind === "message_status") {
    const events = parseWhatsappStatusEvents(params.body, params.eventHeader);
    const updated = await applyWhatsappStatusEvents(admin, params.storeId, events);
    return { status: "ok", kind, reason: `statuses:${events.length};updated:${updated}` };
  }
  return { status: "ok", kind, reason: "skipped" };
}

/** orders/create|updated → upsert the kapso order, recompute the day, link won. */
async function processOrderWebhook(
  admin: SupabaseClient,
  creds: StoreCreds,
  params: ProcessWebhookParams,
  payload: any,
  webhookId: string,
): Promise<WebhookResult> {
  const row = mapRestOrder(payload, params.storeId);

  // Shopify dispara los webhooks de pedidos para TODA la tienda. El Master de
  // Pedidos necesita ese universo completo (§1: "todos los pedidos gestionados
  // por las dos tiendas"), así que ya no se descartan los que no llevan
  // `tag:kapso` — se ingestan igual.
  //
  // Lo que sigue siendo exclusivo de los pedidos del bot son los EFECTOS: los
  // rollups y el vínculo con el lead. Las métricas de ventas/embudo se calculan
  // sobre tag:kapso en `recompute_daily_rollups` y en lib/access.ts:getOrders,
  // así que ampliar la ingesta no mueve ninguna cifra histórica.
  const isKapsoOrder = hasKapsoTag(row.tags);

  const orderId = payload?.id != null ? String(payload.id) : null;

  // Idempotency: the unique (store_id, webhook_id) guards against re-delivery.
  const { error: insErr } = await admin.from("webhook_events").insert({
    store_id: params.storeId,
    topic: params.topic,
    shopify_id: orderId,
    webhook_id: webhookId,
    processed: false,
  });
  if (insErr) {
    if ((insErr as any).code === "23505") return { status: "duplicate" };
    throw new Error(`webhook_events insert: ${insErr.message}`);
  }

  await upsertOrders(admin, [row]);

  if (isKapsoOrder && row.created_at) {
    const { date } = tzParts(row.created_at, creds.timezone);
    await recomputeRollups(admin, params.storeId, date, date);
  }

  // Link the order to its lead (won), best-effort.
  if (isKapsoOrder && row.customer_phone) {
    try {
      const { data: ord } = await admin
        .from("orders")
        .select("id")
        .eq("store_id", params.storeId)
        .eq("shopify_order_id", row.shopify_order_id)
        .maybeSingle();
      // Don't override a registered call result with an order that predates it.
      const dispAt = await lastDispositionAtByPhone(admin, params.storeId, [row.customer_phone]);
      await linkOrderToLead(admin, {
        storeId: params.storeId,
        phone: row.customer_phone,
        orderId: ord?.id ?? null,
        win: eventOverridesDisposition(row.created_at, dispAt.get(row.customer_phone)),
      });
    } catch {
      /* best-effort */
    }
  }

  // El pedido acaba de entrar o cambiar (incluida una anulación en Shopify, que
  // es la fuente principal del estado Anulado — §3.4): refresca su fila del Master.
  try {
    const { data: ord } = await admin
      .from("orders")
      .select("id")
      .eq("store_id", params.storeId)
      .eq("shopify_order_id", row.shopify_order_id)
      .maybeSingle();
    if (ord?.id) await recomputeOrderMasterSafe(admin, [ord.id as string]);
  } catch {
    /* best-effort: el barrido del cron lo pondrá al día */
  }

  await admin
    .from("webhook_events")
    .update({ processed: true })
    .match({ store_id: params.storeId, webhook_id: webhookId });

  return { status: "ok" };
}

/**
 * draft_orders/create|update|delete → upsert the draft + (re)link its lead. NO
 * tag:kapso filter (the Releasit COD form isn't the bot) — isCodFormDraft inside
 * linkDraftOrdersToLeads decides. delete: drop the row + clear the lead's cart
 * fields, but keep the lead (don't auto-lose it).
 */
async function processDraftOrderWebhook(
  admin: SupabaseClient,
  creds: StoreCreds,
  params: ProcessWebhookParams,
  payload: any,
  webhookId: string,
): Promise<WebhookResult> {
  const draftId = payload?.id != null ? String(payload.id) : null;

  const { error: insErr } = await admin.from("webhook_events").insert({
    store_id: params.storeId,
    topic: params.topic,
    shopify_id: draftId,
    webhook_id: webhookId,
    processed: false,
  });
  if (insErr) {
    if ((insErr as any).code === "23505") return { status: "duplicate" };
    throw new Error(`webhook_events insert: ${insErr.message}`);
  }

  if (params.topic === "draft_orders/delete") {
    if (draftId) {
      await admin
        .from("draft_orders")
        .delete()
        .match({ store_id: params.storeId, shopify_draft_order_id: draftId });
      // Clear the cart signals (only 0007 columns, always present) so the lead
      // drops out of "Con carrito"; keep the lead row itself.
      const gid = payload?.admin_graphql_api_id ?? `gid://shopify/DraftOrder/${draftId}`;
      await admin
        .from("leads")
        .update({ draft_order_gid: null, cart_value: null, cart_item_count: null, cart_summary: null })
        .eq("store_id", params.storeId)
        .eq("draft_order_gid", gid);
    }
  } else {
    const row = mapRestDraftOrder(payload, params.storeId);
    await upsertDraftOrders(admin, [row]);
    const shopify = creds.shopify_token ? { domain: creds.shopify_domain, token: creds.shopify_token } : undefined;
    const recovered = await linkDraftOrdersToLeads(admin, params.storeId, [row], shopify);
    if (recovered.length) {
      try {
        await recomputeRollups(
          admin,
          params.storeId,
          tzParts(recovered[0]!, creds.timezone).date,
          tzParts(recovered[recovered.length - 1]!, creds.timezone).date,
        );
      } catch {
        /* rollup recompute is best-effort */
      }
    }
  }

  await admin
    .from("webhook_events")
    .update({ processed: true })
    .match({ store_id: params.storeId, webhook_id: webhookId });

  return { status: "ok" };
}

// ---------------------------------------------------------------------------
// Full store sync (cron): Shopify reconciliation + Kapso pull + ops snapshot
// ---------------------------------------------------------------------------

export interface SyncReport {
  storeId: string;
  shopifyOrders: number;
  draftOrders: number;
  kapsoConversations: number;
  leads: number;
  enriched: LeadEnrichStats;
  opsCaptured: boolean;
  whatsappNumbers: number;
  archived: number;
  metaAdsResolved: number; // Meta ad_ids whose real names we resolved this run
  dripSent: number; // plantillas de seguimiento enviadas esta corrida
  cartSeqSent: number; // plantillas de carrito abandonado enviadas esta corrida
  requeued: number; // carritos reencolados con atención (olas, máx 2 por lead)
  orderMaster: number; // filas del Master reconciliadas en esta corrida
  errors: string[];
  // La corrida se quedó sin presupuesto de tiempo y dejó trabajo para la
  // siguiente pasada del cron. No es un error: el sync es incremental.
  partial: boolean;
  // Etapas que no llegaron a correr por falta de tiempo, en orden.
  skipped: string[];
}

// Resolve up to this many new/stale Meta ad_ids per run (drains a backlog over a
// few runs; keeps a run's Graph API load bounded).
const META_AD_RESOLVE_CAP = 25;
// Re-resolve a cached ad older than this so its status (ACTIVE/PAUSED) stays current.
const META_AD_STALE_DAYS = 7;

/**
 * Populate the `meta_ads` lookup with real ad / adset / campaign names so the
 * "Rendimiento por anuncio" report shows the creative name instead of the shared
 * CTWA headline ("Madera Como Nueva"). Resolves this store's meta_ad lead ad_ids
 * that aren't cached yet (or are stale) via the Meta Graph API, then upserts.
 * Best-effort; returns how many rows it resolved. Never throws.
 */
export async function resolveMetaAdNames(
  admin: SupabaseClient,
  storeId: string,
  token: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<number> {
  if (!token) return 0;
  const { data: leadAds } = await admin
    .from("leads")
    .select("ad_id")
    .eq("store_id", storeId)
    .eq("source", "meta_ad")
    .not("ad_id", "is", null)
    .limit(2000);
  const adIds = [
    ...new Set(((leadAds as { ad_id: string | null }[]) ?? []).map((l) => l.ad_id).filter((x): x is string => !!x)),
  ];
  if (!adIds.length) return 0;

  // Which are already cached AND fresh? (meta_ads is global — creative names
  // aren't store-scoped.) Missing or stale ids get (re)resolved.
  const { data: cached } = await admin.from("meta_ads").select("ad_id, fetched_at").in("ad_id", adIds);
  const staleCut = Date.now() - META_AD_STALE_DAYS * 86_400_000;
  const fresh = new Set<string>();
  for (const r of (cached as { ad_id: string; fetched_at: string | null }[]) ?? []) {
    if (r.fetched_at && new Date(r.fetched_at).getTime() > staleCut) fresh.add(r.ad_id);
  }
  const toResolve = adIds.filter((id) => !fresh.has(id)).slice(0, META_AD_RESOLVE_CAP);
  if (!toResolve.length) return 0;

  const rows = await fetchMetaAdMeta(token, toResolve, opts);
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  await admin.from("meta_ads").upsert(
    rows.map((r) => ({ ...r, fetched_at: now })),
    { onConflict: "ad_id" },
  );
  return rows.length;
}

// Coste estimado de cada etapa, en ms. No pretende ser exacto: es el margen que
// se exige ANTES de arrancarla, calibrado con lo que tarda hoy en producción y
// redondeado hacia arriba. Si no cabe, la etapa se salta y la retoma la corrida
// siguiente (el cron pasa cada 5 minutos).
const STAGE_COST_MS = {
  shopify: 45_000,
  shopifyAll: 45_000,
  drafts: 45_000,
  kapso: 45_000,
  leads: 60_000,
  followups: 10_000,
  drip: 20_000,
  cartSeq: 20_000,
  waves: 10_000,
  handoffs: 10_000,
  archive: 10_000,
  metaAds: 25_000,
  ops: 25_000,
  waNumbers: 15_000,
  rollups: 20_000,
  orderMaster: 30_000,
} as const;

// Margen exigido para pedir UNA página más a Shopify/Kapso. Cortar la
// paginación a media es seguro: las búsquedas van ordenadas por `updated_at`
// ascendente y el cursor se guarda con el máximo ya ingerido, así que la
// corrida siguiente sigue justo donde esta lo dejó.
const PAGE_COST_MS = 12_000;

// Tiempo que se aparta SIEMPRE para el cierre de la corrida, antes de repartir
// nada a la ingesta.
//
// El rollup diario no es una etapa saltable como las demás: `affectedDates` solo
// existe en memoria durante esta corrida. Si se ingieren pedidos y no se
// recalcula el rollup aquí, la corrida siguiente arranca con su propio conjunto
// de fechas y nunca vuelve a mirar las de esta — el día se quedaría con métricas
// viejas y en silencio, que es peor que ir un poco atrasado. Así que no compite
// por el presupuesto: se le guarda sitio y la ingesta se reparte lo que sobra.
const TAIL_RESERVE_MS = 50_000;

export async function runStoreSync(
  storeId: string,
  admin: SupabaseClient = createAdminSupabase(),
  opts?: { deadline?: Deadline },
): Promise<SyncReport> {
  const deadline = opts?.deadline ?? unlimitedDeadline();
  const report: SyncReport = {
    storeId,
    shopifyOrders: 0,
    draftOrders: 0,
    kapsoConversations: 0,
    leads: 0,
    enriched: { candidates: 0, fetched: 0, inbound: 0, cart: 0, district: 0, yape: 0, visionChecks: 0 },
    opsCaptured: false,
    whatsappNumbers: 0,
    archived: 0,
    metaAdsResolved: 0,
    dripSent: 0,
    cartSeqSent: 0,
    requeued: 0,
    orderMaster: 0,
    errors: [],
    partial: false,
    skipped: [],
  };
  const creds = await getStoreCreds(storeId, admin);
  if (!creds) {
    report.errors.push("unknown store");
    return report;
  }
  const affectedDates = new Set<string>();

  /**
   * ¿Hay margen para esta etapa? Si no lo hay, la anota como saltada y marca la
   * corrida como parcial, sin lanzar: cada etapa es independiente y reanudable,
   * así que quedarse sin tiempo difiere trabajo, no lo pierde.
   */
  const affords = (stage: string, costMs: number): boolean => {
    if (deadline.hasRoomFor(costMs + TAIL_RESERVE_MS)) return true;
    report.skipped.push(stage);
    report.partial = true;
    return false;
  };

  /**
   * Igual que `affords`, pero para las etapas de cierre: esas ya viven DENTRO de
   * TAIL_RESERVE_MS, así que piden solo su coste — sumarles la reserva otra vez
   * las haría saltarse a sí mismas.
   */
  const affordsTail = (stage: string, costMs: number): boolean => {
    if (deadline.hasRoomFor(costMs)) return true;
    report.skipped.push(stage);
    report.partial = true;
    return false;
  };

  /** ¿Cabe otra página de la API? Marca parcial si obliga a cortar. */
  const affordsPage = (): boolean => {
    if (deadline.hasRoomFor(PAGE_COST_MS + TAIL_RESERVE_MS)) return true;
    report.partial = true;
    return false;
  };

  // 1) Shopify reconciliation (tag:kapso, bounded by updated_at cursor)
  if (creds.shopify_token && affords("shopify", STAGE_COST_MS.shopify)) {
    // Fuera del try: el catch necesita saber hasta dónde se llegó para no tirar
    // el avance (ver abajo).
    let maxUpdatedAt = await getSyncCursor(admin, storeId, "shopify");
    try {
      const searchQuery = buildKapsoOrdersSearchQuery(maxUpdatedAt);
      let after: string | null = null;
      let pending = await getRollupPending(admin, storeId);
      for (let i = 0; i < 50; i++) {
        if (!affordsPage()) break;
        const page = await fetchOrdersPage({
          domain: creds.shopify_domain,
          token: creds.shopify_token,
          storeId,
          searchQuery,
          after,
        });
        const pageDates: string[] = [];
        if (page.orders.length) {
          await upsertOrders(admin, page.orders);
          await linkOrdersToLeads(admin, storeId, page.orders); // order → lead (won)
          report.shopifyOrders += page.orders.length;
          for (const o of page.orders) {
            if (!o.created_at) continue;
            const d = tzParts(o.created_at, creds.timezone).date;
            affectedDates.add(d);
            pageDates.push(d);
          }
        }
        if (page.maxUpdatedAt && (!maxUpdatedAt || page.maxUpdatedAt > maxUpdatedAt)) {
          maxUpdatedAt = page.maxUpdatedAt;
        }

        // Punto de guardado de la página. El orden importa y es este a
        // propósito: los pedidos ya están escritos (upsert idempotente), luego
        // se anota el rollup pendiente y solo al final avanza el cursor. Morir
        // entre medias siempre deja trabajo repetido, nunca trabajo perdido.
        const widened = widenRollupPending(pending, pageDates);
        if (widened && (widened.from !== pending?.from || widened.to !== pending?.to)) {
          await setRollupPending(admin, storeId, widened);
          pending = widened;
        }
        await setSyncState(admin, storeId, "shopify", maxUpdatedAt, "ok");

        if (!page.hasNextPage) break;
        after = page.endCursor;
      }
    } catch (e: any) {
      report.errors.push(`shopify: ${e.message}`);
      // Se conserva el cursor, NO se pone a null. Ponerlo a null convertía
      // cualquier error pasajero de Shopify en un re-escaneo completo del
      // histórico con tag:kapso en la corrida siguiente — lento, y capaz de
      // dejar sin tiempo a todo lo demás.
      await setSyncState(admin, storeId, "shopify", maxUpdatedAt, "error", e.message);
    }
  }

  // 1a-bis) Reconciliación SIN filtro de tag, para el Master de Pedidos.
  //     Segunda pasada con su propio cursor (`shopify_all`) para no interferir
  //     con el de la pasada tag:kapso. Trae el resto de pedidos de la tienda —
  //     los del formulario web/COD, los creados a mano — que el Master necesita
  //     y que las métricas siguen sin contar (filtran por tag:kapso).
  //     Acotada por ORDERS_SYNC_FROM para no arrastrar años de histórico.
  //     try/catch propio: si esta pasada falla, la sincronización del bot y de
  //     los leads sigue funcionando igual.
  if (creds.shopify_token && affords("shopify_all", STAGE_COST_MS.shopifyAll)) {
    // Fuera del try, igual que en la pasada anterior: el catch conserva el avance.
    let maxUpdatedAt = await getSyncCursor(admin, storeId, "shopify_all");
    try {
      const searchQuery = buildAllOrdersSearchQuery(maxUpdatedAt, env.ordersSyncFrom());
      let after: string | null = null;
      const touched: string[] = [];
      for (let i = 0; i < 50; i++) {
        if (!affordsPage()) break;
        const page = await fetchOrdersPage({
          domain: creds.shopify_domain,
          token: creds.shopify_token,
          storeId,
          searchQuery,
          after,
        });
        if (page.orders.length) {
          await upsertOrders(admin, page.orders);
          report.shopifyOrders += page.orders.length;
          for (const o of page.orders) touched.push(o.shopify_order_id);
        }
        if (page.maxUpdatedAt && (!maxUpdatedAt || page.maxUpdatedAt > maxUpdatedAt)) {
          maxUpdatedAt = page.maxUpdatedAt;
        }
        // Esta pasada no alimenta rollups (solo el Master, que se reconcilia
        // leyendo la base), así que el punto de guardado es solo el cursor.
        await setSyncState(admin, storeId, "shopify_all", maxUpdatedAt, "ok");
        if (!page.hasNextPage) break;
        after = page.endCursor;
      }
      // Refresca el Master para los pedidos que acaba de tocar esta pasada.
      for (const batch of chunk(touched, 200)) {
        const { data } = await admin
          .from("orders")
          .select("id")
          .eq("store_id", storeId)
          .in("shopify_order_id", batch);
        await recomputeOrderMasterSafe(
          admin,
          ((data ?? []) as { id: string }[]).map((r) => r.id),
        );
      }
    } catch (e: any) {
      report.errors.push(`shopify_all: ${e.message}`);
      // Se conserva el cursor: ver la nota de la pasada tag:kapso. Aquí importa
      // aún más, porque sin cursor la búsqueda arranca en ORDERS_SYNC_FROM y
      // arrastra todo el histórico de la tienda.
      await setSyncState(admin, storeId, "shopify_all", maxUpdatedAt, "error", e.message);
    }
  }

  // 1b) Shopify draft orders (Releasit COD carts → "Con carrito" leads).
  //     Re-scan the whole DRAFT_OPEN_WINDOW_DAYS window EVERY run (not incremental):
  //     a cart created fresh is held back by the grace period in
  //     linkDraftOrdersToLeads, and re-scanning is what promotes it to a lead once
  //     it ages past the grace. The window is small (a couple of days) so a full
  //     rescan is cheap. Own try/catch: a missing read_draft_orders scope just
  //     records an error here and never breaks the orders/Kapso/leads sync.
  if (creds.shopify_token && affords("shopify_drafts", STAGE_COST_MS.drafts)) {
    try {
      const floor = new Date(Date.now() - DRAFT_OPEN_WINDOW_DAYS * 86_400_000).toISOString();
      let maxUpdatedAt: string | null = null;
      let pending = await getRollupPending(admin, storeId);
      for (const status of ["open", "completed"] as const) {
        const searchQuery = buildDraftOrdersSearchQuery(status, floor);
        let after: string | null = null;
        for (let i = 0; i < 50; i++) {
          if (!affordsPage()) break;
          const page = await fetchDraftOrdersPage({
            domain: creds.shopify_domain,
            token: creds.shopify_token,
            storeId,
            searchQuery,
            after,
          });
          const pageDates: string[] = [];
          if (page.draftOrders.length) {
            await upsertDraftOrders(admin, page.draftOrders);
            // Capture COD-recovered orders (not tag:kapso) so their revenue counts;
            // their dates feed the daily-rollup recompute below.
            const recovered = await linkDraftOrdersToLeads(admin, storeId, page.draftOrders, {
              domain: creds.shopify_domain,
              token: creds.shopify_token,
            });
            for (const iso of recovered) {
              const d = tzParts(iso, creds.timezone).date;
              affectedDates.add(d);
              pageDates.push(d);
            }
            report.draftOrders += page.draftOrders.length;
          }
          if (page.maxUpdatedAt && (!maxUpdatedAt || page.maxUpdatedAt > maxUpdatedAt)) {
            maxUpdatedAt = page.maxUpdatedAt;
          }
          // Estas fechas se anotan como pendientes aunque esta pasada reescanee
          // la ventana entera: un borrador ya enlazado NO vuelve a salir en
          // `recovered`, así que si la corrida muere antes del rollup, un
          // reescaneo no las recupera. El cursor de esta pasada, en cambio, no
          // se guarda por página porque no se usa como filtro (la búsqueda va
          // por `floor`): guardarlo antes no adelantaría nada.
          const widened = widenRollupPending(pending, pageDates);
          if (widened && (widened.from !== pending?.from || widened.to !== pending?.to)) {
            await setRollupPending(admin, storeId, widened);
            pending = widened;
          }
          if (!page.hasNextPage) break;
          after = page.endCursor;
        }
      }
      await setSyncState(admin, storeId, "shopify_drafts", maxUpdatedAt, "ok");
    } catch (e: any) {
      report.errors.push(`shopify_drafts: ${e.message}`);
      await setSyncState(admin, storeId, "shopify_drafts", null, "error", e.message);
    }
  }

  // 2) Kapso pull (conversations since last_active cursor)
  if (creds.kapso_api_key && affords("kapso", STAGE_COST_MS.kapso)) {
    // Fuera del try: el catch conserva el avance en vez de tirarlo.
    let maxTs = await getSyncCursor(admin, storeId, "kapso");
    try {
      const k = { apiKey: creds.kapso_api_key };
      const cursor = maxTs;
      const convs = await listAllConversations(k, {
        // All of the store's WhatsApp numbers (not just the send-from number) —
        // see the note in syncStoreLeads. Keeps both API + Business numbers synced.
        lastActiveAfter: cursor ?? undefined,
      });
      const rows = convs.map((c) => mapKapsoConversation(c, storeId));
      await upsertConversations(admin, rows);
      report.kapsoConversations = rows.length;
      // Best-effort: capture first-response timing for a bounded number of
      // conversations (one message page each). Written as a separate guarded
      // update so it tolerates the timing columns not existing yet (i.e. if the
      // code deploys before migration 0005 is applied) without breaking sync.
      for (const r of rows.slice(0, KAPSO_TIMING_CAP)) {
        // Hasta 50 llamadas en serie: es la parte más cara de esta etapa y la
        // más prescindible (el timing es enriquecimiento, no dato de negocio).
        if (!affordsPage()) break;
        const t = await fetchConversationSignals(k, r.kapso_conversation_id);
        if (!t) continue;
        const { error: tErr } = await admin
          .from("conversations")
          .update({ inbound_count: t.inbound_count, first_response_seconds: t.first_response_seconds })
          .eq("store_id", storeId)
          .eq("kapso_conversation_id", r.kapso_conversation_id);
        if (tErr) break; // columns missing (migration pending) or transient — stop this run
      }

      const convDates: string[] = [];
      for (const r of rows) {
        const ts = r.last_message_at ?? r.started_at;
        if (ts && (!maxTs || ts > maxTs)) maxTs = ts;
        if (r.started_at) {
          const d = tzParts(r.started_at, creds.timezone).date;
          affectedDates.add(d);
          convDates.push(d);
        }
      }
      // Durable antes de avanzar el cursor, por el mismo motivo que en Shopify:
      // pasado este punto, morir antes del rollup dejaría estos días sin
      // recalcular y sin nadie que vuelva a mirarlos.
      const widened = widenRollupPending(await getRollupPending(admin, storeId), convDates);
      if (widened) await setRollupPending(admin, storeId, widened);
      await setSyncState(admin, storeId, "kapso", maxTs, "ok");
    } catch (e: any) {
      report.errors.push(`kapso: ${e.message}`);
      // Se conserva el cursor: sin él, `lastActiveAfter` queda vacío y la
      // corrida siguiente se trae TODAS las conversaciones de la tienda.
      await setSyncState(admin, storeId, "kapso", maxTs, "error", e.message);
    }
  }

  // 2b) Leads — build/refresh from conversations + order linkage.
  if (creds.kapso_api_key && affords("leads", STAGE_COST_MS.leads)) {
    try {
      const lr = await syncStoreLeads(admin, storeId, {
        kapso_api_key: creds.kapso_api_key,
        whatsapp_phone_number_id: creds.whatsapp_phone_number_id,
      });
      report.leads = lr.touched;
      report.enriched = lr.enriched;
    } catch (e: any) {
      report.errors.push(`leads: ${e.message}`);
    }
  }

  // 2c) Bubble overdue follow-ups back up (needs_attention) so they don't slip.
  if (affords("followups", STAGE_COST_MS.followups)) {
    try {
      await flagOverdueFollowups(admin, storeId);
    } catch (e: any) {
      report.errors.push(`followups: ${e.message}`);
    }
  }

  // 2c.5) Drip de seguimiento: plantilla WhatsApp a leads nr/buzón/cuelga sin
  //       respuesta (máx 2 toques, horario laboral). Va DESPUÉS de 2c a
  //       propósito: un seguimiento manual vencido acaba de ganar
  //       needs_attention=true y el drip lo respeta (la asesora manda sobre el
  //       bot). Gateado por Ajustes; best-effort.
  if (creds.drip_template_enabled && affords("drip", STAGE_COST_MS.drip)) {
    try {
      const drip = await sendSeguimientoDrip(admin, storeId, creds);
      report.dripSent = drip.sent;
      if (drip.failed) report.errors.push(`drip: ${drip.failed} envíos fallidos`);
    } catch (e: any) {
      report.errors.push(`drip: ${e.message}`);
    }
  }

  // 2c.55) Secuencia de carritos abandonados: 2 plantillas ancladas a la
  //        creación del carrito (+3h/+24h configurables, horario local). Canal
  //        independiente del drip y de la gestión humana: solo-envío, nunca
  //        toca status/category (ver lib/cart-sequence.ts). Gateado por
  //        Ajustes; best-effort. Pre-0040 es un no-op (enabled=false).
  if (creds.cart_seq_enabled && affords("cart_seq", STAGE_COST_MS.cartSeq)) {
    try {
      const seq = await runCartSequence(admin, storeId, creds);
      report.cartSeqSent = seq.sent;
      if (seq.failed) report.errors.push(`cart_seq: ${seq.failed} envíos fallidos`);
    } catch (e: any) {
      report.errors.push(`cart_seq: ${e.message}`);
    }
  }

  // 2c.6) Olas de reencolado: carritos en nr/buzón/cuelga quietos 48h suben con
  //       needs_attention (máx 2 olas por lead) para que la llamada de
  //       recontacto no se pase. Pre-0036 es un no-op. Best-effort.
  if (affords("waves", STAGE_COST_MS.waves)) {
    try {
      report.requeued = await flagCartAttentionWaves(admin, storeId);
    } catch (e: any) {
      report.errors.push(`waves: ${e.message}`);
    }
  }

  // 2c.7) Expira handoffs FRÍOS: los que el bot derivó, nadie atendió y el
  //       cliente abandonó (>24h sin escribir) salen de "Atender ahora" y bajan
  //       a la cola normal. Es el reductor automático que evita que esa cola
  //       solo crezca. Va DESPUÉS de las olas para no pisar una atención de ola
  //       recién puesta. Best-effort.
  if (affords("handoffs", STAGE_COST_MS.handoffs)) {
    try {
      await expireColdHandoffs(admin, storeId);
    } catch (e: any) {
      report.errors.push(`handoffs: ${e.message}`);
    }
  }

  // 2d) Auto-archivar leads vencidos viejos (sin interacción > STALE_LEAD_DAYS)
  //     para que la cola "Por llamar" no se reacumule de backlog. Best-effort.
  if (affords("archive", STAGE_COST_MS.archive)) {
    try {
      report.archived = await archiveStaleLeads(admin, storeId);
    } catch (e: any) {
      report.errors.push(`archive: ${e.message}`);
    }
  }

  // 2e) Resolver nombres reales de anuncios Meta (meta_ads) para "Rendimiento por
  //     anuncio". Best-effort, gateado por el token de Meta; drena por corrida.
  if (creds.meta_access_token && affords("meta_ads", STAGE_COST_MS.metaAds)) {
    try {
      report.metaAdsResolved = await resolveMetaAdNames(admin, storeId, creds.meta_access_token);
    } catch (e: any) {
      report.errors.push(`meta-ads: ${e.message}`);
    }
  }

  // 3) Operational snapshot (best-effort; never fails the run)
  if (creds.kapso_api_key && affords("ops", STAGE_COST_MS.ops)) {
    try {
      const k = { apiKey: creds.kapso_api_key };
      let health: { status: string; error?: string | null; checks?: Record<string, unknown> | null } | null = null;
      let apiLogs = null;
      let activity24h = null;

      if (creds.whatsapp_phone_number_id) {
        try {
          const h = await getPhoneHealth(k, creds.whatsapp_phone_number_id);
          health = { status: h.status, error: h.error ?? null, checks: h.checks ?? null };
        } catch {
          /* best-effort */
        }
      }
      try {
        const logs = await listApiLogs(k, { period: "24h", limit: 100 });
        apiLogs = summarizeApiLogs(logs.data ?? []);
      } catch {
        /* best-effort */
      }
      try {
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const recent = await listAllConversations(
          k,
          { lastActiveAfter: since }, // all numbers
          10,
        );
        activity24h = {
          conversations: recent.length,
          activeConversations: recent.filter((c) => c.status === "active").length,
        };
      } catch {
        /* best-effort */
      }

      const payload = buildOpsSnapshotPayload({ health, apiLogs, activity24h });
      await admin.from("ops_snapshots").insert({ store_id: storeId, payload });
      report.opsCaptured = true;
    } catch (e: any) {
      report.errors.push(`ops: ${e.message}`);
    }
  }

  // 3b) Refresh the WhatsApp number → name lookup from Kapso (best-effort; the
  //     drawer/queue resolve `phone_number_id` → friendly name through it).
  if (creds.kapso_api_key && affords("wa_numbers", STAGE_COST_MS.waNumbers)) {
    try {
      const numbers = await listWhatsappNumbers({ apiKey: creds.kapso_api_key });
      report.whatsappNumbers = await upsertWhatsappNumbers(admin, numbers);
    } catch (e: any) {
      report.errors.push(`wa_numbers: ${e.message}`);
    }
  }

  // Recompute rollups for every touched day in one range call.
  //
  // Sin guarda de presupuesto a propósito: ver TAIL_RESERVE_MS.
  //
  // El rango cubre las fechas de ESTA corrida más las que dejó pendientes una
  // corrida anterior que murió antes de llegar aquí. Es lo que hace que guardar
  // el cursor página a página sea seguro: el avance del cursor y la deuda de
  // rollup son ahora igual de durables, así que una no puede adelantar a la
  // otra.
  const rollupRange = widenRollupPending(await getRollupPending(admin, storeId), [...affectedDates]);
  if (rollupRange) {
    try {
      await recomputeRollups(admin, storeId, rollupRange.from, rollupRange.to);
      // Solo se salda la deuda si el recálculo salió bien.
      await setRollupPending(admin, storeId, null);
    } catch (e: any) {
      report.errors.push(`rollups: ${e.message}`);
    }
  }

  // Red de seguridad del Master: cualquier ruta que haya tocado una guía sin
  // recalcular deja aquí su fila al día. También es lo que rellena el Master la
  // primera vez, sin necesidad de un backfill manual.
  // A diferencia del rollup, esta sí es diferible: reconcilia leyendo el estado
  // actual de la base, así que la corrida siguiente la pone al día igual.
  if (affordsTail("order_master", STAGE_COST_MS.orderMaster)) {
    try {
      const reconciled = await reconcileOrderMaster(admin, [storeId]);
      report.orderMaster = reconciled.written;
    } catch (e: any) {
      report.errors.push(`order_master: ${e.message}`);
    }
  }

  return report;
}
