// Ingestion orchestration shared by the webhook handler and the sync cron.
// All writes go through the service-role admin client (RLS-bypassing) and are
// idempotent. Per-store tokens are decrypted here, on demand, server-side only.

import { createHash, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { decryptOrNull } from "@/lib/crypto";
import {
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
import {
  flagOverdueFollowups,
  linkDraftOrdersToLeads,
  linkOrderToLead,
  linkOrdersToLeads,
  processBrowseAbandonment,
  syncStoreLeads,
  type LeadEnrichStats,
} from "@/lib/leads-ingest";
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
  whatsapp_phone_number_id: string | null;
  currency: string;
  timezone: string;
  status: string;
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
    whatsapp_phone_number_id: data.whatsapp_phone_number_id ?? null,
    currency: data.currency ?? "PEN",
    timezone: data.timezone ?? "America/Lima",
    status: data.status ?? "active",
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
  if (error) throw new Error(`upsertOrders: ${error.message}`);
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

/**
 * Authenticate + route an inbound Shopify Flow webhook (shared per-store secret
 * in the X-RecoverOps-Secret header). Routes by `body.source`; today only
 * `abandoned_browse` (Búsquedas abandonadas) → processBrowseAbandonment. Unknown
 * sources are accepted (no Flow retry) and ignored — extensible to more events.
 */
export async function processFlowWebhook(
  params: FlowWebhookParams,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<WebhookResult> {
  const creds = await getStoreCreds(params.storeId, admin);
  if (!creds) return { status: "error", message: "unknown store" };
  if (!verifyFlowSecret(params.secretHeader, creds.flow_webhook_secret)) {
    return { status: "unauthorized" };
  }

  let payload: any;
  try {
    payload = JSON.parse(params.rawBody);
  } catch {
    return { status: "error", message: "invalid json" };
  }

  if (String(payload?.source ?? "") === "abandoned_browse") {
    return processBrowseAbandonment(admin, params.storeId, payload);
  }
  return { status: "ok" }; // unknown Flow source — accept + ignore
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

  // Shopify fires order webhooks for the whole shop, but the dashboard must
  // reflect only Kapso-attributed orders (tag:kapso) — the same set as the
  // GraphQL reconciliation sync and the Shopify "tag:kapso" view (DEPLOY.md §7).
  // Drop anything else without recording it; there's nothing for Shopify to
  // retry, and orders the bot tags after creation arrive via orders/updated.
  if (!hasKapsoTag(row.tags)) {
    return { status: "ok" };
  }

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

  if (row.created_at) {
    const { date } = tzParts(row.created_at, creds.timezone);
    await recomputeRollups(admin, params.storeId, date, date);
  }

  // Link the order to its lead (won), best-effort.
  if (row.customer_phone) {
    try {
      const { data: ord } = await admin
        .from("orders")
        .select("id")
        .eq("store_id", params.storeId)
        .eq("shopify_order_id", row.shopify_order_id)
        .maybeSingle();
      await linkOrderToLead(admin, {
        storeId: params.storeId,
        phone: row.customer_phone,
        orderId: ord?.id ?? null,
      });
    } catch {
      /* best-effort */
    }
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
  _creds: StoreCreds,
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
    await linkDraftOrdersToLeads(admin, params.storeId, [row]);
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
  errors: string[];
}

export async function runStoreSync(
  storeId: string,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<SyncReport> {
  const report: SyncReport = {
    storeId,
    shopifyOrders: 0,
    draftOrders: 0,
    kapsoConversations: 0,
    leads: 0,
    enriched: { candidates: 0, fetched: 0, inbound: 0, cart: 0, district: 0, yape: 0 },
    opsCaptured: false,
    whatsappNumbers: 0,
    errors: [],
  };
  const creds = await getStoreCreds(storeId, admin);
  if (!creds) {
    report.errors.push("unknown store");
    return report;
  }
  const affectedDates = new Set<string>();

  // 1) Shopify reconciliation (tag:kapso, bounded by updated_at cursor)
  if (creds.shopify_token) {
    try {
      const cursor = await getSyncCursor(admin, storeId, "shopify");
      const searchQuery = buildKapsoOrdersSearchQuery(cursor);
      let after: string | null = null;
      let maxUpdatedAt = cursor;
      for (let i = 0; i < 50; i++) {
        const page = await fetchOrdersPage({
          domain: creds.shopify_domain,
          token: creds.shopify_token,
          storeId,
          searchQuery,
          after,
        });
        if (page.orders.length) {
          await upsertOrders(admin, page.orders);
          await linkOrdersToLeads(admin, storeId, page.orders); // order → lead (won)
          report.shopifyOrders += page.orders.length;
          for (const o of page.orders) {
            if (o.created_at) affectedDates.add(tzParts(o.created_at, creds.timezone).date);
          }
        }
        if (page.maxUpdatedAt && (!maxUpdatedAt || page.maxUpdatedAt > maxUpdatedAt)) {
          maxUpdatedAt = page.maxUpdatedAt;
        }
        if (!page.hasNextPage) break;
        after = page.endCursor;
      }
      await setSyncState(admin, storeId, "shopify", maxUpdatedAt, "ok");
    } catch (e: any) {
      report.errors.push(`shopify: ${e.message}`);
      await setSyncState(admin, storeId, "shopify", null, "error", e.message);
    }
  }

  // 1b) Shopify draft orders (Releasit COD carts → "Con carrito" leads).
  //     Re-scan the whole DRAFT_OPEN_WINDOW_DAYS window EVERY run (not incremental):
  //     a cart created fresh is held back by the grace period in
  //     linkDraftOrdersToLeads, and re-scanning is what promotes it to a lead once
  //     it ages past the grace. The window is small (a couple of days) so a full
  //     rescan is cheap. Own try/catch: a missing read_draft_orders scope just
  //     records an error here and never breaks the orders/Kapso/leads sync.
  if (creds.shopify_token) {
    try {
      const floor = new Date(Date.now() - DRAFT_OPEN_WINDOW_DAYS * 86_400_000).toISOString();
      let maxUpdatedAt: string | null = null;
      for (const status of ["open", "completed"] as const) {
        const searchQuery = buildDraftOrdersSearchQuery(status, floor);
        let after: string | null = null;
        for (let i = 0; i < 50; i++) {
          const page = await fetchDraftOrdersPage({
            domain: creds.shopify_domain,
            token: creds.shopify_token,
            storeId,
            searchQuery,
            after,
          });
          if (page.draftOrders.length) {
            await upsertDraftOrders(admin, page.draftOrders);
            await linkDraftOrdersToLeads(admin, storeId, page.draftOrders);
            report.draftOrders += page.draftOrders.length;
          }
          if (page.maxUpdatedAt && (!maxUpdatedAt || page.maxUpdatedAt > maxUpdatedAt)) {
            maxUpdatedAt = page.maxUpdatedAt;
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
  if (creds.kapso_api_key) {
    try {
      const k = { apiKey: creds.kapso_api_key };
      const cursor = await getSyncCursor(admin, storeId, "kapso");
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
        const t = await fetchConversationSignals(k, r.kapso_conversation_id);
        if (!t) continue;
        const { error: tErr } = await admin
          .from("conversations")
          .update({ inbound_count: t.inbound_count, first_response_seconds: t.first_response_seconds })
          .eq("store_id", storeId)
          .eq("kapso_conversation_id", r.kapso_conversation_id);
        if (tErr) break; // columns missing (migration pending) or transient — stop this run
      }

      let maxTs = cursor;
      for (const r of rows) {
        const ts = r.last_message_at ?? r.started_at;
        if (ts && (!maxTs || ts > maxTs)) maxTs = ts;
        if (r.started_at) affectedDates.add(tzParts(r.started_at, creds.timezone).date);
      }
      await setSyncState(admin, storeId, "kapso", maxTs, "ok");
    } catch (e: any) {
      report.errors.push(`kapso: ${e.message}`);
      await setSyncState(admin, storeId, "kapso", null, "error", e.message);
    }
  }

  // 2b) Leads — build/refresh from conversations + order linkage.
  if (creds.kapso_api_key) {
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
  try {
    await flagOverdueFollowups(admin, storeId);
  } catch (e: any) {
    report.errors.push(`followups: ${e.message}`);
  }

  // 3) Operational snapshot (best-effort; never fails the run)
  if (creds.kapso_api_key) {
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
  if (creds.kapso_api_key) {
    try {
      const numbers = await listWhatsappNumbers({ apiKey: creds.kapso_api_key });
      report.whatsappNumbers = await upsertWhatsappNumbers(admin, numbers);
    } catch (e: any) {
      report.errors.push(`wa_numbers: ${e.message}`);
    }
  }

  // Recompute rollups for every touched day in one range call.
  if (affectedDates.size) {
    const sorted = [...affectedDates].sort();
    try {
      await recomputeRollups(admin, storeId, sorted[0]!, sorted[sorted.length - 1]!);
    } catch (e: any) {
      report.errors.push(`rollups: ${e.message}`);
    }
  }

  return report;
}
