// Lead ingestion: build/maintain leads from Kapso conversations, link them to
// Shopify orders, and apply bot handoffs (Yape/hot). Service-role only.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  conversationToLeadSeed,
  fetchAllConversationsRich,
  fetchConversationSignals,
  parseHandoffPayload,
  sendWhatsappTemplate,
  type HandoffInfo,
  type KapsoClientOpts,
  type LeadSeed,
} from "@/lib/kapso";
import type { StoreCreds } from "@/lib/ingest";
import { deriveAutoState, nextLeadState } from "@/lib/leads";
import { normalizePhone } from "@/lib/phone";
import { DRAFT_GRACE_MINUTES, extractNumericId, fetchOrderById, isCodFormDraft } from "@/lib/shopify";
import {
  BROWSE_SOURCE,
  COD_CART_SOURCE,
  WHATSAPP_BOT_SOURCE,
  type DraftOrderRow,
  type OrderLineItem,
} from "@/lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Per-run cap on lead enrichment message fetches (one Kapso message page each).
const LEAD_ENRICH_CAP = 80;
// Per-run cap on source-attributing WON leads (the open/hot enrichment skips
// them). Bounded so a one-time backfill spreads over a few runs.
const WON_ATTR_CAP = 60;

export interface LeadEnrichStats {
  candidates: number; // open/hot leads we tried to enrich this run
  fetched: number; // of those, conversations whose messages we could read
  inbound: number; // leads with ≥2 customer messages
  cart: number; // leads where a cart/order summary was detected
  district: number; // leads where a district was detected
  yape: number; // leads where a Yape/Shalom advance was detected (promoted if still "nuevo")
}
export interface SyncLeadsResult {
  touched: number;
  enriched: LeadEnrichStats;
}
const ZERO_ENRICH: LeadEnrichStats = {
  candidates: 0,
  fetched: 0,
  inbound: 0,
  cart: 0,
  district: 0,
  yape: 0,
};

interface ExistingLead {
  phone: string;
  status: string;
  handoff_reason: string | null;
  has_order: boolean;
}

async function getCursor(admin: SupabaseClient, storeId: string): Promise<string | null> {
  const { data } = await admin
    .from("sync_state")
    .select("cursor")
    .match({ store_id: storeId, source: "leads" })
    .maybeSingle();
  return data?.cursor ?? null;
}

async function setCursor(admin: SupabaseClient, storeId: string, cursor: string | null, status: string, error?: string) {
  await admin.from("sync_state").upsert(
    { store_id: storeId, source: "leads", cursor, last_run_at: new Date().toISOString(), status, error: error ?? null },
    { onConflict: "store_id,source" },
  );
}

/**
 * Upsert one lead from a Kapso conversation seed without clobbering an agent's
 * manual disposition. Shared by the periodic sync and the real-time webhook.
 *   - order exists → won (sticky)
 *   - existing manual status → left untouched
 *   - existing handoff → re-derived hot
 *   - otherwise → new/open
 */
async function upsertLeadFromSeed(
  admin: SupabaseClient,
  storeId: string,
  seed: LeadSeed,
  ctx: { hasOrder: boolean; orderId?: string | null; existing: ExistingLead | null; hasRecentIntent?: boolean },
): Promise<void> {
  const ns = nextLeadState(
    ctx.existing ? { status: ctx.existing.status, handoff_reason: ctx.existing.handoff_reason } : null,
    { hasOrder: ctx.hasOrder, hasRecentIntent: ctx.hasRecentIntent },
  );

  const row: any = {
    store_id: storeId,
    phone: seed.phone,
    kapso_conversation_id: seed.kapso_conversation_id,
  };
  if (seed.name) row.name = seed.name;
  if (seed.wa_id) row.wa_id = seed.wa_id;
  if (seed.phone_number_id) row.wa_phone_number_id = seed.phone_number_id;
  if (seed.last_interaction_at) row.last_interaction_at = seed.last_interaction_at;
  if (seed.last_inbound_at) row.last_inbound_at = seed.last_inbound_at;
  if (!ctx.existing && seed.first_seen_at) row.first_seen_at = seed.first_seen_at;
  if (ns) {
    row.status = ns.status;
    row.category = ns.category;
    row.needs_attention = ns.needsAttention;
  }
  if (ctx.hasOrder) {
    row.has_order = true;
    row.order_id = ctx.orderId ?? null;
  }
  // Upsert resiliently: wa_phone_number_id (migration 0012) may not be applied
  // yet. NEVER let that optional attribution column break lead creation — if the
  // column is absent the upsert errors, so we retry once without it. (This is the
  // bug that silently stopped ALL new leads: the column was written blindly and
  // the error swallowed whenever 0012 hadn't been applied.)
  const { error } = await admin.from("leads").upsert(row, { onConflict: "store_id,phone" });
  if (error && "wa_phone_number_id" in row) {
    delete row.wa_phone_number_id;
    await admin.from("leads").upsert(row, { onConflict: "store_id,phone" });
  }
}

/**
 * Pull Kapso conversations (since the cursor), upsert one lead per phone, link
 * orders by phone, and set the auto state without clobbering an agent's manual
 * status. Returns the number of leads touched.
 */
