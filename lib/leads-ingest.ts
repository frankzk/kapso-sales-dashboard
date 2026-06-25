// Lead ingestion: build/maintain leads from Kapso conversations, link them to
// Shopify orders, and apply bot handoffs (Yape/hot). Service-role only.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  conversationToLeadSeed,
  fetchAllConversationsRich,
  fetchConversationSignals,
  parseHandoffPayload,
  type HandoffInfo,
  type KapsoClientOpts,
  type LeadSeed,
} from "@/lib/kapso";
import { deriveAutoState, nextLeadState } from "@/lib/leads";
import { extractNumericId, isCodFormDraft } from "@/lib/shopify";
import { COD_CART_SOURCE, type DraftOrderRow, type OrderLineItem } from "@/lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Per-run cap on lead enrichment message fetches (one Kapso message page each).
const LEAD_ENRICH_CAP = 80;

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
  ctx: { hasOrder: boolean; orderId?: string | null; existing: ExistingLead | null },
): Promise<void> {
  const ns = nextLeadState(
    ctx.existing ? { status: ctx.existing.status, handoff_reason: ctx.existing.handoff_reason } : null,
    { hasOrder: ctx.hasOrder },
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
    await setCursor(admin, storeId, cursor, "ok");
    return { touched: 0, enriched };
  }

  // Orders by phone (non-cancelled) → won linkage.
  const orderIdByPhone = new Map<string, string>();
  {
    const { data } = await admin
      .from("orders")
      .select("id, customer_phone")
      .eq("store_id", storeId)
      .in("customer_phone", phones)
      .is("cancelled_at", null);
    for (const o of (data as { id: string; customer_phone: string }[]) ?? []) {
      if (o.customer_phone) orderIdByPhone.set(o.customer_phone, o.id);
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

  let maxTs = cursor;
  for (const phone of phones) {
    const seed = seeds.get(phone)!;
    const existing = existingByPhone.get(phone) ?? null;
    const hasOrder = orderIdByPhone.has(phone);
    await upsertLeadFromSeed(admin, storeId, seed, {
      hasOrder,
      orderId: orderIdByPhone.get(phone) ?? null,
      existing,
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

  await setCursor(admin, storeId, maxTs, "ok");
  return { touched: phones.length, enriched };
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
    await admin
      .from("leads")
      .update({
        inbound_count: sig.inbound_count,
        district: sig.district,
        cart_value: sig.cart_value,
        cart_item_count: sig.cart_item_count,
        cart_summary: sig.cart_summary,
      })
      .eq("store_id", storeId)
      .eq("kapso_conversation_id", convId)
      // Never clobber cart/district that came from a real Shopify draft order:
      // the draft (linkDraftOrdersToLeads) is the source of truth; this WhatsApp
      // parse is only the fallback for leads that have no draft.
      .is("draft_order_gid", null);

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

/** Mark the lead for an order's customer as won (sticky), creating it if new. */
export async function linkOrderToLead(
  admin: SupabaseClient,
  params: { storeId: string; phone: string | null; orderId: string | null },
): Promise<void> {
  if (!params.phone) return;
  await admin.from("leads").upsert(
    {
      store_id: params.storeId,
      phone: params.phone,
      has_order: true,
      order_id: params.orderId,
      status: "pedido_generado",
      category: "won",
      needs_attention: false,
    },
    { onConflict: "store_id,phone" },
  );
}

/**
 * Link a batch of synced orders to their leads (won) by phone. Resolves each
 * order's row id once, then marks the matching lead. Lets a full order re-sync
 * backfill linkage for historical orders (mirrors the webhook path).
 */
export async function linkOrdersToLeads(
  admin: SupabaseClient,
  storeId: string,
  orders: { shopify_order_id: number | string | null; customer_phone?: string | null }[],
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

  for (const o of withPhone) {
    await linkOrderToLead(admin, {
      storeId,
      phone: o.customer_phone ?? null,
      orderId: idByShopifyId.get(String(o.shopify_order_id)) ?? null,
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

/** OPEN/INVOICE_SENT draft → ensure a callable "cart" lead (create if new). */
async function upsertDraftCartLead(
  admin: SupabaseClient,
  storeId: string,
  d: DraftOrderRow,
  exists: boolean,
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
  }
  await upsertLeadResilient(admin, row);
}

/** COMPLETED draft → recovered → won (the resulting order usually isn't
 *  tag:kapso, so the order sync wouldn't flip it). Mirrors linkOrderToLead. */
async function linkCompletedDraftToLead(
  admin: SupabaseClient,
  storeId: string,
  d: DraftOrderRow,
): Promise<void> {
  let orderId: string | null = null;
  if (d.order_gid) {
    const { data } = await admin
      .from("orders")
      .select("id")
      .eq("store_id", storeId)
      .eq("shopify_order_id", extractNumericId(d.order_gid))
      .maybeSingle();
    orderId = (data as { id: string } | null)?.id ?? null;
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
): Promise<void> {
  const eligible = drafts.filter((d) => d.customer_phone && isCodFormDraft(d));
  if (!eligible.length) return;

  // Which phones already have a lead (so we never re-open a manual/won lead).
  const phones = [...new Set(eligible.map((d) => d.customer_phone as string))];
  const exists = new Set<string>();
  {
    const { data } = await admin
      .from("leads")
      .select("phone")
      .eq("store_id", storeId)
      .in("phone", phones);
    for (const l of (data as { phone: string }[]) ?? []) exists.add(l.phone);
  }

  for (const d of eligible) {
    if (d.status === "completed") {
      await linkCompletedDraftToLead(admin, storeId, d);
    } else {
      await upsertDraftCartLead(admin, storeId, d, exists.has(d.customer_phone as string));
    }
  }
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
