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
  if (seed.last_interaction_at) row.last_interaction_at = seed.last_interaction_at;
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
  await admin.from("leads").upsert(row, { onConflict: "store_id,phone" });
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
      { phoneNumberId: creds.whatsapp_phone_number_id ?? undefined, lastActiveAfter: cursor ?? undefined },
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
      .eq("kapso_conversation_id", convId);

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
