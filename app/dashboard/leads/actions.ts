"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { getCustomerHistory, getLeadWithCalls, type CustomerHistory } from "@/lib/leads-access";
import { CLAIM_TTL_MINUTES, canDispositionLead, categoryOf, isValidStatus, labelOf } from "@/lib/leads";
import {
  OFFER_TTL_MS,
  ONLINE_TTL_MS,
  planYapeOffers,
  type RoutingAdvisor,
  type RoutingLead,
} from "@/lib/yape-routing";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadCallRow, LeadRow } from "@/lib/types";
import { getStoreCreds } from "@/lib/ingest";
import {
  completeDraftOrder,
  createDraftOrder,
  extractNumericId,
  getCustomerRecentOrders,
  getDraftOrderForEdit,
  resolveOrderDiscount,
  searchCatalogProducts,
  updateDraftOrder,
  type ProductSearchResult,
} from "@/lib/shopify";
import {
  fetchConversationTranscript,
  fetchLastInboundAt,
  listConversationsByPhone,
  mergeTranscripts,
  sendWhatsappDocument,
  sendWhatsappImage,
  sendWhatsappText,
  sendWhatsappVideo,
  templateProductParam,
  type ConversationMessage,
} from "@/lib/kapso";
import { getWaNumbers } from "@/lib/access";

// Process-level cache of vendedora id → display name (emails ~never change).
const agentNameCache = new Map<string, string>();

/**
 * Resolve a vendedora's display name (email local-part), cached process-wide.
 * Returns null if the lookup fails (left uncached so it retries next time) —
 * same semantics the call-history resolver has always used.
 */
async function resolveAgentName(
  userId: string,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<string | null> {
  if (agentNameCache.has(userId)) return agentNameCache.get(userId)!;
  try {
    const { data } = await admin.auth.admin.getUserById(userId);
    const email = data?.user?.email ?? null;
    const name = email ? email.split("@")[0]! : userId.slice(0, 8);
    agentNameCache.set(userId, name);
    return name;
  } catch {
    return null; // leave unresolved — retried next call
  }
}

export interface LeadActionState {
  error?: string;
  notice?: string;
  windowClosed?: boolean; // the 24h WhatsApp session window is closed (retry won't help)
}

/** A Yape/Shalom lead awaiting verification, surfaced to advisors as a pop-up. */
export interface YapeAlert {
  id: string;
  storeId: string;
  name: string | null;
  phone: string;
  cartSummary: string | null;
  handoffContext: string | null;
  lastInboundAt: string | null;
}

/** Fetch a lead + its call history (RLS-scoped). Drives the drawer client-side. */
export async function loadLeadDetail(
  leadId: string,
): Promise<
  { lead: LeadRow; calls: LeadCallRow[]; customerHistory: CustomerHistory | null } | { error: string }
> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };
  const detail = await getLeadWithCalls(leadId);
  if (!detail) return { error: "No encontrado." };

  // Resolve who logged each entry (vendedora id → display name) for the history.
  const ids = [...new Set(detail.calls.map((c) => c.vendedora).filter(Boolean))] as string[];
  if (ids.length) {
    const admin = createAdminSupabase();
    await Promise.all(ids.map((id) => resolveAgentName(id, admin)));
  }
  const calls = detail.calls.map((c) => ({
    ...c,
    vendedora_name: c.vendedora ? (agentNameCache.get(c.vendedora) ?? null) : null,
  }));
  // Recurrent-customer block: prior purchases for this phone (excl. its own order).
  // The local `orders` table is kapso-only (migration 0006), so purchases placed
  // outside the bot never land there. Shopify can't search orders by phone, so we
  // resolve the customer by phone and read THEIR orders directly — that's the only
  // source that reflects ALL of the customer's history. Best-effort: needs the
  // read_customers scope; if the store hasn't re-authorized (or the call fails) we
  // keep the local list as a fallback. The store creds are fetched once here and
  // reused to build the admin deep-links for both the Shopify and local lists.
  const creds = await getStoreCreds(ctx.storeId);
  const customerHistory = await getCustomerHistory(
    ctx.storeId,
    detail.lead.phone,
    detail.lead.order_id,
    creds?.shopify_domain ?? null,
  );
  if (customerHistory && detail.lead.phone && creds?.shopify_token) {
    try {
      const shopOrders = await getCustomerRecentOrders(
        { domain: creds.shopify_domain, token: creds.shopify_token },
        detail.lead.phone,
        { excludeName: customerHistory.currentOrderName, limit: 3 },
      );
      if (shopOrders.length) customerHistory.recentOrders = shopOrders;
    } catch {
      /* keep the local fallback list */
    }
  }

  // Recover the browsed product for legacy búsqueda leads whose cart_summary was
  // wiped before the additive-enrich fix. The product still lives on Kapso as the
  // LAST param of the re-engagement template we sent; pull it, show it now, and
  // self-heal the row so it persists (and the "🔎 Vio:" card shows next time too).
  if (
    detail.lead.source === "abandoned_browse" &&
    !detail.lead.cart_summary &&
    creds?.kapso_api_key &&
    creds.browse_template_name
  ) {
    try {
      let convId = detail.lead.kapso_conversation_id;
      if (!convId && detail.lead.phone) {
        const convs = await listConversationsByPhone({ apiKey: creds.kapso_api_key }, detail.lead.phone);
        convId = convs[0]?.id != null ? String(convs[0].id) : null;
      }
      if (convId) {
        const msgs = await fetchConversationTranscript({ apiKey: creds.kapso_api_key }, convId);
        const product = templateProductParam(msgs, creds.browse_template_name);
        if (product) {
          detail.lead.cart_summary = product;
          await createAdminSupabase()
            .from("leads")
            .update({ cart_summary: product })
            .eq("id", leadId)
            .is("cart_summary", null); // don't overwrite if it got set meanwhile
        }
      }
    } catch {
      /* best-effort recovery — never break the drawer */
    }
  }
  return { lead: detail.lead, calls, customerHistory };
}

/**
 * Lightweight liveness poll for the open drawer: just the lead's order/status
 * signal, so the client can detect when a pending lead flips to won (an order
 * placed via Yape/bot links a few seconds later) and refresh itself — instead of
 * showing a stale "pendiente" state and, e.g., letting an advisor mistakenly mark
 * a real sale as lost. RLS-scoped, cheap (one indexed row), never throws.
 */
export async function pollLeadState(
  leadId: string,
): Promise<{ hasOrder: boolean; status: string | null; category: string | null } | { error: string }> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };
  const sb = await createServerSupabase();
  const { data } = await sb.from("leads").select("has_order, status, category").eq("id", leadId).maybeSingle();
  const l = data as { has_order: boolean; status: string | null; category: string | null } | null;
  if (!l) return { error: "No encontrado." };
  return { hasOrder: !!l.has_order, status: l.status, category: l.category };
}

/**
 * Search leads in a store by name OR phone, across ALL stages (RLS-scoped, so a
 * user only ever matches rows in stores they may access). Powers the leads
 * search box. Two ILIKE passes (name + phone digits) merged + deduped, most
 * recent first, capped. Returns [] for queries shorter than 2 chars.
 */