export async function syncStoreLeads(
  admin: SupabaseClient,
  storeId: string,
  creds: { kapso_api_key: string | null; whatsapp_phone_number_id: string | null },
): Promise<SyncLeadsResult> {
  if (!creds.kapso_api_key) return { touched: 0, enriched: { ...ZERO_ENRICH } };
  const k: KapsoClientOpts = { apiKey: creds.kapso_api_key };
  const cursor = await getCursor(admin, storeId);

  let convs;
  try {
    convs = await fetchAllConversationsRich(
      k,
      // Pull from ALL of the store's WhatsApp numbers, not just the send-from
      // number. A store can connect several numbers to one Kapso project (e.g. an
      // API/Cloud number + a Business/coexistence number); filtering by
      // whatsapp_phone_number_id silently dropped the other numbers' leads.
      { lastActiveAfter: cursor ?? undefined },
      cursor,
    );
  } catch (e: any) {
    await setCursor(admin, storeId, cursor, "error", e?.message);
    return { touched: 0, enriched: { ...ZERO_ENRICH } };
  }

  // Dedup by phone, keeping the most recent conversation.
  const seeds = new Map<string, ReturnType<typeof conversationToLeadSeed>>();
  for (const c of convs) {
    const s = conversationToLeadSeed(c);
    if (!s) continue;
    const prev = seeds.get(s.phone);
    if (!prev || (s.last_interaction_at ?? "") > (prev.last_interaction_at ?? "")) {
      seeds.set(s.phone, s);
    }
  }
  const phones = [...seeds.keys()];
  if (!phones.length) {
    // No active conversations this run, but still backfill enrichment for the
    // existing open queue (the 66 leads sitting in "Por llamar").
    let enriched: LeadEnrichStats = { ...ZERO_ENRICH };
    try {
      enriched = await enrichLeadsFromConversations(admin, storeId, k, new Map());
    } catch {
      /* best-effort */
    }
    try {
      await attributeWonLeadSources(admin, storeId, k);
    } catch {
      /* best-effort — backfill won-lead sources even on a quiet run */
    }
    await setCursor(admin, storeId, cursor, "ok");
    return { touched: 0, enriched };
  }

  // Orders by phone (non-cancelled, keep the most recent) → won linkage.
  const orderByPhone = new Map<string, { id: string; createdAt: string | null }>();
  {
    const { data } = await admin
      .from("orders")
      .select("id, customer_phone, created_at")
      .eq("store_id", storeId)
      .in("customer_phone", phones)
      .is("cancelled_at", null);
    for (const o of (data as { id: string; customer_phone: string; created_at: string | null }[]) ?? []) {
      if (!o.customer_phone) continue;
      const prev = orderByPhone.get(o.customer_phone);
      if (!prev || (o.created_at ?? "") > (prev.createdAt ?? "")) {
        orderByPhone.set(o.customer_phone, { id: o.id, createdAt: o.created_at });
      }
    }
  }

  // Newest OPEN cart (draft) per phone → "new buying intent" signal. A draft
  // created after a won order means a repeat purchase in progress, so the lead
  // must reopen instead of staying won (recompra).
  const newestOpenCartAt = new Map<string, string>();
  {
    const { data } = await admin
      .from("draft_orders")
      .select("customer_phone, created_at")
      .eq("store_id", storeId)
      .in("customer_phone", phones)
      .in("status", ["open", "invoice_sent"]);
    for (const d of (data as { customer_phone: string | null; created_at: string | null }[]) ?? []) {
      if (!d.customer_phone || !d.created_at) continue;
      const prev = newestOpenCartAt.get(d.customer_phone);
      if (!prev || d.created_at > prev) newestOpenCartAt.set(d.customer_phone, d.created_at);
    }
  }

  // Existing leads for these phones.
  const existingByPhone = new Map<string, ExistingLead>();
  {
    const { data } = await admin
      .from("leads")
      .select("phone, status, handoff_reason, has_order")
      .eq("store_id", storeId)
      .in("phone", phones);
    for (const l of (data as ExistingLead[]) ?? []) existingByPhone.set(l.phone, l);
  }

  // Last manual call disposition per phone → a cart only counts as "new intent"
  // (reopen) when it post-dates the agent's registered result. Otherwise a cart
  // created BEFORE the disposition would wrongly revert a worked lead to "Sin
  // llamar".
  const dispositionByPhone = await lastDispositionAtByPhone(admin, storeId, phones);

  let maxTs = cursor;
  for (const phone of phones) {
    const seed = seeds.get(phone)!;
    const existing = existingByPhone.get(phone) ?? null;
    const order = orderByPhone.get(phone);
    const cartAt = newestOpenCartAt.get(phone) ?? null;
    const hasRecentIntent =
      !!(order?.createdAt && cartAt && cartAt > order.createdAt) &&
      eventOverridesDisposition(cartAt, dispositionByPhone.get(phone));
    await upsertLeadFromSeed(admin, storeId, seed, {
      hasOrder: !!order,
      orderId: order?.id ?? null,
      existing,
      hasRecentIntent,
    });

    if (seed.last_interaction_at && (!maxTs || seed.last_interaction_at > maxTs)) {
      maxTs = seed.last_interaction_at;
    }
  }

  // Enrich open/hot leads with buyer-intent signals parsed from their Kapso
  // messages (district, cart, inbound count) — Aurela's bot collects these
  // in-chat, there's no Shopify draft order. Best-effort; bounded per run.
  let enriched: LeadEnrichStats = { ...ZERO_ENRICH };
  try {
    enriched = await enrichLeadsFromConversations(admin, storeId, k, seeds);
  } catch {
    /* enrichment is best-effort — never blocks the lead sync */
  }
  try {
    await attributeWonLeadSources(admin, storeId, k);
  } catch {
    /* source backfill is best-effort — never blocks the lead sync */
  }

  await setCursor(admin, storeId, maxTs, "ok");
  return { touched: phones.length, enriched };
}

/**
 * Source-attribute WON leads that the open/hot enrichment skips (`category in
 * (open,hot)` there). A lead that converts before its CTWA referral is captured
 * would otherwise stay unattributed forever. For each WON lead still missing a
 * `source`, read its conversation: a Meta ad referral (structured OR a Meta ad
 * link in the opening message) → `meta_ad`; anything else → the bot/organic
 * sentinel so it's marked checked and not re-fetched. Bounded per run, ordered
 * newest-first, so it both backfills history and catches fast-closed leads.
 */
