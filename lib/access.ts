// Server-side, RLS-scoped data access for the dashboards. Every query runs
// through the cookie-bound server client, so a user only ever sees rows for
// stores they may access.

import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { decryptOrNull } from "@/lib/crypto";
import { fetchMetaSpend, normalizeMetaAdAccounts } from "@/lib/meta-marketing";
import type {
  ConversationRow,
  DailyRollupRow,
  LeadRow,
  OrderRow,
  StoreSummary,
} from "@/lib/types";
import type { AdMeta } from "@/lib/meta-ads";
import type { AttributionInputs, AttributionSource } from "@/lib/metrics";
import type { WaNumber } from "@/lib/wa-numbers";

export interface DateRange {
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function defaultRange(days = 30): DateRange {
  const to = new Date();
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: isoDate(from), to: isoDate(to) };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseRange(sp: { from?: string; to?: string }): DateRange {
  const d = defaultRange();
  const from = sp.from && DATE_RE.test(sp.from) ? sp.from : d.from;
  const to = sp.to && DATE_RE.test(sp.to) ? sp.to : d.to;
  return from <= to ? { from, to } : { from: to, to: from };
}

/** The equally-sized period immediately preceding `r` (for deltas). */
export function previousRange(r: DateRange): DateRange {
  const from = new Date(r.from + "T00:00:00Z");
  const to = new Date(r.to + "T00:00:00Z");
  const days = Math.round((+to - +from) / 86_400_000) + 1;
  const prevTo = new Date(from);
  prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setUTCDate(prevFrom.getUTCDate() - (days - 1));
  return { from: isoDate(prevFrom), to: isoDate(prevTo) };
}

export async function getCurrentUser() {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return user;
}

export async function getAccessibleStores(): Promise<StoreSummary[]> {
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("stores")
    .select("id,org_id,name,shopify_domain,currency,timezone,status")
    .order("name");
  return (data as StoreSummary[]) ?? [];
}

/** Whether the user is owner/admin of at least one organization. */
export async function getAdminOrgs(): Promise<{ org_id: string; role: string }[]> {
  const sb = await createServerSupabase();
  const { data } = await sb.from("memberships").select("org_id,role");
  return (data as { org_id: string; role: string }[]) ?? [];
}

/**
 * The caller's membership roles (across orgs) plus whether they are *only* a
 * vendedora. Used to gate the financial pages and tailor the nav: a
 * vendedora-only user sees just the Leads board.
 */
export async function getUserRoleSummary(): Promise<{ roles: string[]; isVendedoraOnly: boolean }> {
  const sb = await createServerSupabase();
  const { data } = await sb.from("memberships").select("role");
  const roles = ((data as { role: string }[]) ?? []).map((m) => m.role);
  const isVendedoraOnly = roles.length > 0 && roles.every((r) => r === "vendedora");
  return { roles, isVendedoraOnly };
}

export async function getRollups(
  storeIds: string[],
  range: DateRange,
): Promise<DailyRollupRow[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("daily_rollups")
    .select("*")
    .in("store_id", storeIds)
    .gte("date", range.from)
    .lte("date", range.to)
    .order("date");
  return (data as DailyRollupRow[]) ?? [];
}

function rangeBounds(range: DateRange): { startIso: string; endIso: string } {
  return { startIso: `${range.from}T00:00:00Z`, endIso: `${range.to}T23:59:59Z` };
}

const PAGE_SIZE = 1000;
const MAX_ROWS = 50_000;

export async function getOrders(
  storeIds: string[],
  range: DateRange,
): Promise<OrderRow[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const { startIso, endIso } = rangeBounds(range);
  const BASE =
    "store_id,shopify_order_id,name,created_at,processed_at,total_amount,currency,financial_status,cancelled_at,total_refunded,customer_phone,tags,promo_applied,stock_por_validar,shipping_mode,kapso_conversation_id,line_items";
  // `discount_codes` is added by 0030; step down to the base set if the column
  // isn't there yet so the dashboard never breaks during the migration window.
  const COL_SETS = [`${BASE},discount_codes`, BASE];
  let colIdx = 0;
  const out: OrderRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const page = () =>
      sb
        .from("orders")
        .select(COL_SETS[colIdx]!)
        .in("store_id", storeIds)
        // Kapso orders only (tag:kapso). The webhook path can transiently write a
        // non-Kapso order before it's tagged; keep the funnel/integrity/export
        // reads in parity with the headline rollups regardless.
        .contains("tags", ["kapso"])
        .gte("created_at", startIso)
        .lte("created_at", endIso)
        .order("created_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
    let { data, error } = await page();
    while (error && colIdx < COL_SETS.length - 1) {
      colIdx++;
      ({ data, error } = await page());
    }
    if (error || !data?.length) break;
    // Default discount_codes to [] when the column wasn't selected (pre-0030).
    out.push(...(data as unknown as OrderRow[]).map((o) => ({ ...o, discount_codes: o.discount_codes ?? [] })));
    if (data.length < PAGE_SIZE) break;
  }
  return out;
}

export async function getConversations(
  storeIds: string[],
  range: DateRange,
): Promise<ConversationRow[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const { startIso, endIso } = rangeBounds(range);
  const out: ConversationRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await sb
      .from("conversations")
      .select(
        "store_id,kapso_conversation_id,phone_number_id,started_at,status,message_count,last_message_at",
      )
      .in("store_id", storeIds)
      .gte("started_at", startIso)
      .lte("started_at", endIso)
      .order("started_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error || !data?.length) break;
    out.push(...(data as ConversationRow[]));
    if (data.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * Leads active in the range (last_interaction within bounds), RLS-scoped and
 * paginated. Feeds the leads-derived dashboard modules (loss reasons,
 * bot-vs-advisor, conversational funnel). Only the columns the metrics need.
 */
export async function getLeadsForDashboard(
  storeIds: string[],
  range: DateRange,
): Promise<LeadRow[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const { startIso, endIso } = rangeBounds(range);
  const out: LeadRow[] = [];
  const BASE_COLS =
    "id,store_id,phone,wa_id,name,email,first_seen_at,last_interaction_at,kapso_conversation_id,handoff_reason,handoff_at,category,status,needs_attention,order_id,has_order";
  // Optional attribution columns, richest first. We try the fullest set and step
  // DOWN one level on a schema error (column not yet added by a migration), so a
  // not-yet-applied migration only drops its OWN new columns — never the older
  // ones. 0012 added wa_phone_number_id on top of 0008's source/ad_id/ad_headline;
  // the previous all-or-nothing fallback to BASE_COLS would have hidden the Meta
  // campaign breakdown whenever 0012 hadn't been applied yet.
  const COL_SETS = [
    `${BASE_COLS},source,ad_id,ad_headline,wa_phone_number_id`,
    `${BASE_COLS},source,ad_id,ad_headline`,
    BASE_COLS,
  ];
  let colIdx = 0;
  const pageQuery = (select: string, from: number) =>
    sb
      .from("leads")
      .select(select)
      .in("store_id", storeIds)
      .gte("last_interaction_at", startIso)
      .lte("last_interaction_at", endIso)
      .order("last_interaction_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    let { data, error } = await pageQuery(COL_SETS[colIdx]!, from);
    while (error && colIdx < COL_SETS.length - 1) {
      colIdx++; // step down to a simpler column set and retry this page
      ({ data, error } = await pageQuery(COL_SETS[colIdx]!, from));
    }
    if (error || !data?.length) break;
    out.push(...(data as unknown as LeadRow[]));
    if (data.length < PAGE_SIZE) break;
  }
  return out;
}

/** Normalize a lead's `source` column into an attribution bucket. Campaign/cart/
 *  browse pass through; everything else (incl. null) is organic WhatsApp. Winback
 *  is never a lead source — it's derived from coupon + template send. */
function normAttributionSource(s: string | null | undefined): AttributionSource {
  return s === "meta_ad" || s === "cod_cart" || s === "abandoned_browse" ? s : "organic";
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Per-phone signals for order-source attribution (lib/metrics `salesAttribution`),
 * keyed off the ORDERS in the period — NOT range-bound, because an order may
 * reference a lead created, an advisor touch logged, or a winback message sent
 * before the period. RLS-scoped. Resilient: a missing `source` column (pre-0008)
 * or `winback_sends` table (pre-0030) simply yields fewer signals, never throws.
 */
export async function getAttributionInputs(
  storeIds: string[],
  orders: OrderRow[],
): Promise<AttributionInputs> {
  const sourceByPhone = new Map<string, AttributionSource>();
  const advisorTouchesByPhone = new Map<string, string[]>();
  const winbackByPhone = new Map<string, string[]>();
  const phones = [...new Set(orders.map((o) => o.customer_phone).filter((p): p is string => !!p))];
  if (!storeIds.length || !phones.length) {
    return { sourceByPhone, advisorTouchesByPhone, winbackByPhone };
  }
  const sb = await createServerSupabase();

  // 1) Leads for these phones → source bucket + id→phone (for the touch join).
  const leadIdToPhone = new Map<string, string>();
  for (const part of chunk(phones, 300)) {
    let res = await sb.from("leads").select("id,phone,source").in("store_id", storeIds).in("phone", part);
    if (res.error) {
      res = (await sb.from("leads").select("id,phone").in("store_id", storeIds).in("phone", part)) as typeof res;
    }
    for (const r of (res.data as { id: string; phone: string; source?: string | null }[]) ?? []) {
      leadIdToPhone.set(r.id, r.phone);
      sourceByPhone.set(r.phone, normAttributionSource(r.source));
    }
  }

  // 2) Advisor touches (lead_calls with a vendedora) on those leads → by phone.
  const leadIds = [...leadIdToPhone.keys()];
  for (const part of chunk(leadIds, 300)) {
    const { data } = await sb
      .from("lead_calls")
      .select("lead_id,occurred_at")
      .in("store_id", storeIds)
      .in("lead_id", part)
      .not("vendedora", "is", null);
    for (const r of (data as { lead_id: string; occurred_at: string | null }[]) ?? []) {
      const phone = leadIdToPhone.get(r.lead_id);
      if (!phone || !r.occurred_at) continue;
      (advisorTouchesByPhone.get(phone) ?? advisorTouchesByPhone.set(phone, []).get(phone)!).push(r.occurred_at);
    }
  }
  for (const arr of advisorTouchesByPhone.values()) arr.sort();

  // 3) Winback sends (successful) for these phones → by phone. Table may be absent
  //    before migration 0030; a query error just leaves this map empty.
  for (const part of chunk(phones, 300)) {
    const { data, error } = await sb
      .from("winback_sends")
      .select("phone,sent_at")
      .in("store_id", storeIds)
      .in("phone", part)
      .eq("ok", true);
    if (error) break;
    for (const r of (data as { phone: string; sent_at: string | null }[]) ?? []) {
      if (!r.sent_at) continue;
      (winbackByPhone.get(r.phone) ?? winbackByPhone.set(r.phone, []).get(r.phone)!).push(r.sent_at);
    }
  }
  for (const arr of winbackByPhone.values()) arr.sort();

  return { sourceByPhone, advisorTouchesByPhone, winbackByPhone };
}

/**
 * Total Meta ad spend for a store over the range (the cost side of ROAS on the
 * "Meta Ads" attribution row). Loads the store's decrypted token + ad accounts
 * and calls the Graph API best-effort. Returns null when the store hasn't
 * connected Meta or the API can't be reached — the UI then shows "—". Uses the
 * admin client to decrypt the token (the caller has already verified the user
 * may access this store), and never throws.
 */
export async function getMetaSpend(storeId: string, range: DateRange): Promise<number | null> {
  try {
    const admin = createAdminSupabase();
    const { data } = await admin
      .from("stores")
      .select("meta_access_token_enc, meta_ad_accounts, meta_ad_account_id, meta_ad_account_name")
      .eq("id", storeId)
      .maybeSingle();
    if (!data) return null;
    const token = decryptOrNull((data as { meta_access_token_enc: string | null }).meta_access_token_enc);
    if (!token) return null;
    const accounts = normalizeMetaAdAccounts(
      (data as { meta_ad_accounts: unknown }).meta_ad_accounts,
      (data as { meta_ad_account_id?: string | null }).meta_ad_account_id,
      (data as { meta_ad_account_name?: string | null }).meta_ad_account_name,
    );
    if (!accounts.length) return null;
    return await fetchMetaSpend(token, accounts.map((a) => a.id), range);
  } catch {
    return null;
  }
}

/**
 * Resolve Meta `ad_id`s → attribution (real ad / adset / campaign names,
 * objective, status, owning account) from the `meta_ads` lookup. Keyed by the
 * globally-unique ad_id, so it is not store-scoped. Returns {} when no ids are
 * given or the table/rows are absent — callers then degrade to the captured
 * CTWA headline. Never throws (the rest of the dashboard must render regardless).
 */
export async function getAdNames(
  adIds: (string | null | undefined)[],
): Promise<Record<string, AdMeta>> {
  const ids = [...new Set(adIds.filter((x): x is string => !!x))];
  if (!ids.length) return {};
  // The `meta_ads` label table is not readable under RLS (migration 0034). The
  // ad_ids passed in already come from the caller's own RLS-scoped leads, so
  // resolving their labels via the service-role client leaks nothing: you can
  // only look up ads your own leads reference.
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("meta_ads")
    .select(
      "ad_id,account_id,campaign_id,campaign_name,objective,adset_id,adset_name,ad_name,status,fetched_at",
    )
    .in("ad_id", ids);
  if (error || !data) return {}; // table not applied yet, or no rows — degrade gracefully
  const out: Record<string, AdMeta> = {};
  for (const r of data as Record<string, string | null>[]) {
    if (!r.ad_id) continue;
    out[r.ad_id] = {
      accountId: r.account_id ?? null,
      campaignId: r.campaign_id ?? null,
      campaignName: r.campaign_name ?? null,
      objective: r.objective ?? null,
      adsetId: r.adset_id ?? null,
      adsetName: r.adset_name ?? null,
      adName: r.ad_name ?? null,
      status: r.status ?? null,
      fetchedAt: r.fetched_at ?? null,
    };
  }
  return out;
}

/**
 * Resolve WhatsApp `phone_number_id`s → friendly labels (name / display phone /
 * kind) from the `whatsapp_numbers` lookup. Returns {} when none given or the
 * table/rows are absent — callers then fall back to the raw id. Never throws.
 */
export async function getWaNumbers(
  phoneNumberIds: (string | null | undefined)[],
): Promise<Record<string, WaNumber>> {
  const ids = [...new Set(phoneNumberIds.filter((x): x is string => !!x))];
  if (!ids.length) return {};
  // `whatsapp_numbers` is not readable under RLS (migration 0034); resolve the
  // labels via the service-role client. The ids come from the caller's own
  // RLS-scoped leads/conversations, so this exposes nothing cross-tenant.
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("whatsapp_numbers")
    .select("phone_number_id,name,display_phone,kind")
    .in("phone_number_id", ids);
  if (error || !data) return {};
  const out: Record<string, WaNumber> = {};
  for (const r of data as Record<string, string | null>[]) {
    if (!r.phone_number_id) continue;
    out[r.phone_number_id] = {
      phoneNumberId: r.phone_number_id,
      name: r.name ?? null,
      displayPhone: r.display_phone ?? null,
      kind: r.kind ?? null,
    };
  }
  return out;
}

/** Most recent ops snapshot per store (best-effort operational family). */
export async function getLatestOps(
  storeIds: string[],
): Promise<Record<string, unknown>> {
  if (!storeIds.length) return {};
  const sb = await createServerSupabase();
  const out: Record<string, unknown> = {};
  // One small query per store keeps it simple and RLS-safe.
  await Promise.all(
    storeIds.map(async (id) => {
      const { data } = await sb
        .from("ops_snapshots")
        .select("payload,captured_at")
        .eq("store_id", id)
        .order("captured_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) out[id] = data.payload;
    }),
  );
  return out;
}