export async function searchLeads(storeId: string, query: string): Promise<LeadRow[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const sb = await createServerSupabase();
  const nameLike = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`; // escape LIKE wildcards
  const digits = q.replace(/\D/g, "");
  const passes = [
    sb
      .from("leads")
      .select("*")
      .eq("store_id", storeId)
      .ilike("name", nameLike)
      .order("last_interaction_at", { ascending: false })
      .limit(40),
  ];
  if (digits.length >= 2) {
    passes.push(
      sb
        .from("leads")
        .select("*")
        .eq("store_id", storeId)
        .ilike("phone", `%${digits}%`)
        .order("last_interaction_at", { ascending: false })
        .limit(40),
    );
  }
  const settled = await Promise.all(passes);
  const byId = new Map<string, LeadRow>();
  for (const { data } of settled) {
    for (const r of (data as LeadRow[] | null) ?? []) byId.set(r.id!, r);
  }
  return [...byId.values()]
    .sort((a, b) => (b.last_interaction_at ?? "").localeCompare(a.last_interaction_at ?? ""))
    .slice(0, 40);
}

/** Authorize: the caller must be able to SEE the lead under RLS. Returns its store. */
async function authorizeLead(leadId: string): Promise<{ userId: string; storeId: string } | null> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data } = await sb.from("leads").select("store_id").eq("id", leadId).maybeSingle();
  if (!data) return null;
  return { userId: user.id, storeId: data.store_id as string };
}

/** Claim a lead (one at a time). Succeeds if free, stale, or already mine. */
export async function claimLead(leadId: string): Promise<LeadActionState> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };

  const admin = createAdminSupabase();
  const cutoff = new Date(Date.now() - CLAIM_TTL_MINUTES * 60_000).toISOString();
  // NOTE: keep this update on the CORE columns only. Opening any lead calls
  // claimLead, so it must never depend on the Yape-routing columns (a lead that
  // gets claimed leaves the rotation anyway — listYapeAlerts/reconcile exclude
  // claimed leads). This keeps the drawer working even if migration 0020 lags.
  const { data, error } = await admin
    .from("leads")
    .update({ claimed_by: ctx.userId, claimed_at: new Date().toISOString() })
    .eq("id", leadId)
    .or(`claimed_by.is.null,claimed_by.eq.${ctx.userId},claimed_at.lt.${cutoff}`)
    .select("id")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) {
    // The claim failed because someone else holds a fresh one — name them so the
    // advisor sees exactly who's on it (not a generic "otro vendedor").
    const { data: held } = await admin
      .from("leads")
      .select("claimed_by")
      .eq("id", leadId)
      .maybeSingle();
    const holderId = (held as { claimed_by: string | null } | null)?.claimed_by ?? null;
    const who = holderId && holderId !== ctx.userId ? await resolveAgentName(holderId, admin) : null;
    return { error: who ? `${who} está atendiendo este lead.` : "Otro vendedor está atendiendo este lead." };
  }
  revalidatePath("/dashboard/leads");
  return { notice: "Lead tomado." };
}

/** Release a claim (called when closing the drawer). Only releases your own. */
export async function releaseLead(leadId: string): Promise<LeadActionState> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso." };
  const admin = createAdminSupabase();
  await admin
    .from("leads")
    .update({ claimed_by: null, claimed_at: null })
    .eq("id", leadId)
    .eq("claimed_by", ctx.userId);
  revalidatePath("/dashboard/leads");
  return { notice: "Liberado." };
}

// ── Yape/Shalom advisor routing (v2) ──────────────────────────────────────────
// Each Yape is offered to ONE online advisor at a time (90s), escalating in an
// infinite loop until someone claims it. Offers are advanced lazily here on each
// poll (no cron). Cross-advisor reads use the service role; only the offered
// advisor ever sees a given Yape (others see nothing).

/** Online vendedoras (presence heartbeat fresh) with access to the store. */
async function onlineVendedoras(
  admin: SupabaseClient,
  storeId: string,
  nowMs: number,
): Promise<RoutingAdvisor[]> {
  const { data: store } = await admin.from("stores").select("org_id").eq("id", storeId).maybeSingle();
  const orgId = (store as { org_id?: string } | null)?.org_id;
  if (!orgId) return [];
  const { data: mem } = await admin
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("role", "vendedora");
  const vendIds = new Set(((mem as { user_id: string }[] | null) ?? []).map((m) => m.user_id));
  if (!vendIds.size) return [];
  const { data: acc } = await admin.from("user_store_access").select("user_id").eq("store_id", storeId);
  const accessIds = ((acc as { user_id: string }[] | null) ?? [])
    .map((a) => a.user_id)
    .filter((id) => vendIds.has(id));
  if (!accessIds.length) return [];
  const onlineCutoff = new Date(nowMs - ONLINE_TTL_MS).toISOString();
  const { data: pres } = await admin
    .from("user_presence")
    .select("user_id, last_seen_at")
    .in("user_id", accessIds)
    .gte("last_seen_at", onlineCutoff);
  return ((pres as { user_id: string; last_seen_at: string }[] | null) ?? []).map((p) => ({
    id: p.user_id,
    lastSeenMs: new Date(p.last_seen_at).getTime(),
  }));
}

/** Advance the rotating offers for one store's active Yapes (lazy, on poll). */
async function reconcileYapeOffers(admin: SupabaseClient, storeId: string, nowMs: number): Promise<void> {
  const claimCutoff = new Date(nowMs - CLAIM_TTL_MINUTES * 60_000).toISOString();
  const { data } = await admin
    .from("leads")
    .select("id, claimed_by, claimed_at, yape_offered_to, yape_offered_at, yape_passed")
    .eq("store_id", storeId)
    .eq("status", "yape_por_verificar")
    .eq("has_order", false);
  const rows = (data as Array<Record<string, unknown>> | null) ?? [];
  if (!rows.length) return;
  const leads: RoutingLead[] = rows.map((r) => ({
    id: r.id as string,
    claimedBy:
      r.claimed_by && typeof r.claimed_at === "string" && r.claimed_at >= claimCutoff
        ? (r.claimed_by as string)
        : null,
    offeredTo: (r.yape_offered_to as string | null) ?? null,
    offeredAtMs: r.yape_offered_at ? new Date(r.yape_offered_at as string).getTime() : null,
    passed: Array.isArray(r.yape_passed) ? (r.yape_passed as string[]) : [],
  }));
  const advisors = await onlineVendedoras(admin, storeId, nowMs);
  const plans = planYapeOffers(leads, advisors, nowMs);
  if (!plans.length) return;
  const offerCutoff = new Date(nowMs - OFFER_TTL_MS).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  for (const p of plans) {
    // Atomic: only (re)assign a free/expired offer, so two concurrent polls can't
    // double-assign (the loser's guard no longer matches).
    await admin
      .from("leads")
      .update({ yape_offered_to: p.offeredTo, yape_offered_at: nowIso, yape_passed: p.passed })
      .eq("id", p.leadId)
      .or(`yape_offered_at.is.null,yape_offered_at.lt.${offerCutoff}`);
  }
}

/**
 * Heartbeat + advance offers + return the Yapes currently offered to ME (fresh).
 * The caller's accessible stores come via RLS; reconciliation uses the service
 * role to see the whole advisor pool. Drives the advisor pop-up.
 */
export async function listYapeAlerts(): Promise<YapeAlert[]> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];
  const admin = createAdminSupabase();
  const nowMs = Date.now();
  await admin.from("user_presence").upsert({ user_id: user.id, last_seen_at: new Date(nowMs).toISOString() });
  const { data: storeRows } = await sb.from("stores").select("id");
  const storeIds = ((storeRows as { id: string }[] | null) ?? []).map((s) => s.id);
  for (const sid of storeIds) await reconcileYapeOffers(admin, sid, nowMs);
  const offerCutoff = new Date(nowMs - OFFER_TTL_MS).toISOString();
  const claimCutoff = new Date(nowMs - CLAIM_TTL_MINUTES * 60_000).toISOString();
  const { data, error } = await admin
    .from("leads")
    .select("id, store_id, name, phone, cart_summary, handoff_context, last_inbound_at, last_interaction_at")
    .eq("yape_offered_to", user.id)
    .eq("status", "yape_por_verificar")
    .eq("has_order", false)
    .gte("yape_offered_at", offerCutoff)
    // Exclude one I (or anyone) already took, so it doesn't linger in the pop-up.
    .or(`claimed_by.is.null,claimed_at.lt.${claimCutoff}`)
    .order("yape_offered_at", { ascending: true })
    .limit(20);
  if (error || !data) return [];
  return (data as Array<Record<string, unknown>>).map((l) => ({
    id: l.id as string,
    storeId: l.store_id as string,
    name: (l.name as string | null) ?? null,
    phone: l.phone as string,
    cartSummary: (l.cart_summary as string | null) ?? null,
    handoffContext: (l.handoff_context as string | null) ?? null,
    lastInboundAt: (l.last_inbound_at as string | null) ?? (l.last_interaction_at as string | null) ?? null,
  }));
}

/** "Ahora no": pass the offer to the next advisor immediately (adds me to passed). */
export async function passYape(leadId: string): Promise<LeadActionState> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "Sin sesión." };
  const admin = createAdminSupabase();
  const { data } = await admin
    .from("leads")
    .select("yape_passed")
    .eq("id", leadId)
    .eq("yape_offered_to", user.id)
    .maybeSingle();
  if (!data) return { notice: "Ya no estaba asignado a ti." };
  const prev = Array.isArray((data as { yape_passed?: unknown }).yape_passed)
    ? (data as { yape_passed: string[] }).yape_passed
    : [];
  const passed = prev.includes(user.id) ? prev : [...prev, user.id];
  await admin
    .from("leads")
    .update({ yape_offered_to: null, yape_offered_at: null, yape_passed: passed })
    .eq("id", leadId)
    .eq("yape_offered_to", user.id);
  return { notice: "Pasado." };
}

/** Admin override: assign a Yape directly to a vendedora (resets the lap). */
export async function assignYape(leadId: string, vendedoraId: string): Promise<LeadActionState> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };
  const sb = await createServerSupabase();
  const { data: rolesData } = await sb.from("memberships").select("role");
  const roles = ((rolesData as { role: string }[] | null) ?? []).map((m) => m.role);
  if (!roles.some((r) => r === "owner" || r === "admin")) {
    return { error: "Solo un administrador puede asignar." };
  }
  const admin = createAdminSupabase();
  await admin
    .from("leads")
    .update({ yape_offered_to: vendedoraId, yape_offered_at: new Date().toISOString(), yape_passed: [] })
    .eq("id", leadId);
  return { notice: "Asignado." };
}

/** Vendedoras of a store (id + display name) for the admin "assign" dropdown.
 *  Returns [] for non-admins, so the UI self-gates. */
export async function listStoreVendedoras(storeId: string): Promise<{ id: string; name: string }[]> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];
  const { data: rolesData } = await sb.from("memberships").select("role");
  const roles = ((rolesData as { role: string }[] | null) ?? []).map((m) => m.role);
  if (!roles.some((r) => r === "owner" || r === "admin")) return [];
  const admin = createAdminSupabase();
  const { data: store } = await admin.from("stores").select("org_id").eq("id", storeId).maybeSingle();
  const orgId = (store as { org_id?: string } | null)?.org_id;
  if (!orgId) return [];
  const { data: mem } = await admin
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("role", "vendedora");
  const vendIds = new Set(((mem as { user_id: string }[] | null) ?? []).map((m) => m.user_id));
  const { data: acc } = await admin.from("user_store_access").select("user_id").eq("store_id", storeId);
  const ids = ((acc as { user_id: string }[] | null) ?? [])
    .map((a) => a.user_id)
    .filter((id) => vendIds.has(id));
  const out: { id: string; name: string }[] = [];
  for (const id of ids) {
    if (!agentNameCache.has(id)) {
      try {
        const { data } = await admin.auth.admin.getUserById(id);
        const email = data?.user?.email ?? null;
        agentNameCache.set(id, email ? email.split("@")[0]! : id.slice(0, 8));
      } catch {
        agentNameCache.set(id, id.slice(0, 8));
      }
    }
    out.push({ id, name: agentNameCache.get(id)! });
  }
  return out;
}

/** Register a call: log it, apply the new status, set the next follow-up. */
export async function registerCall(
  _prev: LeadActionState,
  formData: FormData,
): Promise<LeadActionState> {
  const leadId = String(formData.get("lead_id") ?? "");
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };

  const status = String(formData.get("status") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;
  const followupRaw = String(formData.get("next_followup_at") ?? "").trim();
  const nextFollowup = followupRaw ? new Date(followupRaw).toISOString() : null;

  if (status && !isValidStatus(status)) return { error: "Estado inválido." };

  const admin = createAdminSupabase();

  // Don't let a manual disposition silently erase a real sale: if the lead is
  // already `won` with an ACTIVE order (not cancelled) — e.g. one placed
  // directly in Shopify, before the queue caught up — block a downgrade and
  // point the agent at the order instead of quietly losing it.
  if (status) {
    const { data: current } = await admin
      .from("leads")
      .select("category, has_order, order_id")
      .eq("id", leadId)
      .maybeSingle();
    const lead = current as { category: string; has_order: boolean; order_id: string | null } | null;
    if (lead?.has_order && lead.order_id) {
      const { data: order } = await admin
        .from("orders")
        .select("name, cancelled_at")
        .eq("id", lead.order_id)
        .maybeSingle();
      const o = order as { name: string | null; cancelled_at: string | null } | null;
      const hasActiveOrder = !!o && !o.cancelled_at;
      if (!canDispositionLead({ currentCategory: lead.category, newStatus: status, hasActiveOrder })) {
        return {
          error: `Este lead ya tiene un pedido activo${o?.name ? ` (${o.name})` : ""}. Si el cliente canceló, cancela el pedido en Shopify primero.`,
        };
      }
    }
  }

  await admin.from("lead_calls").insert({
    lead_id: leadId,
    store_id: ctx.storeId,
    vendedora: ctx.userId,
    kind: "call",
    new_status: status || null,
    note,
    next_followup_at: nextFollowup,
  });

  const patch: Record<string, unknown> = { last_interaction_at: new Date().toISOString() };
  if (status) {
    patch.status = status;
    patch.category = categoryOf(status);
    patch.needs_attention = false;
  }
  if (nextFollowup) patch.next_followup_at = nextFollowup;
  await admin.from("leads").update(patch).eq("id", leadId);

  revalidatePath("/dashboard/leads");
  return {
    notice: status ? `Llamada registrada · ${labelOf(status)}` : "Llamada registrada.",
  };
}

/**
 * Confirm a lead as won when it already carries an ACTIVE order but wasn't
 * auto-marked (the bot/Shopify order was linked with win=false because a later
 * call disposition took precedence — see linkOrderToLead). Only flips
 * category→won when the backing order is real and not cancelled, so it can't
 * fake a win on an order-less lead. Idempotent. The order itself already counts
 * the sale, so this is pure re-categorization (logged, not a new sale).
 */
export async function confirmLeadWon(leadId: string): Promise<LeadActionState> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };
  const admin = createAdminSupabase();

  const { data: current } = await admin
    .from("leads")
    .select("category, has_order, order_id")
    .eq("id", leadId)
    .maybeSingle();
  const lead = current as { category: string; has_order: boolean; order_id: string | null } | null;
  if (!lead) return { error: "Lead no encontrado." };
  if (lead.category === "won") return { notice: "El lead ya está marcado como ganado." };
  if (!lead.has_order || !lead.order_id) {
    return { error: "Este lead no tiene un pedido activo para marcar como ganado." };
  }
  const { data: order } = await admin
    .from("orders")
    .select("name, cancelled_at")
    .eq("id", lead.order_id)
    .maybeSingle();
  const o = order as { name: string | null; cancelled_at: string | null } | null;
  if (!o || o.cancelled_at) {
    return { error: "El pedido vinculado está cancelado o no existe. No se puede marcar como ganado." };
  }

  const nowIso = new Date().toISOString();
  await admin
    .from("leads")
    .update({
      status: "ya_tiene_pedido",
      category: "won",
      needs_attention: false,
      last_interaction_at: nowIso,
    })
    .eq("id", leadId);
  await admin.from("lead_calls").insert({
    lead_id: leadId,
    store_id: ctx.storeId,
    vendedora: ctx.userId,
    kind: "call",
    new_status: "ya_tiene_pedido",
    note: `Confirmado como ganado — ya tiene pedido${o.name ? ` (${o.name})` : ""}.`,
  });

  revalidatePath("/dashboard/leads");
  return { notice: `Marcado como ganado${o.name ? ` · ${o.name}` : ""}.` };
}

/**
 * Close a sale by phone (contraentrega / COD). Records a lightweight manual
 * order, marks the lead as Ganado and credits the advisor — so a sale closed on
 * a call counts in revenue, COD totals and productividad just like a bot order.
 *
 * The order is a real `orders` row tagged `kapso` (so recompute_daily_rollups
 * counts it) + `venta_manual` (so it's identifiable), with a synthetic
 * `shopify_order_id` ("manual-…") that never collides with or is touched by the
 * Shopify sync (which only upserts by numeric id). COD ⇒ financial_status
 * 'pending'. Day rollups are recomputed inline so the dashboard updates now.
 */
export async function closeSale(
  leadId: string,
  input: { amount: number; products?: string; district?: string },
): Promise<LeadActionState> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };

  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Ingresa un monto válido (mayor a 0)." };
  if (amount > 1_000_000) return { error: "Monto demasiado alto." };

  const admin = createAdminSupabase();
  const { data: lead } = await admin
    .from("leads")
    .select("phone, kapso_conversation_id, has_order")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { error: "Lead no encontrado." };
  const l = lead as { phone: string | null; kapso_conversation_id: string | null; has_order: boolean };
  if (l.has_order) return { error: "Este lead ya tiene un pedido registrado." };

  const { data: store } = await admin
    .from("stores")
    .select("currency")
    .eq("id", ctx.storeId)
    .maybeSingle();
  const currency = (store as { currency: string } | null)?.currency ?? "PEN";

  const products = (input.products ?? "").trim();
  const district = (input.district ?? "").trim();
  const nowIso = new Date().toISOString();
  const syntheticId = `manual-${crypto.randomUUID()}`;

  // 1) Manual COD order. Tagged `kapso` so it counts in the rollups; `venta_manual`
  //    so it can be told apart from bot/Shopify orders.
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .insert({
      store_id: ctx.storeId,
      shopify_order_id: syntheticId,
      name: `LLAM-${syntheticId.slice(7, 13).toUpperCase()}`,
      created_at: nowIso,
      processed_at: nowIso,
      total_amount: amount,
      total_refunded: 0,
      currency,
      financial_status: "pending", // contraentrega = pago pendiente
      cancelled_at: null,
      customer_phone: l.phone,
      tags: ["kapso", "venta_manual"],
      promo_applied: false,
      stock_por_validar: false,
      shipping_mode: "cod",
      line_items: [{ title: products || "Venta por llamada", quantity: 1, price: amount }],
      kapso_conversation_id: l.kapso_conversation_id ?? null,
    })
    .select("id")
    .maybeSingle();
  if (orderErr || !order) {
    return { error: `No se pudo registrar la venta: ${orderErr?.message ?? "error desconocido"}` };
  }

  // 2) Mark the lead won + link the order (sticky).
  await admin
    .from("leads")
    .update({
      has_order: true,
      order_id: (order as { id: string }).id,
      status: "pedido_generado",
      category: "won",
      needs_attention: false,
      last_interaction_at: nowIso,
    })
    .eq("id", leadId);

  // 3) Log the sale in the lead history — this is what credits the advisor in
  //    Productividad (last caller of a won lead, with the order's net).
  const noteParts = [`Venta cerrada por llamada · ${currency} ${amount.toFixed(2)} · contraentrega (pago pendiente)`];
  if (products) noteParts.push(`Productos: ${products}`);
  if (district) noteParts.push(`Distrito: ${district}`);
  await admin.from("lead_calls").insert({
    lead_id: leadId,
    store_id: ctx.storeId,
    vendedora: ctx.userId,
    kind: "sale",
    new_status: "pedido_generado",
    note: noteParts.join(" · "),
  });

  // 4) Recompute the day's rollups so revenue / COD / AOV reflect the sale now
  //    (otherwise it would only appear on the next 15-min cron).
  try {
    const day = nowIso.slice(0, 10);
    await admin.rpc("recompute_daily_rollups", { p_store_id: ctx.storeId, p_from: day, p_to: day });
  } catch {
    /* non-fatal: the next sync's rollup recompute will pick it up */
  }

  revalidatePath("/dashboard/leads");
  revalidatePath("/dashboard");
  return { notice: `Venta registrada ✓ · ${currency} ${amount.toFixed(2)} (contraentrega)` };
}

/**
 * Recover an abandoned cart: complete its Shopify draft order (→ a real COD
 * order with payment pending), then mark the lead won + credit the advisor,
 * exactly like closeSale. Requires the store's Shopify token to have
 * write_draft_orders; without it we return a clear, actionable error.
 */
export async function recoverCart(leadId: string): Promise<LeadActionState> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };

  const admin = createAdminSupabase();
  const { data: lead } = await admin
    .from("leads")
    .select("phone, draft_order_gid, draft_order_name, cart_value, cart_summary, district, has_order")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { error: "Lead no encontrado." };
  const l = lead as {
    phone: string | null;
    draft_order_gid: string | null;
    draft_order_name: string | null;
    cart_value: number | null;
    cart_summary: string | null;
    district: string | null;
    has_order: boolean;
  };
  if (l.has_order) return { error: "Este lead ya tiene un pedido registrado." };
  if (!l.draft_order_gid) return { error: "Este lead no tiene un carrito (borrador) de Shopify." };

  const creds = await getStoreCreds(ctx.storeId);
  if (!creds?.shopify_token) return { error: "La tienda no tiene Shopify configurado." };

  // 1) Complete the draft in Shopify (COD ⇒ payment pending). Tolerate "already
  //    completed" (someone closed it in Shopify) → just mark the lead won.
  let completed: Awaited<ReturnType<typeof completeDraftOrder>>;
  try {
    completed = await completeDraftOrder({
      domain: creds.shopify_domain,
      token: creds.shopify_token,
      draftGid: l.draft_order_gid,
      paymentPending: true,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e).toLowerCase();
    if (/already.*complet|complet.*already|has already|is complete/.test(msg)) {
      completed = { orderGid: null, orderName: null, status: "completed" };
    } else if (/write_draft_orders|access denied|not authorized|access scope|require/.test(msg)) {
      return { error: "Falta el permiso de escritura en Shopify (write_draft_orders). Re-autoriza la tienda en Ajustes." };
    } else {
      return { error: `No se pudo generar el pedido en Shopify: ${e?.message ?? "error desconocido"}` };
    }
  }

  // 2) Pull the draft's amount/products/phone for the order row.
  const { data: draft } = await admin
    .from("draft_orders")
    .select("total_amount, currency, customer_phone, line_items")
    .eq("store_id", ctx.storeId)
    .eq("draft_order_gid", l.draft_order_gid)
    .maybeSingle();
  const d = (draft as {
    total_amount: number | null;
    currency: string | null;
    customer_phone: string | null;
    line_items: unknown;
  } | null) ?? null;
  const amount = Math.round(Number(d?.total_amount ?? l.cart_value ?? 0) * 100) / 100;
  const currency = d?.currency ?? creds.currency ?? "PEN";
  const phone = d?.customer_phone ?? l.phone ?? null;
  const lineItems =
    Array.isArray(d?.line_items) && d.line_items.length
      ? (d.line_items as unknown[])
      : [{ title: l.cart_summary || "Carrito recuperado", quantity: 1, price: amount }];
  const nowIso = new Date().toISOString();

  // 3) Record the resulting order. Tagged `kapso` so recompute_daily_rollups
  //    counts it; `carrito_recuperado` so it's identifiable. Use the real Shopify
  //    id when returned (so a later order sync upserts the same row, no dup);
  //    else a synthetic id. COD ⇒ financial_status 'pending'.
  const realOrderId = completed.orderGid ? extractNumericId(completed.orderGid) : null;
  const shopifyOrderId = realOrderId || `draft-${extractNumericId(l.draft_order_gid)}`;
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .upsert(
      {
        store_id: ctx.storeId,
        shopify_order_id: shopifyOrderId,
        name: completed.orderName ?? l.draft_order_name ?? `REC-${shopifyOrderId.slice(-6).toUpperCase()}`,
        created_at: nowIso,
        processed_at: nowIso,
        total_amount: amount,
        total_refunded: 0,
        currency,
        financial_status: "pending",
        cancelled_at: null,
        customer_phone: phone,
        tags: ["kapso", "carrito_recuperado"],
        promo_applied: false,
        stock_por_validar: false,
        shipping_mode: "cod",
        line_items: lineItems,
        kapso_conversation_id: null,
      },
      { onConflict: "store_id,shopify_order_id" },
    )
    .select("id")
    .maybeSingle();
  if (orderErr || !order) {
    return {
      error: `Pedido generado en Shopify, pero no se pudo registrar localmente: ${orderErr?.message ?? "error"}`,
    };
  }

  // 4) Mark the lead won + link the order; reflect the draft as completed.
  await admin
    .from("leads")
    .update({
      has_order: true,
      order_id: (order as { id: string }).id,
      status: "pedido_generado",
      category: "won",
      needs_attention: false,
      draft_order_status: "completed",
      last_interaction_at: nowIso,
    })
    .eq("id", leadId);
  await admin
    .from("draft_orders")
    .update({ status: "completed", completed_at: nowIso, order_gid: completed.orderGid })
    .eq("store_id", ctx.storeId)
    .eq("draft_order_gid", l.draft_order_gid);

  // 5) Log the recovery — credits the advisor in Productividad (like closeSale).
  const noteParts = [`Carrito recuperado · pedido generado en Shopify · ${currency} ${amount.toFixed(2)} · contraentrega`];
  if (l.cart_summary) noteParts.push(`Productos: ${l.cart_summary}`);
  if (l.district) noteParts.push(`Distrito: ${l.district}`);
  await admin.from("lead_calls").insert({
    lead_id: leadId,
    store_id: ctx.storeId,
    vendedora: ctx.userId,
    kind: "sale",
    new_status: "pedido_generado",
    note: noteParts.join(" · "),
  });

  // 6) Recompute the day's rollups so revenue / COD reflect the recovery now.
  try {
    const day = nowIso.slice(0, 10);
    await admin.rpc("recompute_daily_rollups", { p_store_id: ctx.storeId, p_from: day, p_to: day });
  } catch {
    /* non-fatal: the next sync's rollup recompute will pick it up */
  }

  revalidatePath("/dashboard/leads");
  revalidatePath("/dashboard");
  return { notice: `Pedido generado ✓ · ${currency} ${amount.toFixed(2)} (contraentrega)` };
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Is the lead's WhatsApp 24h session window open? (i.e. the customer sent a
 * message within the last 24h, so we may reply with free text). Reads the last
 * inbound message time live from Kapso.
 */
export async function getLeadWindow(
  leadId: string,
  conversationId?: string,
): Promise<{ open: boolean; lastInboundAt: string | null; reason?: string }> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { open: false, lastInboundAt: null, reason: "Sin acceso." };
  // Per-conversation window: a multi-number lead has its own 24h window per number,
  // so honour the active thread's conversation when given.
  let convId = conversationId ?? null;
  if (!convId) {
    const admin = createAdminSupabase();
    const { data } = await admin
      .from("leads")
      .select("kapso_conversation_id")
      .eq("id", leadId)
      .maybeSingle();
    convId = (data as { kapso_conversation_id: string | null } | null)?.kapso_conversation_id ?? null;
  }
  if (!convId) return { open: false, lastInboundAt: null, reason: "Sin conversación de WhatsApp." };
  const creds = await getStoreCreds(ctx.storeId);
  if (!creds?.kapso_api_key) return { open: false, lastInboundAt: null, reason: "Tienda sin Kapso configurado." };
  const lastMs = await fetchLastInboundAt({ apiKey: creds.kapso_api_key }, convId);
  if (lastMs == null) return { open: false, lastInboundAt: null, reason: "El cliente aún no ha escrito." };
  return { open: Date.now() - lastMs < WINDOW_MS, lastInboundAt: new Date(lastMs).toISOString() };
}

/** One message of the live WhatsApp transcript shown in the drawer. `mediaUrl`
 *  is the Kapso stored URL — it must be loaded through `/api/leads/[id]/media`
 *  (the authenticated proxy), never put in an <img> src directly. */
export interface LeadConversationMessage {
  id: string | null;
  direction: "inbound" | "outbound";
  at: string; // ISO timestamp
  text: string;
  mediaKind: "image" | "audio" | "video" | "document" | "sticker" | null;
  mediaUrl: string | null;
  status: string | null; // WhatsApp delivery status (sent/delivered/read/failed)
}

/** One WhatsApp thread for a lead: the customer wrote to this business number.
 *  A lead can have several (one per connected Kapso number). */
export interface LeadThread {
  conversationId: string;
  phoneNumberId: string | null;
  label: string; // friendly number name (e.g. "Aurela")
  displayPhone: string | null; // e.g. "+51 917 173 327"
  lastActiveAt: string | null;
}

export interface LeadConversation {
  messages: LeadConversationMessage[];
  threads: LeadThread[]; // all conversations for this phone (drives the number selector)
  activeConversationId: string | null;
  activePhoneNumberId: string | null; // the number to reply FROM for the active thread
  reason?: string; // set (with messages: []) when the transcript can't be shown
}

/** How many of a number's session-conversations the drawer merges into the
 *  transcript (newest-first). Covers virtually all real contacts while bounding
 *  the Kapso fan-out on drawer open. */
const MAX_DRAWER_CONVERSATIONS = 10;

/**
 * Load a lead's WhatsApp conversation (text + media) from Kapso. Also returns the
 * list of THREADS — one per connected number the customer wrote to — so the drawer
 * can show a selector when there's more than one (a customer who messaged both of
 * the store's numbers). `conversationId` picks which thread to read (validated to
 * belong to this lead's phone); otherwise the stored or most-recent one is used.
 * The active number's session-conversations are MERGED so the full history shows,
 * not just the newest session. Requested with `fields=kapso(default)` for stable
 * media URLs. RLS-authorized.
 */
export async function loadLeadConversation(
  leadId: string,
  conversationId?: string,
): Promise<LeadConversation> {
  const empty = (reason?: string): LeadConversation => ({
    messages: [],
    threads: [],
    activeConversationId: null,
    activePhoneNumberId: null,
    reason,
  });
  const ctx = await authorizeLead(leadId);
  if (!ctx) return empty("Sin acceso a este lead.");

  const admin = createAdminSupabase();
  // Lead row + store creds are independent — fetch together.
  const [leadRes, creds] = await Promise.all([
    admin.from("leads").select("kapso_conversation_id, phone, wa_phone_number_id").eq("id", leadId).maybeSingle(),
    getStoreCreds(ctx.storeId),
  ]);
  const lead = (leadRes.data as {
    kapso_conversation_id: string | null;
    phone: string | null;
    wa_phone_number_id: string | null;
  } | null) ?? null;
  if (!creds?.kapso_api_key) return empty("La tienda no tiene Kapso configurado.");
  const apiKey = creds.kapso_api_key;

  // The transcript is the slow part the user waits on. Fetch it for the best-known
  // conversation id CONCURRENTLY with the conversation list (which only drives the
  // multi-number selector) instead of strictly after it — that halves the Kapso
  // round-trip latency on open. Capped to 2 pages (200 msgs) for a fast first paint.
  const storedId = (conversationId && conversationId.trim()) || lead?.kapso_conversation_id || null;
  const [convs, storedTranscript] = await Promise.all([
    lead?.phone ? listConversationsByPhone({ apiKey }, lead.phone) : Promise.resolve([]),
    storedId ? fetchConversationTranscript({ apiKey }, storedId, 2).catch(() => null) : Promise.resolve(null),
  ]);
  const labels = await getWaNumbers(convs.map((c) => (c.phone_number_id as string | null) ?? null));
  const threadsRaw: LeadThread[] = convs.map((c) => {
    const pnid = (c.phone_number_id as string | null) ?? null;
    const wn = pnid ? labels[pnid] : null;
    return {
      conversationId: String(c.id),
      phoneNumberId: pnid,
      label: wn?.name || wn?.displayPhone || pnid || "WhatsApp",
      displayPhone: wn?.displayPhone ?? null,
      lastActiveAt:
        (c.last_active_at as string | null) ?? (c.kapso?.last_message_timestamp as string | null) ?? null,
    };
  });
  // Un tab por NÚMERO: varias conversaciones de Kapso en el mismo phone_number_id
  // se colapsan en una sola (la más reciente). El selector solo aparece si el
  // cliente escribió de verdad a más de un número.
  const byNumber = new Map<string, LeadThread>();
  for (const t of threadsRaw) {
    const key = t.phoneNumberId ?? "__none__";
    const prev = byNumber.get(key);
    if (!prev || (t.lastActiveAt ?? "") > (prev.lastActiveAt ?? "")) byNumber.set(key, t);
  }
  const threads = [...byNumber.values()].sort((a, b) =>
    (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""),
  );
  const pnidOfConv = new Map(threadsRaw.map((t) => [t.conversationId, t.phoneNumberId ?? "__none__"]));

  // Resolve the active NUMBER → its representative (newest) conversation:
  //   explicit param → stored conv's number → lead's number → most recent number.
  let activeKey: string | null = null;
  if (conversationId && pnidOfConv.has(conversationId)) activeKey = pnidOfConv.get(conversationId)!;
  else if (lead?.kapso_conversation_id && pnidOfConv.has(lead.kapso_conversation_id))
    activeKey = pnidOfConv.get(lead.kapso_conversation_id)!;
  else if (lead?.wa_phone_number_id && byNumber.has(lead.wa_phone_number_id))
    activeKey = lead.wa_phone_number_id;
  else if (threads[0]) activeKey = threads[0].phoneNumberId ?? "__none__";
  let activeId: string | null = activeKey ? (byNumber.get(activeKey)?.conversationId ?? null) : null;
  if (!activeId) activeId = lead?.kapso_conversation_id ?? null;
  if (!activeId) return empty("Este lead no tiene conversación de WhatsApp todavía.");

  const activeThread = threads.find((t) => t.conversationId === activeId) ?? null;
  const activePhoneNumberId = activeThread?.phoneNumberId ?? lead?.wa_phone_number_id ?? null;

  // Kapso splits a contact's chat into session-window "conversations" (each its
  // own id). The drawer wants the FULL history for the active number, so gather
  // ALL its conversation ids (newest-first, bounded) and merge their transcripts —
  // otherwise only the newest session shows and older messages look truncated.
  const activeConvIds = threadsRaw
    .filter((t) => (t.phoneNumberId ?? "__none__") === activeKey)
    .sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""))
    .map((t) => t.conversationId);
  const idsToFetch = [...new Set([activeId, ...activeConvIds])].slice(0, MAX_DRAWER_CONVERSATIONS);
  const olderIds = idsToFetch.filter((id) => id !== activeId);

  // The active (newest) conversation is the primary read — a failure there is a
  // real error. Older sessions are best-effort (a failing one is just skipped),
  // and we reuse the transcript prefetched in parallel above wherever it matches.
  let activeMsgs: ConversationMessage[];
  try {
    activeMsgs =
      activeId === storedId && storedTranscript
        ? storedTranscript
        : await fetchConversationTranscript({ apiKey }, activeId, 2);
  } catch {
    return {
      messages: [],
      threads,
      activeConversationId: activeId,
      activePhoneNumberId,
      reason: "No se pudo cargar la conversación de WhatsApp.",
    };
  }
  const olderMsgs = await Promise.all(
    olderIds.map((id) =>
      id === storedId && storedTranscript
        ? Promise.resolve(storedTranscript)
        : fetchConversationTranscript({ apiKey }, id, 2).catch(() => [] as ConversationMessage[]),
    ),
  );
  const parsed = mergeTranscripts([activeMsgs, ...olderMsgs]);

  const messages: LeadConversationMessage[] = (parsed ?? []).map((m) => ({
    id: m.id,
    direction: m.dir,
    at: new Date(m.t).toISOString(),
    text: m.text,
    mediaKind: m.mediaKind,
    mediaUrl: m.mediaUrl,
    status: m.status,
  }));
  return {
    messages,
    threads,
    activeConversationId: activeId,
    activePhoneNumberId,
    reason: messages.length ? undefined : "Sin mensajes en esta conversación todavía.",
  };
}

/**
 * Send a free-text WhatsApp message to the lead. Only works inside the 24h
 * session window; outside it WhatsApp rejects the send and we say so. The sent
 * message is logged to the lead history (kind="message").
 */
export async function sendLeadMessage(
  leadId: string,
  text: string,
  phoneNumberId?: string,
): Promise<LeadActionState> {
  const body = text.trim();
  if (!body) return { error: "Escribe un mensaje." };
  if (body.length > 4000) return { error: "Mensaje demasiado largo (máx. 4000 caracteres)." };
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };

  const admin = createAdminSupabase();
  const { data } = await admin.from("leads").select("phone").eq("id", leadId).maybeSingle();
  const phone = (data as { phone: string | null } | null)?.phone ?? null;
  if (!phone) return { error: "El lead no tiene teléfono." };

  const creds = await getStoreCreds(ctx.storeId);
  // Reply FROM the active thread's number (multi-number leads); fall back to the store's.
  const pnId = (phoneNumberId && phoneNumberId.trim()) || creds?.whatsapp_phone_number_id;
  if (!creds?.kapso_api_key || !pnId) {
    return { error: "La tienda no tiene WhatsApp/Kapso configurado." };
  }

  const res = await sendWhatsappText(
    { apiKey: creds.kapso_api_key },
    { phoneNumberId: pnId, to: phone, body },
  );
  if (!res.ok) {
    const closed = res.code === 131047 || /24\s*h|re-?engag|outside|window/i.test(res.error);
    return {
      windowClosed: closed,
      error: closed
        ? "Se cerró la ventana de 24h: el cliente debe volver a escribirte para poder responderle."
        : `No se pudo enviar: ${res.error}`,
    };
  }

  await admin.from("lead_calls").insert({
    lead_id: leadId,
    store_id: ctx.storeId,
    vendedora: ctx.userId,
    kind: "message",
    new_status: null,
    note: body,
  });
  await admin.from("leads").update({ last_interaction_at: new Date().toISOString() }).eq("id", leadId);

  revalidatePath("/dashboard/leads");
  return { notice: "Mensaje enviado por WhatsApp ✓" };
}

// Lazily ensure the public bucket for WhatsApp image sends exists (memoized per
// server instance). Service-role bypasses Storage RLS; public ⇒ Meta can fetch.
let _waMediaBucketReady = false;
async function ensureWaMediaBucket(admin: ReturnType<typeof createAdminSupabase>): Promise<void> {
  if (_waMediaBucketReady) return;
  await admin.storage.createBucket("whatsapp-media", { public: true }); // error if exists ⇒ fine
  _waMediaBucketReady = true;
}

export type WaMediaKind = "image" | "document" | "video";

/** Map a MIME type to a WhatsApp media kind, or null if not allowed. */
function waMediaKind(contentType: string): WaMediaKind | null {
  const ct = contentType.toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct === "video/mp4" || ct === "video/3gpp") return "video";
  if (ct === "application/pdf") return "document";
  return null;
}

/**
 * Mint a signed upload URL so the browser can push a media file (image/PDF/video)
 * DIRECTLY to the public Storage bucket — bypassing the ~4.5 MB Server-Action body
 * limit (videos reach 16 MB). The client then calls `sendLeadMedia` with the path.
 */
export async function createWaMediaUpload(
  leadId: string,
  contentType: string,
  filename: string,
): Promise<{ error: string } | { path: string; token: string; kind: WaMediaKind }> {
  const kind = waMediaKind(contentType);
  if (!kind) return { error: "Tipo de archivo no soportado (imagen, PDF o video mp4)." };
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };

  const admin = createAdminSupabase();
  try {
    await ensureWaMediaBucket(admin);
    const safeExt = (filename.split(".").pop() || contentType.split("/")[1] || "bin")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 8);
    const path = `${ctx.storeId}/${leadId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
    const { data, error } = await admin.storage.from("whatsapp-media").createSignedUploadUrl(path);
    if (error || !data) return { error: `No se pudo preparar la subida: ${error?.message ?? "error"}` };
    return { path: data.path, token: data.token, kind };
  } catch (e) {
    return { error: `No se pudo preparar la subida: ${(e as Error)?.message ?? "error"}` };
  }
}