async function attributeWonLeadSources(
  admin: SupabaseClient,
  storeId: string,
  k: KapsoClientOpts,
): Promise<number> {
  const { data } = await admin
    .from("leads")
    .select("kapso_conversation_id")
    .eq("store_id", storeId)
    .eq("category", "won")
    .is("source", null)
    .not("kapso_conversation_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(WON_ATTR_CAP);
  const convIds = [...new Set(((data as { kapso_conversation_id: string }[]) ?? []).map((l) => l.kapso_conversation_id))];
  let n = 0;
  for (const convId of convIds) {
    const sig = await fetchConversationSignals(k, convId);
    if (!sig) continue; // couldn't read the conversation — retry next run
    const patch = sig.referral
      ? {
          source: sig.referral.source,
          ad_id: sig.referral.ad_id,
          ad_headline: sig.referral.ad_headline,
          ctwa_clid: sig.referral.ctwa_clid,
        }
      : { source: WHATSAPP_BOT_SOURCE }; // checked, no ad signal → organic sentinel
    await admin
      .from("leads")
      .update(patch)
      .eq("store_id", storeId)
      .eq("kapso_conversation_id", convId)
      .is("source", null);
    n++;
  }
  return n;
}

/**
 * Fill cart/district/inbound on open/hot leads from their Kapso conversation
 * messages. Targets the conversations active this run plus a backlog of leads
 * not yet enriched (inbound_count is null), so the existing queue fills in over
 * a run or two without a full re-pull. Bounded by LEAD_ENRICH_CAP.
 */
async function enrichLeadsFromConversations(
  admin: SupabaseClient,
  storeId: string,
  k: KapsoClientOpts,
  seeds: Map<string, ReturnType<typeof conversationToLeadSeed>>,
): Promise<LeadEnrichStats> {
  const stats: LeadEnrichStats = { ...ZERO_ENRICH };
  const convIds = new Set<string>();
  for (const s of seeds.values()) if (s?.kapso_conversation_id) convIds.add(s.kapso_conversation_id);

  // Re-enrich the open queue each run (bounded), unenriched leads first, so the
  // existing queue refreshes — picks up conversation progress and parser fixes.
  const { data: backlog } = await admin
    .from("leads")
    .select("kapso_conversation_id")
    .eq("store_id", storeId)
    .in("category", ["open", "hot"])
    .not("kapso_conversation_id", "is", null)
    .order("inbound_count", { ascending: true, nullsFirst: true })
    .limit(LEAD_ENRICH_CAP);
  for (const l of (backlog as { kapso_conversation_id: string }[]) ?? []) {
    convIds.add(l.kapso_conversation_id);
  }

  let n = 0;
  for (const convId of convIds) {
    if (n++ >= LEAD_ENRICH_CAP) break;
    stats.candidates += 1;
    const sig = await fetchConversationSignals(k, convId);
    if (!sig) continue;
    stats.fetched += 1;
    if ((sig.inbound_count ?? 0) >= 2) stats.inbound += 1;
    if ((sig.cart_item_count ?? 0) > 0) stats.cart += 1;
    if ((sig.district ?? "").trim()) stats.district += 1;
    // Only FILL IN values from the WhatsApp parse — never erase existing lead
    // data with a null/empty parse. A browse (abandoned_browse) lead carries its
    // viewed product in `cart_summary` (+ maybe a Flow district) from the seed;
    // its bot conversation rarely re-mentions them, so a blind write wiped that
    // context. `inbound_count` is conversation-owned, so it always updates.
    const patch: Record<string, unknown> = {};
    if (sig.inbound_count != null) patch.inbound_count = sig.inbound_count;
    if ((sig.district ?? "").trim()) patch.district = sig.district;
    if (sig.cart_value != null) patch.cart_value = sig.cart_value;
    if (sig.cart_item_count != null) patch.cart_item_count = sig.cart_item_count;
    if ((sig.cart_summary ?? "").trim()) patch.cart_summary = sig.cart_summary;
    if (Object.keys(patch).length) {
      await admin
        .from("leads")
        .update(patch)
        .eq("store_id", storeId)
        .eq("kapso_conversation_id", convId)
        // Never clobber cart/district that came from a real Shopify draft order:
        // the draft (linkDraftOrdersToLeads) is the source of truth; this WhatsApp
        // parse is only the fallback for leads that have no draft.
        .is("draft_order_gid", null);
    }

    // Source attribution: a Click-to-WhatsApp ad referral on the conversation's
    // first inbound message → stamp the lead's source (first-touch, sticky via
    // `is("source", null)`). Separate, self-contained write so a pending 0008
    // migration (columns absent) can't break the cart/district enrichment above.
    if (sig.referral) {
      await admin
        .from("leads")
        .update({
          source: sig.referral.source,
          ad_id: sig.referral.ad_id,
          ad_headline: sig.referral.ad_headline,
          ctwa_clid: sig.referral.ctwa_clid,
        })
        .eq("store_id", storeId)
        .eq("kapso_conversation_id", convId)
        .is("source", null);
    }

    // Yape/Shalom advance detected in-chat (the bot didn't fire a handoff, e.g.
    // the voucher came as an image). Promote the auto-"nuevo" lead to
    // yape_por_verificar (hot). Only "nuevo" is touched — manual dispositions
    // and won leads keep their state; already-hot leads are left as-is.
    if (sig.yape) {
      stats.yape += 1;
      await admin
        .from("leads")
        .update({ status: "yape_por_verificar", category: "hot", needs_attention: true })
        .eq("store_id", storeId)
        .eq("kapso_conversation_id", convId)
        .eq("status", "nuevo");
    }
  }
  return stats;
}

/** Bubble overdue follow-ups back up: open/hot leads whose next_followup_at has
 *  passed get needs_attention=true so they float to the top of the queue ("Por
 *  llamar" / "Seguimientos" sort needs_attention first). Idempotent — only flips
 *  rows still at false. Returns how many it flagged. */
export async function flagOverdueFollowups(admin: SupabaseClient, storeId: string): Promise<number> {
  const { data } = await admin
    .from("leads")
    .update({ needs_attention: true })
    .eq("store_id", storeId)
    .in("category", ["open", "hot"])
    .not("next_followup_at", "is", null)
    .lte("next_followup_at", new Date().toISOString())
    .eq("needs_attention", false)
    .select("id");
  return (data as { id: string }[] | null)?.length ?? 0;
}

/** Días sin interacción tras los cuales un lead en cola se archiva como Perdido. */
export const STALE_LEAD_DAYS = 7;

/** Auto-archiva los leads en cola (open/hot, sin yape, sin seguimiento agendado)
 *  cuya última interacción es anterior al corte (> `days` días). Espejo del
 *  descarte manual: pasan a Perdido (`cancelado`) con una fila de auditoría en
 *  `lead_calls`. La ventana de 24h ya está vencida por definición (días >> 24h).
 *  Idempotente: tras pasar a 'lost' dejan de calzar el filtro. Cap por corrida
 *  para que un backlog grande drene en varias pasadas del cron sin updates
 *  gigantes. Excluye `next_followup_at` agendados (la vista Seguimientos ignora
 *  la categoría) y los pagos pendientes (`yape_por_verificar`). */
export async function archiveStaleLeads(
  admin: SupabaseClient,
  storeId: string,
  days = STALE_LEAD_DAYS,
): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await admin
    .from("leads")
    .select("id")
    .eq("store_id", storeId)
    .in("category", ["open", "hot"])
    .neq("status", "yape_por_verificar")
    .is("next_followup_at", null)
    .lt("last_interaction_at", cutoff)
    .limit(1000);
  const ids = (data as { id: string }[] | null)?.map((r) => r.id) ?? [];
  if (!ids.length) return 0;
  await admin.from("lead_calls").insert(
    ids.map((id) => ({
      lead_id: id,
      store_id: storeId,
      vendedora: null,
      kind: "system",
      new_status: "cancelado",
      note: `Auto-archivado por inactividad (> ${days} dias sin interaccion)`,
    })),
  );
  await admin
    .from("leads")
    .update({ category: "lost", status: "cancelado", needs_attention: false })
    .in("id", ids);
  return ids.length;
}

