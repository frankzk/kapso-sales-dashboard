// Server-side, RLS-scoped data access for the dashboards. Every query runs
// through the cookie-bound server client, so a user only ever sees rows for
// stores they may access.

import { createServerSupabase } from "@/lib/db";
import type {
  ConversationRow,
  DailyRollupRow,
  LeadRow,
  OrderRow,
  StoreSummary,
} from "@/lib/types";
import type { AdMeta } from "@/lib/meta-ads";
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
  const out: OrderRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await sb
      .from("orders")
      .select(
        "store_id,shopify_order_id,name,created_at,processed_at,total_amount,currency,financial_status,cancelled_at,total_refunded,customer_phone,tags,promo_applied,stock_por_validar,shipping_mode,kapso_conversation_id,line_items",
      )
      .in("store_id", storeIds)
      // Kapso orders only (tag:kapso). The webhook path can transiently write a
      // non-Kapso order before it's tagged; keep the funnel/integrity/export
      // reads in parity with the headline rollups regardless.
      .contains("tags", ["kapso"])
      .gte("created_at", startIso)
      .lte("created_at", endIso)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error || !data?.length) break;
    out.push(...(data as OrderRow[]));
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
  const sb = await createServerSupabase();
  const { data, error } = await sb
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
  const sb = await createServerSupabase();
  const { data, error } = await sb
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