/**
 * Send an already-uploaded media file (by Storage `path`) to the lead over
 * WhatsApp (inside the 24h window) — image, document (boleta/PDF) or video. Sent
 * to Meta by public link; logged to the history. The object is removed if the
 * send fails so we don't leave orphans.
 */
export async function sendLeadMedia(
  leadId: string,
  args: { path: string; kind: WaMediaKind; filename?: string; caption?: string },
  phoneNumberId?: string,
): Promise<LeadActionState> {
  const caption = (args.caption ?? "").trim();
  if (caption.length > 1024) return { error: "El texto es muy largo (máx. 1024)." };
  if (!["image", "document", "video"].includes(args.kind)) return { error: "Tipo de archivo no soportado." };
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };
  // The path must live under this store's prefix (defense against arbitrary sends).
  if (!args.path.startsWith(`${ctx.storeId}/`)) return { error: "Archivo inválido." };

  const admin = createAdminSupabase();
  const { data } = await admin.from("leads").select("phone").eq("id", leadId).maybeSingle();
  const phone = (data as { phone: string | null } | null)?.phone ?? null;
  if (!phone) return { error: "El lead no tiene teléfono." };

  const creds = await getStoreCreds(ctx.storeId);
  // Send FROM the active thread's number (multi-number leads); fall back to the store's.
  const pnId = (phoneNumberId && phoneNumberId.trim()) || creds?.whatsapp_phone_number_id;
  if (!creds?.kapso_api_key || !pnId) {
    return { error: "La tienda no tiene WhatsApp/Kapso configurado." };
  }

  const url = admin.storage.from("whatsapp-media").getPublicUrl(args.path).data.publicUrl;
  const k = { apiKey: creds.kapso_api_key };
  const res =
    args.kind === "image"
      ? await sendWhatsappImage(k, { phoneNumberId: pnId, to: phone, imageUrl: url, caption: caption || undefined })
      : args.kind === "video"
        ? await sendWhatsappVideo(k, { phoneNumberId: pnId, to: phone, videoUrl: url, caption: caption || undefined })
        : await sendWhatsappDocument(k, {
            phoneNumberId: pnId,
            to: phone,
            documentUrl: url,
            filename: args.filename || undefined,
            caption: caption || undefined,
          });

  if (!res.ok) {
    await admin.storage.from("whatsapp-media").remove([args.path]).catch(() => {}); // no dejes huérfanos
    const closed = res.code === 131047 || /24\s*h|re-?engag|outside|window/i.test(res.error);
    return {
      windowClosed: closed,
      error: closed
        ? "Se cerró la ventana de 24h: el cliente debe volver a escribirte para poder responderle."
        : `No se pudo enviar: ${res.error}`,
    };
  }

  const icon = args.kind === "image" ? "📷" : args.kind === "video" ? "🎥" : "📄";
  const label = args.kind === "image" ? "Imagen" : args.kind === "video" ? "Video" : args.filename || "Documento";
  await admin.from("lead_calls").insert({
    lead_id: leadId,
    store_id: ctx.storeId,
    vendedora: ctx.userId,
    kind: "message",
    new_status: null,
    note: caption ? `${icon} ${caption}` : `${icon} ${label} enviado`,
  });
  await admin.from("leads").update({ last_interaction_at: new Date().toISOString() }).eq("id", leadId);

  revalidatePath("/dashboard/leads");
  return { notice: "Enviado por WhatsApp ✓" };
}