/** Whether an automatic order/cart event may override the lead's state: only when
 *  it post-dates the agent's last manual call disposition (or there is none).
 *  Keeps a registered result (e.g. "ya compró en otro lado") from being reverted
 *  to "Sin llamar" by an order/cart that predates it. Pure. */
export function eventOverridesDisposition(
  eventAt: string | null | undefined,
  dispositionAt: string | null | undefined,
): boolean {
  if (!dispositionAt) return true; // no human result to respect
  if (!eventAt) return false; // can't prove the event is newer → respect the result
  return eventAt > dispositionAt;
}

/**
 * Should a fresh OPEN cart re-open a lead currently marked `won`? Yes when the cart
 * out-ranks the win — either there is NO active (non-cancelled) order anchoring it
 * (`lastOrderAt` null: the winning order was cancelled or is gone), or the cart
 * post-dates that order (a recompra) — AND the cart also post-dates the agent's last
 * manual disposition (never revert a worked result). Pure; drives the reopen guard.
 */
export function shouldReopenWonCart(opts: {
  category: string | undefined;
  draftCreatedAt: string | null;
  lastOrderAt: string | null | undefined; // latest NON-cancelled order for the phone
  lastDispositionAt: string | null | undefined;
}): boolean {
  if (opts.category !== "won") return false;
  const cartBeatsOrder =
    !opts.lastOrderAt || (!!opts.draftCreatedAt && opts.draftCreatedAt > opts.lastOrderAt);
  return cartBeatsOrder && eventOverridesDisposition(opts.draftCreatedAt, opts.lastDispositionAt);
}

/** Most recent MANUAL call disposition time per phone (when an agent set a call
 *  result). The auto-sync must not override a disposition with an order/cart that
 *  predates it. Returns {} on any error. */
export async function lastDispositionAtByPhone(
  admin: SupabaseClient,
  storeId: string,
  phones: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!phones.length) return out;
  const { data: leadRows } = await admin
    .from("leads")
    .select("id, phone")
    .eq("store_id", storeId)
    .in("phone", phones);
  const phoneById = new Map<string, string>();
  const ids: string[] = [];
  for (const l of (leadRows as { id: string; phone: string }[]) ?? []) {
    phoneById.set(l.id, l.phone);
    ids.push(l.id);
  }
  if (!ids.length) return out;
  const { data: calls } = await admin
    .from("lead_calls")
    .select("lead_id, occurred_at")
    .eq("store_id", storeId)
    .eq("kind", "call")
    .not("new_status", "is", null)
    .in("lead_id", ids);
  for (const c of (calls as { lead_id: string; occurred_at: string }[]) ?? []) {
    const phone = phoneById.get(c.lead_id);
    if (!phone) continue;
    const prev = out.get(phone);
    if (!prev || c.occurred_at > prev) out.set(phone, c.occurred_at);
  }
  return out;
}

/** Mark the lead for an order's customer as won (sticky), creating it if new.
 *  `win` is false when the order predates the agent's last manual disposition →
 *  we only link the order (has_order/order_id) and keep the registered result. */
export async function linkOrderToLead(
  admin: SupabaseClient,
  params: { storeId: string; phone: string | null; orderId: string | null; win?: boolean },
): Promise<void> {
  if (!params.phone) return;
  const base = {
    store_id: params.storeId,
    phone: params.phone,
    has_order: true,
    order_id: params.orderId,
  };
  const row =
    params.win === false
      ? base
      : { ...base, status: "pedido_generado", category: "won", needs_attention: false };
  await admin.from("leads").upsert(row, { onConflict: "store_id,phone" });
}

/**
 * Link a batch of synced orders to their leads (won) by phone. Resolves each
 * order's row id once, then marks the matching lead. Lets a full order re-sync
 * backfill linkage for historical orders (mirrors the webhook path).
 */
export async function linkOrdersToLeads(
  admin: SupabaseClient,
  storeId: string,
  orders: { shopify_order_id: number | string | null; customer_phone?: string | null; created_at?: string | null }[],
): Promise<void> {
  const withPhone = orders.filter((o) => o.customer_phone && o.shopify_order_id != null);
  if (!withPhone.length) return;

  const { data } = await admin
    .from("orders")
    .select("id, shopify_order_id")
    .eq("store_id", storeId)
    .in("shopify_order_id", withPhone.map((o) => o.shopify_order_id) as (number | string)[]);

  const idByShopifyId = new Map<string, string>();
  for (const r of (data as { id: string; shopify_order_id: number | string }[]) ?? []) {
    idByShopifyId.set(String(r.shopify_order_id), r.id);
  }

  // Don't override a registered call result with an order that predates it.
  const dispositionAt = await lastDispositionAtByPhone(admin, storeId, [
    ...new Set(withPhone.map((o) => o.customer_phone as string)),
  ]);

  for (const o of withPhone) {
    await linkOrderToLead(admin, {
      storeId,
      phone: o.customer_phone ?? null,
      orderId: idByShopifyId.get(String(o.shopify_order_id)) ?? null,
      win: eventOverridesDisposition(o.created_at, dispositionAt.get(o.customer_phone as string)),
    });
  }
}

