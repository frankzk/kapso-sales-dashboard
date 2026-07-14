// Lead ingestion: build/maintain leads from Kapso conversations, link them to
// Shopify orders, and apply bot handoffs (Yape/hot). Service-role only.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  conversationToLeadSeed,
  fetchAllConversationsRich,
  fetchConversationSignals,
  fetchKapsoImageBase64,
  parseHandoffPayload,
  sendWhatsappTemplate,
  type HandoffInfo,
  type KapsoClientOpts,
  type LeadSeed,
  type VoucherCandidate,
} from "@/lib/kapso";
import { env } from "@/lib/env";
import { analyzeYapeVoucher } from "@/lib/vision";
import type { StoreCreds } from "@/lib/ingest";
import { deriveAutoState, nextLeadState } from "@/lib/leads";
import { tzParts } from "@/lib/metrics";
import { normalizePhone } from "@/lib/phone";
import {
  DRAFT_GRACE_MINUTES,
  extractNumericId,
  fetchOrderById,
  isCodFormDraft,
  isRecoveredDraft,
} from "@/lib/shopify";
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
  visionChecks: number; // voucher images analyzed by the vision check this run
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
  visionChecks: 0,
};

// Per-run budget on Yape voucher vision checks (one Claude call per new image).
// Only the specific Yape-Shalom flow produces candidates and each image is
// analyzed once ever (yape_vision_checks dedup), so steady state is a handful;
// this just bounds a first-run backlog.
const YAPE_VISION_RUN_CAP = 12;

/** Injectable image→verdict analyzer, so the gate is testable without a network.
 *  `ok:false` marks a failure (timeout/HTTP/parse) the caller must not persist. */
export type YapeVisionAnalyzer = (
  base64: string,
  contentType: string | null,
) => Promise<{ isVoucher: boolean; indicators: Record<string, unknown>; model: string; ok: boolean }>;

export interface YapeVisionOutcome {
  voucher: boolean; // any candidate turned out to be a real voucher
  analyzed: number; // model calls made this invocation (success OR error) — counts toward the cap
}

/**
 * Decide via a vision check whether any candidate image is a genuine Yape
 * voucher. Dedups against `yape_vision_checks` (each image analyzed once ever)
 * and records every DECIDED verdict for audit. Bounded by `cap`. Never throws.
 *
 * Two guardrails learned the hard way:
 *  - If the dedup SELECT errors (table absent = pending migration, or DB down),
 *    we SKIP entirely — otherwise, with the table missing, every run would
 *    re-fetch + re-analyze (and re-bill) the same images forever, recording
 *    nothing. The SELECT doubles as a "is the feature installed?" probe.
 *  - A vision CALL that fails (`ok:false`: outage/timeout/HTTP/parse) is NOT
 *    recorded, so it retries next run — but it still counts toward `cap`, so a
 *    provider outage can't turn into an unbounded fetch/analyze storm.
 */