// ---------------------------------------------------------------------------
// Quick replies (respuestas rápidas) — per-store canned messages the advisor
// inserts into the WhatsApp composer. Shared across the store's advisors.
// ---------------------------------------------------------------------------
export interface QuickReply {
  id: string;
  label: string;
  body: string;
}

export async function listQuickReplies(leadId: string): Promise<QuickReply[]> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return [];
  const admin = createAdminSupabase();
  const { data } = await admin
    .from("quick_replies")
    .select("id, label, body")
    .eq("store_id", ctx.storeId)
    .order("sort", { ascending: true })
    .order("created_at", { ascending: true });
  return (data as QuickReply[] | null) ?? [];
}

export async function createQuickReply(
  leadId: string,
  label: string,
  body: string,
): Promise<{ replies: QuickReply[] } | { error: string }> {
  const l = label.trim();
  const b = body.trim();
  if (!l || !b) return { error: "Completa el título y el mensaje." };
  if (l.length > 40) return { error: "El título es muy largo (máx. 40)." };
  if (b.length > 4000) return { error: "El mensaje es muy largo." };
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };
  const admin = createAdminSupabase();
  const { error } = await admin.from("quick_replies").insert({ store_id: ctx.storeId, label: l, body: b });
  if (error) return { error: error.message };
  return { replies: await listQuickReplies(leadId) };
}