// ---------------------------------------------------------------------------
// Draft orders (Releasit COD carts) → leads. Mirrors linkOrdersToLeads.
// ---------------------------------------------------------------------------

/** First-3-titles cart summary, matching the WhatsApp parser's format. */
function draftCartSummary(items: OrderLineItem[]): string | null {
  const titles = items
    .map((it) => String(it.title ?? "").replace(/\s*\(.*$/, "").trim())
    .filter(Boolean);
  if (!titles.length) return null;
  return titles.slice(0, 3).join(", ") + (titles.length > 3 ? ` +${titles.length - 3}` : "");
}

/** Upsert a lead, dropping the 0013-only columns and retrying if the migration
 *  isn't applied yet (mirrors the wa_phone_number_id resilience above). */
async function upsertLeadResilient(admin: SupabaseClient, row: any): Promise<void> {
  const { error } = await admin.from("leads").upsert(row, { onConflict: "store_id,phone" });
  if (!error) return;
  let dropped = false;
  for (const c of ["draft_order_name", "draft_order_status", "draft_order_url", "province", "region", "referencia"]) {
    if (c in row) {
      delete row[c];
      dropped = true;
    }
  }
  if (dropped) await admin.from("leads").upsert(row, { onConflict: "store_id,phone" });
}

/** OPEN/INVOICE_SENT draft → ensure a callable "cart" lead. Creates it if new;
 *  `reopen` reactivates an existing WON lead whose new cart post-dates its order
 *  (a repeat customer) back to an actionable state. Otherwise an existing lead's
 *  disposition/won state is left untouched (only cart fields refreshed). */
async function upsertDraftCartLead(
  admin: SupabaseClient,
  storeId: string,
  d: DraftOrderRow,
  exists: boolean,
  reopen = false,
  fillSource = false,
): Promise<void> {
  const qty = d.line_items.reduce((s, li) => s + (Number(li.quantity) || 0), 0);
  const row: any = {
    store_id: storeId,
    phone: d.customer_phone,
    draft_order_gid: d.draft_order_gid,
    draft_order_name: d.name,
    draft_order_status: d.status,
    draft_order_url: d.invoice_url,
    cart_value: d.total_amount,
    cart_item_count: qty > 0 ? qty : 1, // >0 so leadSegment() → "carrito"
    cart_summary: draftCartSummary(d.line_items),
    district: d.district,
    province: d.province,
    region: d.region,
    referencia: d.referencia,
  };
  // Status/source/identity ONLY for a brand-new lead — never touch an existing
  // lead's disposition or won state (parity with nextLeadState's manual guard).
  if (!exists) {
    row.status = "nuevo";
    row.category = "open";
    row.needs_attention = false;
    row.source = COD_CART_SOURCE;
    if (d.customer_name) row.name = d.customer_name;
    if (d.created_at) row.first_seen_at = d.created_at;
    const seen = d.updated_at ?? d.created_at;
    if (seen) row.last_interaction_at = seen;
  } else if (reopen) {
    // Recompra, o sobra de una orden cancelada: un carrito abierto fresco lo vuelve
    // a poner como llamable. Atribuye a "carrito" si el lead no tenía fuente.
    row.status = "nuevo";
    row.category = "open";
    row.needs_attention = false;
    if (fillSource) row.source = COD_CART_SOURCE;
  }
  await upsertLeadResilient(admin, row);
}

// ───────────────────── Búsquedas abandonadas (Shopify Flow) ─────────────────
// Web-only source: an identified visitor who viewed a product page and left
// (Shopify Flow "customer left online store"). No cart, no chat — the weakest
// intent. Mirrors the cod_cart web-only lead, but NEVER overwrites an existing
// lead (lowest precedence): a plain insert + unique(store_id,phone) guarantees
// we only CREATE, never downgrade a WhatsApp/cart/campaign lead.

export interface BrowseLeadSeed {
  phone: string;
  name: string | null;
  email: string | null;
  cart_summary: string | null; // product(s) viewed/added, for advisor context
  cart_item_count: number | null; // only when products were actually added → "carrito"
  district: string | null; // from customer.defaultAddress, if the Flow sends it
  province: string | null;
  referencia: string | null;
  first_seen_at: string | null;
  last_interaction_at: string | null;
}

function flowStr(v: any): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t || null;
}

function browseProductSummary(items: any[]): string | null {
  const titles = (Array.isArray(items) ? items : [])
    .map((it) => flowStr(it?.productTitle))
    .filter((t): t is string => !!t);
  if (!titles.length) return null;
  return titles.slice(0, 3).join(", ") + (titles.length > 3 ? ` +${titles.length - 3}` : "");
}

/** Map a Shopify Flow `abandoned_browse` payload → lead fields. Returns null when
 *  there's no usable phone (an anonymous browse can't be a callable lead). Pure.
 *  Classification falls out of the fields: products added → cart_item_count ⇒
 *  "carrito"; a district ⇒ "distrito"; otherwise "frío" (product still shown). */
export function browseLeadSeed(body: any): BrowseLeadSeed | null {
  const rawPhone = body?.customer?.phone ?? body?.customer?.defaultPhoneNumber?.phoneNumber ?? null;
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;

  const added = Array.isArray(body?.productsAddedToCart) ? body.productsAddedToCart : [];
  const viewed = Array.isArray(body?.productsViewed) ? body.productsViewed : [];
  const hasCart = added.length > 0;
  const qty = added.reduce((s: number, it: any) => s + (Number(it?.quantity) || 0), 0);
  const addr = body?.customer?.defaultAddress ?? body?.customer?.address ?? null;
  const sentAt = flowStr(body?.sentAt);

  return {
    phone,
    name: flowStr(body?.customer?.name),
    email: flowStr(body?.customer?.email),
    cart_summary: browseProductSummary(hasCart ? added : viewed),
    cart_item_count: hasCart ? (qty > 0 ? qty : added.length) : null,
    district: flowStr(addr?.city),
    province: flowStr(addr?.province),
    referencia: flowStr(addr?.address1),
    first_seen_at: sentAt,
    last_interaction_at: sentAt,
  };
}