export async function detectYapeByVision(
  admin: SupabaseClient,
  storeId: string,
  k: KapsoClientOpts,
  candidates: VoucherCandidate[],
  analyze: YapeVisionAnalyzer,
  opts?: {
    cap?: number;
    fetchImage?: (url: string) => Promise<{ base64: string; contentType: string | null } | null>;
  },
): Promise<YapeVisionOutcome> {
  if (!candidates.length) return { voucher: false, analyzed: 0 };
  const cap = opts?.cap ?? YAPE_VISION_RUN_CAP;
  if (cap <= 0) return { voucher: false, analyzed: 0 };
  const fetchImage = opts?.fetchImage ?? ((url: string) => fetchKapsoImageBase64(k, url));

  // Dedup + install probe: which of these images did we already analyze? A query
  // ERROR (missing table / DB issue) means we can't record results either, so
  // skip rather than analyze-without-recording (which would re-bill every run).
  const { data, error } = await admin
    .from("yape_vision_checks")
    .select("message_id, is_voucher")
    .eq("store_id", storeId)
    .in(
      "message_id",
      candidates.map((c) => c.messageId),
    );
  if (error) return { voucher: false, analyzed: 0 };
  const decided = new Map<string, boolean>();
  for (const r of (data as { message_id: string; is_voucher: boolean }[] | null) ?? []) {
    decided.set(r.message_id, r.is_voucher);
  }
  // A prior run already confirmed one → done, no new calls.
  for (const c of candidates) if (decided.get(c.messageId) === true) return { voucher: true, analyzed: 0 };

  let voucher = false;
  let analyzed = 0;
  for (const c of candidates) {
    if (decided.has(c.messageId)) continue; // already analyzed (was false)
    if (analyzed >= cap) break;
    const img = await fetchImage(c.mediaUrl);
    if (!img) continue; // couldn't read the image — retry next run (not a model call)
    analyzed += 1; // a model call is about to happen — count it toward the cap
    const verdict = await analyze(img.base64, img.contentType);
    if (!verdict.ok) continue; // transient failure — DON'T record; retry next run
    // Record the decided verdict for dedup + audit. Best-effort; ignore
    // duplicates from a concurrent run.
    try {
      await admin.from("yape_vision_checks").upsert(
        {
          store_id: storeId,
          message_id: c.messageId,
          is_voucher: verdict.isVoucher,
          indicators: verdict.indicators ?? {},
          model: verdict.model,
        },
        { onConflict: "store_id,message_id", ignoreDuplicates: true },
      );
    } catch {
      /* concurrent-run race — ignore */
    }
    if (verdict.isVoucher) voucher = true;
  }
  return { voucher, analyzed };
}

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
 * `source`, read its conversation: a structured CTWA referral → `meta_ad`, a
 * Facebook/IG web link in the opening message → `fb_web`; anything else → the
 * bot/organic sentinel so it's marked checked and not re-fetched. Bounded per run, ordered
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

  // Vision check is opt-in (needs ANTHROPIC_API_KEY); build the analyzer once so
  // the per-conversation gate is cheap. Bounded per run by `visionRemaining`.
  const visionKey = env.anthropicApiKey();
  const visionModel = env.yapeVisionModel();
  const visionApiBase = env.anthropicApiBase();
  const visionAnalyze: YapeVisionAnalyzer | null = visionKey
    ? (b64, ct) => analyzeYapeVoucher(b64, ct, { apiKey: visionKey, model: visionModel, apiBase: visionApiBase })
    : null;
  let visionRemaining = YAPE_VISION_RUN_CAP;

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

    // Yape/Shalom advance detection. The text/caption detector (`sig.yape`)
    // handles the explicit cases. When it's silent but the customer sent a bare
    // IMAGE after the bot asked for the adelanto/voucher, read that image with a
    // vision check before firing — so a random screenshot never trips the alert,
    // only a real voucher (Yape interface + monto + destinatario + estado + nº).
    // Vision is opt-in (key present) and bounded/deduped; without it we keep the
    // conservative text-only behavior.
    let yapeConfirmed = sig.yape;
    if (!yapeConfirmed && visionAnalyze && visionRemaining > 0 && sig.voucherCandidates.length) {
      const outcome = await detectYapeByVision(admin, storeId, k, sig.voucherCandidates, visionAnalyze, {
        cap: visionRemaining,
      });
      visionRemaining -= outcome.analyzed;
      stats.visionChecks += outcome.analyzed;
      yapeConfirmed = outcome.voucher;
    }

    // Promote the auto-"nuevo" lead to yape_por_verificar (hot). Only "nuevo" is
    // touched — manual dispositions and won leads keep their state; already-hot
    // leads are left as-is.
    if (yapeConfirmed) {
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

/**
 * Should a fresh OPEN cart re-open a lead currently `lost` — typically one
 * auto-archived by inactivity (`archiveStaleLeads`)? Yes when the cart was created
 * WITHIN the stale window (a genuine fresh signal, not the same old cart that
 * caused the archive — which would ping-pong reopen↔archive) AND it post-dates the
 * agent's last MANUAL result (never revert a just-registered "ya compró en otro
 * lado"). Pure; mirrors shouldReopenWonCart for the archived case.
 */
export function shouldReopenLostCart(opts: {
  category: string | undefined;
  draftCreatedAt: string | null;
  lastDispositionAt: string | null | undefined;
  staleCutoff: string; // now − STALE_LEAD_DAYS (ISO); a cart older than this is dead
}): boolean {
  if (opts.category !== "lost") return false;
  if (!opts.draftCreatedAt || opts.draftCreatedAt <= opts.staleCutoff) return false;
  return eventOverridesDisposition(opts.draftCreatedAt, opts.lastDispositionAt);
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
  for (const c of ["draft_order_name", "draft_order_status", "draft_order_url", "province", "region", "referencia", "address1", "ship_name"]) {
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
  const seen = d.updated_at ?? d.created_at; // the cart's activity time
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
    address1: d.address1,
    ship_name: d.customer_name, // shipping recipient (may differ from lead.name)
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
    if (seen) row.last_interaction_at = seen;
  } else if (reopen) {
    // Recompra, o sobra de una orden cancelada, o un lead auto-archivado: un carrito
    // abierto fresco lo vuelve a poner como llamable. Atribuye a "carrito" si no tenía fuente.
    row.status = "nuevo";
    row.category = "open";
    row.needs_attention = false;
    if (fillSource) row.source = COD_CART_SOURCE;
  }
  await upsertLeadResilient(admin, row);

  // A fresh cart is a fresh signal of interest → advance the staleness clock so a
  // new cart on an EXISTING lead isn't auto-archived (archiveStaleLeads keys on
  // last_interaction_at). Advance-only (`.lt`): never regress a newer WhatsApp
  // interaction; a null clock isn't archived anyway. New leads already set it above.
  if (exists && seen && d.customer_phone) {
    await admin
      .from("leads")
      .update({ last_interaction_at: seen })
      .eq("store_id", storeId)
      .eq("phone", d.customer_phone)
      .lt("last_interaction_at", seen);
  }
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
      // Record the send so a later order can be attributed to "recuperación 60d"
      // (order used a winback coupon AND got the template ≤30 días antes). Only
      // successful sends count. Best-effort: a missing winback_sends table (0030
      // not applied yet) must not break the webhook — swallow and move on.
      if (send.ok) {
        try {
          await admin.from("winback_sends").insert({
            store_id: storeId,
            phone: seed.phone,
            template_name: creds.winback_template_name,
            order_gid: seed.orderId ? `gid://shopify/Order/${seed.orderId}` : null,
          });
        } catch {
          /* table may not exist pre-0030 — attribution just misses this send */
        }
      }
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

// ───────────────────── Drip de seguimiento (no contesta) ─────────────────────
// Plantillas de WhatsApp a leads que NO contestan (no_responde/buzon/cuelga) —
// y solo a esos: "contactados" ya tiene conversación humana, "sin llamar" aún
// no fue tocado (sería mentir con "no logramos ubicarte") y "sin stock" no
// tiene novedad que ofrecer. Corre dentro del cron de sync, gateado por tienda.

/** Estados que reciben drip: la asesora llamó y nadie contestó. */
export const DRIP_STATUSES = ["no_responde", "buzon", "cuelga"] as const;
/** Máximo de toques automáticos por lead (después, que decida la asesora). */
export const DRIP_MAX_TOUCHES = 2;
/** Horas de silencio tras la última actividad antes del primer toque. */
export const DRIP_FIRST_TOUCH_HOURS = 6;
/** Horas entre el toque 1 y el toque 2. */
export const DRIP_SECOND_TOUCH_HOURS = 24;
/** Ventana horaria local (tienda) en la que se permite enviar: [inicio, fin). */
export const DRIP_HOUR_START = 9;
export const DRIP_HOUR_END = 20;
/** Tope de envíos por tienda por corrida del cron (drena de a pocos). */
export const DRIP_BATCH_CAP = 25;

export interface DripLead {
  id: string;
  phone: string;
  name: string | null;
  status: string;
  needs_attention: boolean;
  next_followup_at: string | null;
  last_interaction_at: string | null;
  last_inbound_at: string | null;
  drip_touches: number | null;
  last_drip_at: string | null;
}

/**
 * Por qué un lead NO recibe drip ahora (null = elegible). Pure — es LA regla
 * del drip, el fetch solo pre-filtra en SQL lo barato. Guardas, en orden:
 * status fuera de nr/buzón/cuelga; atención pendiente (respondió o venció un
 * seguimiento → lo ve la asesora, no el bot); agenda manual (next_followup_at
 * manda); tope de toques; sin nombre (la plantilla lleva {{1}}); actividad
 * hace <6h (llamada, mensaje o lo que sea — el silencio aún no es silencio);
 * toque 2 antes de 24h del toque 1; o el cliente escribió DESPUÉS del último
 * drip (last_inbound_at > last_drip_at ⇒ ya no es "no contesta").
 */
export function dripSkipReason(l: DripLead, nowMs: number): string | null {
  if (!(DRIP_STATUSES as readonly string[]).includes(l.status)) return "status";
  if (l.needs_attention) return "atencion";
  if (l.next_followup_at) return "agendado";
  if ((l.drip_touches ?? 0) >= DRIP_MAX_TOUCHES) return "tope";
  if (!l.name) return "sin_nombre";
  const lastAct = l.last_interaction_at ? Date.parse(l.last_interaction_at) : NaN;
  if (!Number.isFinite(lastAct) || nowMs - lastAct < DRIP_FIRST_TOUCH_HOURS * 3_600_000) return "reciente";
  if (l.last_drip_at) {
    if (nowMs - Date.parse(l.last_drip_at) < DRIP_SECOND_TOUCH_HOURS * 3_600_000) return "espera_toque2";
    if (l.last_inbound_at && l.last_inbound_at > l.last_drip_at) return "respondio";
  }
  return null;
}

/** ¿Estamos en horario de envío (9–20) en la zona de la tienda? Pure. */
export function dripWithinHours(nowIso: string, tz: string): boolean {
  const h = tzParts(nowIso, tz).hour;
  return h >= DRIP_HOUR_START && h < DRIP_HOUR_END;
}

export interface DripReport {
  sent: number;
  failed: number;
  skipped: number; // candidatos SQL descartados por la regla fina (incl. sin nombre)
}

/**
 * Un pase del drip para una tienda: selecciona los leads elegibles (SQL grueso
 * + `dripSkipReason` fino), envía la plantilla y registra el toque. El toque se
 * CONSUME aunque el envío falle (drip_touches++) para no re-martillar cada 5
 * min un número que Meta rechaza — el motivo queda en drip_sends.error y en el
 * timeline del lead. No toca last_interaction_at (es actividad nuestra, no del
 * cliente: resetearlo alargaría la vida del lead en cola y desordenaría la
 * lista) ni el status (el lead sigue en "En seguimiento"). Pre-0035 nunca
 * llega aquí: getStoreCreds devuelve drip_template_enabled=false sin columnas.
 */
export async function sendSeguimientoDrip(
  admin: SupabaseClient,
  storeId: string,
  creds: StoreCreds,
  sendTemplate: typeof sendWhatsappTemplate = sendWhatsappTemplate,
  nowIso = new Date().toISOString(),
): Promise<DripReport> {
  const report: DripReport = { sent: 0, failed: 0, skipped: 0 };
  if (!creds.drip_template_enabled || !creds.drip_template_name) return report;
  if (!creds.kapso_api_key || !creds.whatsapp_phone_number_id) return report;
  if (!dripWithinHours(nowIso, creds.timezone || "America/Lima")) return report;

  const nowMs = Date.parse(nowIso);
  const quietSinceIso = new Date(nowMs - DRIP_FIRST_TOUCH_HOURS * 3_600_000).toISOString();
  const { data, error } = await admin
    .from("leads")
    .select(
      "id, phone, name, status, needs_attention, next_followup_at, last_interaction_at, last_inbound_at, drip_touches, last_drip_at",
    )
    .eq("store_id", storeId)
    .in("status", [...DRIP_STATUSES])
    .eq("needs_attention", false)
    .is("next_followup_at", null)
    .lt("drip_touches", DRIP_MAX_TOUCHES)
    .lte("last_interaction_at", quietSinceIso)
    .order("last_interaction_at", { ascending: true }) // los más olvidados primero
    .limit(200);
  if (error) throw new Error(`drip select: ${error.message}`);

  const rows = (data as DripLead[] | null) ?? [];
  const eligible = rows.filter((l) => dripSkipReason(l, nowMs) === null);
  report.skipped = rows.length - eligible.length;
  const batch = eligible.slice(0, DRIP_BATCH_CAP);

  for (const l of batch) {
    const touch = (l.drip_touches ?? 0) + 1;
    let ok = false;
    let err: string | null = null;
    try {
      const send = await sendTemplate(
        { apiKey: creds.kapso_api_key },
        {
          phoneNumberId: creds.whatsapp_phone_number_id,
          to: l.phone,
          templateName: creds.drip_template_name,
          language: creds.drip_template_language ?? "es",
          bodyParams: [l.name!],
        },
      );
      ok = send.ok;
      if (!send.ok) err = send.error ?? "envío rechazado";
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }

    await admin
      .from("leads")
      .update({ drip_touches: touch, last_drip_at: nowIso })
      .eq("id", l.id);
    await admin.from("drip_sends").insert({
      store_id: storeId,
      lead_id: l.id,
      phone: l.phone,
      template_name: creds.drip_template_name,
      touch,
      ok,
      error: err,
    });
    await admin.from("lead_calls").insert({
      lead_id: l.id,
      store_id: storeId,
      kind: "system",
      vendedora: null,
      note: ok
        ? `📤 Drip: plantilla «${creds.drip_template_name}» enviada (toque ${touch}/${DRIP_MAX_TOUCHES})`
        : `⚠️ Drip: falló envío de «${creds.drip_template_name}» (${err})`,
    });
    if (ok) report.sent += 1;
    else report.failed += 1;
  }
  return report;
}

/** COMPLETED draft → won lead, y SOLO si fue una recuperación real (el draft
 *  estuvo abandonado ≥30 min o la orden trae tag de abandono — isRecoveredDraft)
 *  se captura la orden en `orders` con `kapso`+`cod_recuperado` para que el
 *  rollup kapso-only cuente su ingreso. Un draft que se completó al instante es
 *  una compra COD normal (EasySell crea y completa un draft por CADA pedido):
 *  NO se etiqueta, NO entra a orders/rollups y NO crea un lead nuevo — solo
 *  marca won un lead que YA existía (el cliente sí compró). Returns the
 *  recovered order's created_at (for the daily-rollup recompute) or null. */
async function linkCompletedDraftToLead(
  admin: SupabaseClient,
  storeId: string,
  d: DraftOrderRow,
  leadExists: boolean,
  shopify?: { domain: string; token: string },
): Promise<string | null> {
  let orderId: string | null = null;
  let recoveredAt: string | null = null;
  let recovered = isRecoveredDraft({ createdAt: d.created_at, completedAt: d.completed_at });
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
    // Shopify and, ONLY when it's a genuine recovery, capture it so its revenue
    // is attributed. Best-effort: a fetch failure still links the lead below.
    if (!orderId && shopify) {
      try {
        const order = await fetchOrderById({ ...shopify, storeId, orderGid: d.order_gid });
        if (order?.shopify_order_id) {
          recovered = isRecoveredDraft({
            createdAt: d.created_at,
            completedAt: d.completed_at,
            orderTags: order.tags, // el tag de abandono (p.ej. easysell-abandoned-checkout) también prueba la recuperación
          });
          if (recovered) {
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
        }
      } catch {
        /* best-effort */
      }
    }
  }
  // Una compra normal instantánea sin lead previo no genera lead: no hubo gestión
  // ni recuperación que registrar (crearlo solo ensuciaba la cola y los ganados).
  if (!orderId && !leadExists && !recovered) return null;
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
  // Carts created before this are "dead" (past the auto-archive window) — a lost
  // lead only reopens for a cart fresher than this, so it never ping-pongs.
  const staleCutoff = new Date(Date.now() - STALE_LEAD_DAYS * 86_400_000).toISOString();

  const recoveredDates: string[] = []; // created_at of newly-captured recovered orders
  const graceMs = DRAFT_GRACE_MINUTES * 60_000;
  for (const d of eligible) {
    if (d.status === "completed") {
      const leadExists = existingCategory.has(d.customer_phone as string);
      const at = await linkCompletedDraftToLead(admin, storeId, d, leadExists, shopify); // a finished sale → won now
      if (at) recoveredDates.push(at);
      continue;
    }
    // OPEN/INVOICE_SENT: hold a brand-new cart for the grace period so we don't
    // call someone who's still checking out. Once it ages past the grace, the next
    // sync (which re-scans the whole window) surfaces it as a callable lead.
    if (d.created_at && Date.now() - new Date(d.created_at).getTime() < graceMs) continue;
    const phone = d.customer_phone as string;
    const category = existingCategory.get(phone);
    const lastDispositionAt = dispositionByPhone.get(phone);
    // Reopen a WON lead when a fresh open cart out-ranks the win — a recompra
    // (cart newer than the order) OR the winning order is no longer active
    // (cancelled/gone, so no `wonAt`) — and the cart post-dates any manual result.
    // Also reopen a LOST lead (usually auto-archived by inactivity) when a genuinely
    // fresh cart arrives — the customer came back — so a new cart never shows under
    // a "Perdido".
    const reopen =
      shouldReopenWonCart({
        category,
        draftCreatedAt: d.created_at,
        lastOrderAt: orderCreatedAt.get(phone),
        lastDispositionAt,
      }) ||
      shouldReopenLostCart({ category, draftCreatedAt: d.created_at, lastDispositionAt, staleCutoff });
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