export async function deleteQuickReply(
  leadId: string,
  id: string,
): Promise<{ replies: QuickReply[] } | { error: string }> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };
  const admin = createAdminSupabase();
  const { error } = await admin.from("quick_replies").delete().eq("id", id).eq("store_id", ctx.storeId);
  if (error) return { error: error.message };
  return { replies: await listQuickReplies(leadId) };
}

// ===========================================================================
// Unified order form: search catalog · pre-fill from cart · generate the order
// (supersedes closeSale + recoverCart). Cart → update+complete the draft; new
// sale → create+complete a draft. Always a REAL Shopify order, COD pago pendiente.
// ===========================================================================

/** Search the lead's store catalog for the product picker (RLS-authorized). */
export async function searchStoreProducts(
  leadId: string,
  query: string,
): Promise<ProductSearchResult[]> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return [];
  const creds = await getStoreCreds(ctx.storeId);
  if (!creds?.shopify_token) return [];
  try {
    return await searchCatalogProducts({
      domain: creds.shopify_domain,
      token: creds.shopify_token,
      query,
      first: 20,
    });
  } catch {
    return []; // e.g. read_products not granted yet → picker degrades to custom items
  }
}

export interface OrderFormPrefill {
  isCart: boolean;
  draftGid: string | null;
  lineItems: { variantId: string | null; title: string; quantity: number; unitPrice: number | null }[];
  customerName: string | null;
  phone: string | null;
  address1: string | null;
  district: string | null;
  province: string | null;
  referencia: string | null;
  windowOpen: boolean; // 24h WhatsApp window (drives the confirmation default)
}