/** Insert a lead, tolerating a not-yet-applied 0013 migration (drop optional
 *  columns and retry). Returns "exists" on a unique (store_id, phone) clash —
 *  a lead already owns this phone, so we leave it untouched. */
async function insertLeadResilient(admin: SupabaseClient, row: any): Promise<"ok" | "exists"> {
  const ins = await admin.from("leads").insert(row);
  if (!ins.error) return "ok";
  if ((ins.error as any).code === "23505") return "exists";
  let dropped = false;
  for (const c of ["province", "region", "referencia"]) {
    if (c in row) {
      delete row[c];
      dropped = true;
    }
  }
  if (!dropped) throw new Error(`insertLead: ${ins.error.message}`);
  const retry = await admin.from("leads").insert(row);
  if (!retry.error) return "ok";
  if ((retry.error as any).code === "23505") return "exists";
  throw new Error(`insertLead: ${retry.error.message}`);
}

/** Ingest a Shopify Flow "abandoned browse" event → a NEW lead (source
 *  abandoned_browse), created only if no lead exists for that phone. Idempotent
 *  on the abandonment id (webhook_events). */
export async function processBrowseAbandonment(
  admin: SupabaseClient,
  storeId: string,
  body: any,
  creds?: StoreCreds | null,
  sendTemplate: typeof sendWhatsappTemplate = sendWhatsappTemplate,
): Promise<{ status: "ok" | "duplicate" }> {
  const abandonmentId = body?.abandonment?.id != null ? String(body.abandonment.id) : null;
  const webhookId =
    abandonmentId ?? createHash("sha256").update(JSON.stringify(body ?? {}), "utf8").digest("hex");

  const { error: insErr } = await admin.from("webhook_events").insert({
    store_id: storeId,
    topic: "flow/abandoned_browse",
    shopify_id: abandonmentId,
    webhook_id: webhookId,
    processed: false,
  });
  if (insErr) {
    if ((insErr as any).code === "23505") return { status: "duplicate" };
    throw new Error(`webhook_events insert: ${insErr.message}`);
  }

  const seed = browseLeadSeed(body);
  let created: "ok" | "exists" | null = null;
  if (seed) {
    created = await insertLeadResilient(admin, {
      store_id: storeId,
      phone: seed.phone,
      source: BROWSE_SOURCE,
      status: "nuevo",
      category: "open",
      needs_attention: false,
      name: seed.name,
      email: seed.email,
      cart_summary: seed.cart_summary,
      cart_item_count: seed.cart_item_count,
      district: seed.district,
      province: seed.province,
      referencia: seed.referencia,
      first_seen_at: seed.first_seen_at,
      last_interaction_at: seed.last_interaction_at,
    });
  }

  await admin
    .from("webhook_events")
    .update({ processed: true })
    .match({ store_id: storeId, webhook_id: webhookId });

  // Cold re-engagement: fire the Meta-approved WhatsApp template to a *brand-new*
  // browse lead only (never to a phone that already had a lead → no spam; if the
  // customer replies, the Kapso bot on the store's number takes over). Gated
  // per-store and needs both template variables (name {{1}} + product {{2}}).
  // Best-effort: any send/log failure must never 500 the webhook (Flow retries
  // on non-2xx, which would duplicate the lead).
  if (
    created === "ok" &&
    seed &&
    creds?.browse_template_enabled &&
    creds.browse_template_name &&
    creds.kapso_api_key &&
    creds.whatsapp_phone_number_id &&
    seed.name &&
    seed.cart_summary
  ) {
    try {
      const send = await sendTemplate(
        { apiKey: creds.kapso_api_key },
        {
          phoneNumberId: creds.whatsapp_phone_number_id,
          to: seed.phone,
          templateName: creds.browse_template_name,
          language: creds.browse_template_language ?? "es",
          bodyParams: [seed.name, seed.cart_summary],
        },
      );
      const { data: lead } = await admin
        .from("leads")
        .select("id")
        .eq("store_id", storeId)
        .eq("phone", seed.phone)
        .maybeSingle();
      if (lead?.id) {
        await admin.from("lead_calls").insert({
          lead_id: lead.id,
          store_id: storeId,
          kind: "system",
          vendedora: null,
          note: send.ok
            ? `📤 WhatsApp: plantilla «${creds.browse_template_name}» enviada`
            : `⚠️ WhatsApp: falló envío de «${creds.browse_template_name}» (${send.error})`,
        });
      }
    } catch {
      /* best-effort — never break the webhook ack */
    }
  }

  return { status: "ok" };
}

// ───────────────────── Recuperación de clientes (winback 60d) ────────────────
// A Shopify Flow (order created → wait 60 days → condition: no new order) posts
// the lapsed customer here with source "winback". This is a pure SEND: the
// Meta-approved template (coupon + store-link button) goes out and NO lead is
// created — these are past customers, not queue work; if one replies, the
// normal Kapso inbound ingestion creates/updates the lead as usual.

export interface WinbackSeed {
  phone: string;
  name: string | null; // template {{1}}
  customerId: string | null;
  orderId: string | null; // the order whose 60-day wait triggered this cycle
}

/** Map a Shopify Flow `winback` payload → send fields. Returns null when
 *  there's no usable phone (nothing to send to). Pure. */
export function winbackSeed(body: any): WinbackSeed | null {
  const rawPhone = body?.customer?.phone ?? body?.customer?.defaultPhoneNumber?.phoneNumber ?? null;
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;
  return {
    phone,
    name: flowStr(body?.customer?.name) ?? flowStr(body?.customer?.firstName),
    customerId: body?.customer?.id != null ? String(body.customer.id) : null,
    orderId: body?.order?.id != null ? String(body.order.id) : null,
  };
}

/** Ingest a Shopify Flow "winback" event → send the re-engagement template.
 *  Idempotent per order cycle (`winback-<orderId>`): Flow retries dedupe, but a
 *  customer who buys again and lapses again re-enters with a NEW order id and
 *  gets the next cycle's message — intended. */
export async function processWinback(
  admin: SupabaseClient,
  storeId: string,
  body: any,
  creds?: StoreCreds | null,
  sendTemplate: typeof sendWhatsappTemplate = sendWhatsappTemplate,
): Promise<{ status: "ok" | "duplicate" }> {
  const seed = winbackSeed(body);
  const webhookId = seed?.orderId
    ? `winback-${seed.orderId}`
    : "winback-" + createHash("sha256").update(JSON.stringify(body ?? {}), "utf8").digest("hex").slice(0, 40);

  const { error: insErr } = await admin.from("webhook_events").insert({
    store_id: storeId,
    topic: "flow/winback",
    shopify_id: seed?.customerId ?? null,
    webhook_id: webhookId,
    processed: false,
  });
  if (insErr) {
    if ((insErr as any).code === "23505") return { status: "duplicate" };
    throw new Error(`webhook_events insert: ${insErr.message}`);
  }

  // Gated send: per-store opt-in + Kapso creds + a phone and a name (the
  // template's {{1}}). Winback has no lead to surface problems on, so the
  // outcome of a skip/failure is recorded in webhook_events.error (visible in
  // the Settings webhook log) — a silent no-send is undebuggable. Best-effort:
  // a send/log failure must never 500 the webhook.
  let outcome: string | null = null;
  if (!seed) outcome = "Omitido: el payload no trae un teléfono utilizable";
  else if (!seed.name) outcome = "Omitido: el cliente no tiene nombre para {{1}}";
  else if (!creds?.winback_template_enabled) outcome = "Omitido: envío deshabilitado en Ajustes";
  else if (!creds.winback_template_name) outcome = "Omitido: falta el nombre de la plantilla en Ajustes";
  else if (!creds.kapso_api_key || !creds.whatsapp_phone_number_id)
    outcome = "Omitido: faltan credenciales de Kapso (API key / número)";
  else {
    try {
      const send = await sendTemplate(
        { apiKey: creds.kapso_api_key },
        {
          phoneNumberId: creds.whatsapp_phone_number_id,
          to: seed.phone,
          templateName: creds.winback_template_name,
          language: creds.winback_template_language ?? "es",
          bodyParams: [seed.name],
        },
      );
      if (!send.ok) outcome = `Falló el envío de «${creds.winback_template_name}»: ${send.error}`;
      // Log on the phone's lead IF one exists (winback never creates leads).
      const { data: lead } = await admin
        .from("leads")
        .select("id")
        .eq("store_id", storeId)
        .eq("phone", seed.phone)
        .maybeSingle();
      if (lead?.id) {
        await admin.from("lead_calls").insert({
          lead_id: lead.id,
          store_id: storeId,
          kind: "system",
          vendedora: null,
          note: send.ok
            ? `📤 WhatsApp: plantilla «${creds.winback_template_name}» enviada (recuperación 60 días)`
            : `⚠️ WhatsApp: falló envío de «${creds.winback_template_name}» (${send.error})`,
        });
      }
    } catch (e) {
      outcome = `Error en el envío: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  await admin
    .from("webhook_events")
    .update({ processed: true, error: outcome })
    .match({ store_id: storeId, webhook_id: webhookId });

  return { status: "ok" };
}

/** COMPLETED draft → recovered → won. The resulting order isn't tag:kapso, so the
 *  order sync (tag:kapso only) never imports it. When given Shopify creds we fetch
 *  that order by gid and capture it in `orders` (marked so the kapso-only rollup
 *  counts its revenue), then link the lead. Returns the recovered order's
 *  created_at (for the daily-rollup recompute) or null. Mirrors linkOrderToLead. */
async function linkCompletedDraftToLead(
  admin: SupabaseClient,
  storeId: string,
  d: DraftOrderRow,
  shopify?: { domain: string; token: string },
): Promise<string | null> {
  let orderId: string | null = null;
  let recoveredAt: string | null = null;
  if (d.order_gid) {
    const numId = extractNumericId(d.order_gid);
    const { data } = await admin
      .from("orders")
      .select("id")
      .eq("store_id", storeId)
      .eq("shopify_order_id", numId)
      .maybeSingle();
    orderId = (data as { id: string } | null)?.id ?? null;
    // Not in our `orders` (the recovered order isn't tag:kapso) → fetch it from
    // Shopify and capture it so its revenue is attributed. Best-effort: a failure
    // here still marks the lead won below.
    if (!orderId && shopify) {
      try {
        const order = await fetchOrderById({ ...shopify, storeId, orderGid: d.order_gid });
        if (order?.shopify_order_id) {
          // `kapso` so the rollup (filters lower(t)='kapso') counts it; `cod_recuperado`
          // keeps recovered sales distinguishable from bot orders.
          order.tags = [...new Set([...order.tags, "kapso", "cod_recuperado"])];
          await admin.from("orders").upsert([order], { onConflict: "store_id,shopify_order_id" });
          recoveredAt = order.created_at;
          const { data: ins } = await admin
            .from("orders")
            .select("id")
            .eq("store_id", storeId)
            .eq("shopify_order_id", order.shopify_order_id)
            .maybeSingle();
          orderId = (ins as { id: string } | null)?.id ?? null;
        }
      } catch {
        /* best-effort */
      }
    }
  }
  await upsertLeadResilient(admin, {
    store_id: storeId,
    phone: d.customer_phone,
    has_order: true,
    order_id: orderId,
    status: "pedido_generado",
    category: "won",
    needs_attention: false,
    draft_order_gid: d.draft_order_gid,
    draft_order_status: "completed",
  });
  return recoveredAt;
}

/**
 * Link a batch of Shopify draft orders to their leads by phone. OPEN carts
 * become callable "cart" leads (created if the phone is new); COMPLETED carts
 * mark the lead won (recovered). Only Releasit COD-form drafts with a phone are
 * linked (isCodFormDraft). Never clobbers a manual disposition or won state.
 */
export async function linkDraftOrdersToLeads(
  admin: SupabaseClient,
  storeId: string,
  drafts: DraftOrderRow[],
  shopify?: { domain: string; token: string },
): Promise<string[]> {
  const eligible = drafts.filter((d) => d.customer_phone && isCodFormDraft(d));
  if (!eligible.length) return [];

  // Which phones already have a lead (with its category, to detect a won lead a
  // repeat cart should reopen).
  const phones = [...new Set(eligible.map((d) => d.customer_phone as string))];
  const existingCategory = new Map<string, string>();
  const existingSource = new Map<string, string | null>();
  {
    const { data } = await admin
      .from("leads")
      .select("phone, category, source")
      .eq("store_id", storeId)
      .in("phone", phones);
    for (const l of (data as { phone: string; category: string; source: string | null }[]) ?? []) {
      existingCategory.set(l.phone, l.category);
      existingSource.set(l.phone, l.source);
    }
  }

  // Latest won order date per phone → a newer open cart means a repeat purchase.
  const orderCreatedAt = new Map<string, string>();
  {
    const { data } = await admin
      .from("orders")
      .select("customer_phone, created_at")
      .eq("store_id", storeId)
      .in("customer_phone", phones)
      .is("cancelled_at", null);
    for (const o of (data as { customer_phone: string | null; created_at: string | null }[]) ?? []) {
      if (!o.customer_phone || !o.created_at) continue;
      const prev = orderCreatedAt.get(o.customer_phone);
      if (!prev || o.created_at > prev) orderCreatedAt.set(o.customer_phone, o.created_at);
    }
  }

  // Last manual call disposition per phone → a repeat cart only reopens a won lead
  // when it post-dates the agent's registered result (don't revert a worked lead).
  const dispositionByPhone = await lastDispositionAtByPhone(admin, storeId, phones);

  const recoveredDates: string[] = []; // created_at of newly-captured recovered orders
  const graceMs = DRAFT_GRACE_MINUTES * 60_000;
  for (const d of eligible) {
    if (d.status === "completed") {
      const at = await linkCompletedDraftToLead(admin, storeId, d, shopify); // a finished sale → won now
      if (at) recoveredDates.push(at);
      continue;
    }
    // OPEN/INVOICE_SENT: hold a brand-new cart for the grace period so we don't
    // call someone who's still checking out. Once it ages past the grace, the next
    // sync (which re-scans the whole window) surfaces it as a callable lead.
    if (d.created_at && Date.now() - new Date(d.created_at).getTime() < graceMs) continue;
    const phone = d.customer_phone as string;
    // Reopen a WON lead when a fresh open cart out-ranks the win — a recompra
    // (cart newer than the order) OR the winning order is no longer active
    // (cancelled/gone, so no `wonAt`) — and the cart post-dates any manual result.
    const reopen = shouldReopenWonCart({
      category: existingCategory.get(phone),
      draftCreatedAt: d.created_at,
      lastOrderAt: orderCreatedAt.get(phone),
      lastDispositionAt: dispositionByPhone.get(phone),
    });
    // On reopen, attribute the lead to the cart if it has no source yet (a bare lead
    // created by the order link) so it shows under "Carrito" in the Fuente filter.
    const fillSource = reopen && !existingSource.get(phone);
    await upsertDraftCartLead(admin, storeId, d, existingCategory.has(phone), reopen, fillSource);
  }
  return recoveredDates;
}

/**
 * Ingest a Kapso WhatsApp conversation webhook (`conversation.ended` /
 * `conversation.inactive` / `conversation.created`) → an abandono lead in real
 * time. A conversation the bot didn't close becomes a "to call" lead; if the
 * phone already has an order it lands as won, and an agent's manual disposition
 * is never overwritten.
 */
export async function ingestConversationEvent(
  admin: SupabaseClient,
  storeId: string,
  body: any,
): Promise<{ ok: boolean; reason?: string }> {
  const conv = body?.conversation ?? body?.data?.conversation ?? null;
  const seed = conv ? conversationToLeadSeed(conv) : null;
  if (!seed) return { ok: false, reason: "no-phone" };

  // Order by phone (non-cancelled) → won linkage.
  const { data: order } = await admin
    .from("orders")
    .select("id")
    .eq("store_id", storeId)
    .eq("customer_phone", seed.phone)
    .is("cancelled_at", null)
    .limit(1)
    .maybeSingle();

  const { data: existing } = await admin
    .from("leads")
    .select("phone, status, handoff_reason, has_order")
    .eq("store_id", storeId)
    .eq("phone", seed.phone)
    .maybeSingle();

  await upsertLeadFromSeed(admin, storeId, seed, {
    hasOrder: Boolean(order?.id),
    orderId: (order as { id: string } | null)?.id ?? null,
    existing: (existing as ExistingLead | null) ?? null,
  });
  return { ok: true };
}

/** Apply a Kapso handoff webhook → hot lead with the bot's reason/context. */
export async function applyHandoff(
  admin: SupabaseClient,
  storeId: string,
  body: any,
): Promise<{ ok: boolean; reason?: string }> {
  const info: HandoffInfo = parseHandoffPayload(body);
  if (!info.phone) return { ok: false, reason: "no-phone" };

  const { data: existing } = await admin
    .from("leads")
    .select("status, has_order")
    .eq("store_id", storeId)
    .eq("phone", info.phone)
    .maybeSingle();

  const handoffFields = {
    handoff_reason: info.reason,
    handoff_context: info.context,
    handoff_at: new Date().toISOString(),
  };

  if (existing?.has_order) {
    // Already won — keep state, just record the context.
    await admin.from("leads").update(handoffFields).eq("store_id", storeId).eq("phone", info.phone);
    return { ok: true };
  }

  const auto = deriveAutoState({ handoffReason: info.reason ?? undefined, handoffContext: info.context });
  const row: any = {
    store_id: storeId,
    phone: info.phone,
    kapso_conversation_id: info.conversationId,
    ...handoffFields,
    status: auto.status,
    category: auto.category,
    needs_attention: auto.needsAttention,
    last_interaction_at: new Date().toISOString(),
  };
  if (info.name) row.name = info.name;
  await admin.from("leads").upsert(row, { onConflict: "store_id,phone" });

  // Activity log entry (system).
  const { data: lead } = await admin
    .from("leads")
    .select("id")
    .eq("store_id", storeId)
    .eq("phone", info.phone)
    .maybeSingle();
  if (lead?.id) {
    await admin.from("lead_calls").insert({
      lead_id: lead.id,
      store_id: storeId,
      kind: "system",
      new_status: auto.status,
      note: info.context,
    });
  }
  return { ok: true };
}