/** Pre-fill the order form: for a cart, read the live draft (variant ids + price
 *  + address); for a new sale, return the lead's defaults blank. */
export async function loadOrderDraft(leadId: string): Promise<OrderFormPrefill | { error: string }> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };
  const admin = createAdminSupabase();
  const { data: lead } = await admin
    .from("leads")
    .select("phone, name, draft_order_gid, district, province, referencia, kapso_conversation_id")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { error: "Lead no encontrado." };
  const l = lead as {
    phone: string | null;
    name: string | null;
    draft_order_gid: string | null;
    district: string | null;
    province: string | null;
    referencia: string | null;
    kapso_conversation_id: string | null;
  };

  const out: OrderFormPrefill = {
    isCart: !!l.draft_order_gid,
    draftGid: l.draft_order_gid,
    lineItems: [],
    customerName: l.name,
    phone: l.phone,
    address1: null,
    district: l.district,
    province: l.province,
    referencia: l.referencia,
    windowOpen: false,
  };

  if (l.draft_order_gid) {
    const creds = await getStoreCreds(ctx.storeId);
    let filled = false;
    if (creds?.shopify_token) {
      try {
        const draft = await getDraftOrderForEdit({
          domain: creds.shopify_domain,
          token: creds.shopify_token,
          gid: l.draft_order_gid,
        });
        if (draft) {
          out.lineItems = draft.lineItems;
          out.customerName = draft.address.name ?? l.name;
          out.address1 = draft.address.address1;
          out.district = draft.address.city ?? l.district;
          out.province = draft.address.province ?? l.province;
          out.referencia = draft.address.address2 ?? l.referencia;
          filled = true;
        }
      } catch {
        /* live fetch failed → fall back to stored draft_orders data below */
      }
    }
    if (!filled) {
      const { data: d } = await admin
        .from("draft_orders")
        .select("line_items, address1, district, province, referencia, customer_name")
        .eq("store_id", ctx.storeId)
        .eq("draft_order_gid", l.draft_order_gid)
        .maybeSingle();
      const dd = d as {
        line_items: unknown;
        address1: string | null;
        district: string | null;
        province: string | null;
        referencia: string | null;
        customer_name: string | null;
      } | null;
      if (dd) {
        out.lineItems = (Array.isArray(dd.line_items) ? dd.line_items : []).map((li: any) => ({
          variantId: null,
          title: String(li?.title ?? ""),
          quantity: Number(li?.quantity ?? 1),
          unitPrice: li?.price != null ? Number(li.price) : null,
        }));
        out.address1 = dd.address1 ?? out.address1;
        out.district = dd.district ?? out.district;
        out.province = dd.province ?? out.province;
        out.referencia = dd.referencia ?? out.referencia;
        out.customerName = dd.customer_name ?? out.customerName;
      }
    }
  }

  // 24h window (drives the confirmation checkbox default).
  if (l.kapso_conversation_id) {
    const w = await getLeadWindow(leadId);
    out.windowOpen = w.open;
  }
  return out;
}

export interface GenerateOrderInput {
  lineItems: { variantId?: string | null; title?: string | null; quantity: number; unitPrice: number | null }[];
  customerName?: string;
  phone?: string;
  address1: string;
  district: string;
  province?: string;
  referencia?: string;
  note?: string;
  sendConfirmation?: boolean;
  confirmationText?: string;
  discount?: { kind: "fixed" | "percent"; value: number } | null;
  allowExisting?: boolean; // permitir generar OTRO pedido aunque el lead ya tenga uno
}

function defaultConfirmation(o: {
  name: string | null;
  products: { title: string; quantity: number }[];
  amount: number;
  currency: string;
  district: string;
  address1: string;
}): string {
  const items = o.products.map((p) => `• ${p.quantity}× ${p.title}`).join("\n");
  const hi = o.name ? ` ${o.name.split(/\s+/)[0]}` : "";
  return (
    `¡Hola${hi}! 🎉 Tu pedido quedó confirmado:\n${items}\n` +
    `Total: ${o.currency} ${o.amount.toFixed(2)} (pago contraentrega)\n` +
    `Entrega: ${o.address1}, ${o.district}\n¡Gracias por tu compra! 📦`
  );
}

/**
 * Generate the order from the unified form. Validates required data (≥1 product,
 * address + distrito), then: cart → updateDraftOrder + completeDraftOrder; new →
 * createDraftOrder + completeDraftOrder. Records the order (tag:kapso so it counts),
 * marks the lead won, credits the advisor, recomputes rollups, and — if asked and
 * the 24h window is open — sends a WhatsApp confirmation from the lead's number.
 */
export async function generateOrder(
  leadId: string,
  input: GenerateOrderInput,
): Promise<LeadActionState> {
  const ctx = await authorizeLead(leadId);
  if (!ctx) return { error: "Sin acceso a este lead." };

  const items = (input.lineItems ?? []).filter(
    (li) => (li.variantId || (li.title ?? "").trim()) && Number(li.quantity) > 0,
  );
  if (!items.length) return { error: "Agrega al menos un producto." };
  const address1 = (input.address1 ?? "").trim();
  const district = (input.district ?? "").trim();
  if (!address1) return { error: "La dirección es obligatoria." };
  if (!district) return { error: "El distrito es obligatorio." };

  const admin = createAdminSupabase();
  const { data: lead } = await admin
    .from("leads")
    .select("phone, name, wa_phone_number_id, kapso_conversation_id, draft_order_gid, has_order")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { error: "Lead no encontrado." };
  const l = lead as {
    phone: string | null;
    name: string | null;
    wa_phone_number_id: string | null;
    kapso_conversation_id: string | null;
    draft_order_gid: string | null;
    has_order: boolean;
  };
  // Por defecto se bloquea un 2º pedido (evita dobles accidentales); el botón
  // "Generar nuevo pedido" del drawer lo permite explícitamente con allowExisting.
  if (l.has_order && !input.allowExisting) return { error: "Este lead ya tiene un pedido registrado." };

  const creds = await getStoreCreds(ctx.storeId);
  if (!creds?.shopify_token) return { error: "La tienda no tiene Shopify configurado." };
  const currency = creds.currency ?? "PEN";
  const phone = ((input.phone ?? "").trim() || l.phone) ?? null;

  const lineItemsInput = items.map((li) => ({
    variantId: li.variantId ?? null,
    title: (li.title ?? "").trim() || null,
    quantity: Math.max(1, Math.floor(Number(li.quantity))),
    unitPrice: li.unitPrice != null ? Math.round(Number(li.unitPrice) * 100) / 100 : null,
  }));
  const subtotal = Math.round(lineItemsInput.reduce((s, li) => s + (li.unitPrice ?? 0) * li.quantity, 0) * 100) / 100;
  if (subtotal <= 0) return { error: "El monto del pedido debe ser mayor a 0." };
  // Order-level discount (Monto/Porcentaje) → net total + Shopify appliedDiscount.
  const { total: amount, discountAmount, appliedDiscount } = resolveOrderDiscount(subtotal, input.discount);
  // COD orders are collected on delivery: the total must be > 0. A S/ 0 total
  // makes Shopify mark the order "paid" (nothing to collect), which we never want.
  if (amount <= 0) return { error: "El total del pedido no puede ser 0. Revisa el descuento." };

  const address = {
    name: (input.customerName ?? l.name ?? "").trim() || null,
    phone,
    address1,
    address2: (input.referencia ?? "").trim() || null,
    city: district,
    province: (input.province ?? "").trim() || null,
    country: "Peru",
  };
  const sclient = { domain: creds.shopify_domain, token: creds.shopify_token };
  const isCart = !!l.draft_order_gid;
  let draftGid = l.draft_order_gid;

  // Build+run the draft (create for a new sale, update for a cart). withPhone=false
  // is the retry path when Shopify rejects the phone ("Phone is invalid") — a bad
  // phone must never block the sale; the lead keeps the number anyway.
  const runDraft = async (withPhone: boolean): Promise<string> => {
    const addr = { ...address, phone: withPhone ? phone : null };
    const ph = withPhone ? phone : null;
    if (isCart && l.draft_order_gid) {
      await updateDraftOrder({
        ...sclient,
        gid: l.draft_order_gid,
        input: { lineItems: lineItemsInput, address: addr, phone: ph, note: input.note ?? null, appliedDiscount },
      });
      return l.draft_order_gid;
    }
    const created = await createDraftOrder({
      ...sclient,
      input: { lineItems: lineItemsInput, address: addr, phone: ph, note: input.note ?? null, tags: ["venta_manual"], appliedDiscount },
    });
    return created.gid;
  };

  // 1) Create/update the draft, then complete it (COD ⇒ payment pending).
  let completed: Awaited<ReturnType<typeof completeDraftOrder>>;
  try {
    try {
      draftGid = await runDraft(true);
    } catch (e: any) {
      if (/phone/i.test(String(e?.message ?? e))) {
        draftGid = await runDraft(false); // bad phone → generate the order without it
      } else {
        throw e;
      }
    }
    completed = await completeDraftOrder({ ...sclient, draftGid: draftGid!, paymentPending: true });
  } catch (e: any) {
    const msg = String(e?.message ?? e).toLowerCase();
    if (/already.*complet|complet.*already|has already|is complete/.test(msg)) {
      completed = { orderGid: null, orderName: null, status: "completed" };
    } else if (/write_draft_orders|access denied|not authorized|access scope|require/.test(msg)) {
      return { error: "Falta el permiso de escritura en Shopify (write_draft_orders). Re-autoriza la tienda en Ajustes." };
    } else {
      return { error: `No se pudo generar el pedido en Shopify: ${e?.message ?? "error desconocido"}` };
    }
  }

  // 2) Record the resulting order (tag:kapso so recompute_daily_rollups counts it).
  const nowIso = new Date().toISOString();
  const realOrderId = completed.orderGid ? extractNumericId(completed.orderGid) : null;
  const shopifyOrderId = realOrderId || `draft-${extractNumericId(draftGid!)}`;
  const products = lineItemsInput.map((li) => ({
    title: li.title || "Producto",
    quantity: li.quantity,
    price: li.unitPrice,
  }));
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .upsert(
      {
        store_id: ctx.storeId,
        shopify_order_id: shopifyOrderId,
        name: completed.orderName ?? `PED-${shopifyOrderId.slice(-6).toUpperCase()}`,
        created_at: nowIso,
        processed_at: nowIso,
        total_amount: amount,
        total_refunded: 0,
        currency,
        financial_status: "pending",
        cancelled_at: null,
        customer_phone: phone,
        tags: isCart ? ["kapso", "carrito_recuperado"] : ["kapso", "venta_manual"],
        promo_applied: false,
        stock_por_validar: false,
        shipping_mode: "cod",
        line_items: products,
        kapso_conversation_id: l.kapso_conversation_id ?? null,
      },
      { onConflict: "store_id,shopify_order_id" },
    )
    .select("id")
    .maybeSingle();
  if (orderErr || !order) {
    return { error: `Pedido generado en Shopify, pero no se pudo registrar localmente: ${orderErr?.message ?? "error"}` };
  }

  // 3) Lead won + draft mirror.
  await admin
    .from("leads")
    .update({
      has_order: true,
      order_id: (order as { id: string }).id,
      status: "pedido_generado",
      category: "won",
      needs_attention: false,
      last_interaction_at: nowIso,
      ...(isCart ? { draft_order_status: "completed" } : {}),
    })
    .eq("id", leadId);
  if (isCart && draftGid) {
    await admin
      .from("draft_orders")
      .update({ status: "completed", completed_at: nowIso, order_gid: completed.orderGid })
      .eq("store_id", ctx.storeId)
      .eq("draft_order_gid", draftGid);
  }

  // 4) Log the sale (credits the advisor in Productividad).
  const discLabel =
    discountAmount > 0
      ? input.discount?.kind === "percent"
        ? ` · desc. ${Math.min(100, input.discount.value)}% (−${currency} ${discountAmount.toFixed(2)})`
        : ` · desc. ${currency} ${discountAmount.toFixed(2)}`
      : "";
  const note = [
    `${isCart ? "Carrito recuperado" : "Venta nueva"} · pedido generado en Shopify · ${currency} ${amount.toFixed(2)}${discLabel} · contraentrega`,
    `Productos: ${products.map((p) => `${p.quantity}× ${p.title}`).join(", ")}`,
    `Entrega: ${district}${address.address2 ? " · " + address.address2 : ""}`,
  ].join(" · ");
  await admin.from("lead_calls").insert({
    lead_id: leadId,
    store_id: ctx.storeId,
    vendedora: ctx.userId,
    kind: "sale",
    new_status: "pedido_generado",
    note,
  });

  // 5) Recompute today's rollups so revenue/COD reflect it now.
  try {
    const day = nowIso.slice(0, 10);
    await admin.rpc("recompute_daily_rollups", { p_store_id: ctx.storeId, p_from: day, p_to: day });
  } catch {
    /* next sync recomputes */
  }

  // 6) Confirmation WhatsApp (best-effort; only if asked + a number is set).
  let confirmNote = "";
  if (input.sendConfirmation && phone) {
    const pnId = l.wa_phone_number_id ?? creds.whatsapp_phone_number_id;
    if (creds.kapso_api_key && pnId) {
      const body =
        (input.confirmationText ?? "").trim() ||
        defaultConfirmation({ name: address.name, products, amount, currency, district, address1 });
      const res = await sendWhatsappText({ apiKey: creds.kapso_api_key }, { phoneNumberId: pnId, to: phone, body });
      if (res.ok) {
        await admin.from("lead_calls").insert({
          lead_id: leadId,
          store_id: ctx.storeId,
          vendedora: ctx.userId,
          kind: "message",
          new_status: null,
          note: body,
        });
        confirmNote = " · confirmación enviada ✓";
      } else {
        confirmNote = " · (no se envió la confirmación: ventana de 24h cerrada o error)";
      }
    }
  }

  revalidatePath("/dashboard/leads");
  revalidatePath("/dashboard");
  return { notice: `Pedido generado ✓ · ${currency} ${amount.toFixed(2)} (contraentrega)${confirmNote}` };
}
