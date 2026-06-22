// Server-side, RLS-scoped data access for the dashboards. Every query runs
// through the cookie-bound server client, so a user only ever sees rows for
// stores they may access.

import { createServerSupabase } from "@/lib/db";
import type {
  ConversationRow,
  DailyRollupRow,
  OrderRow,
  StoreSummary,
} from "@/lib/types";

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

export async function getOrders(
  storeIds: string[],
  range: DateRange,
): Promise<OrderRow[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const { startIso, endIso } = rangeBounds(range);
  const { data } = await sb
    .from("orders")
    .select(
      "store_id,shopify_order_id,name,created_at,processed_at,total_amount,currency,financial_status,cancelled_at,total_refunded,tags,promo_applied,stock_por_validar,shipping_mode,kapso_conversation_id,line_items",
    )
    .in("store_id", storeIds)
    .gte("created_at", startIso)
    .lte("created_at", endIso)
    .order("created_at", { ascending: false })
    .limit(5000);
  return (data as OrderRow[]) ?? [];
}

export async function getConversations(
  storeIds: string[],
  range: DateRange,
): Promise<ConversationRow[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const { startIso, endIso } = rangeBounds(range);
  const { data } = await sb
    .from("conversations")
    .select(
      "store_id,kapso_conversation_id,phone_number_id,started_at,status,message_count,last_message_at",
    )
    .in("store_id", storeIds)
    .gte("started_at", startIso)
    .lte("started_at", endIso)
    .limit(20000);
  return (data as ConversationRow[]) ?? [];
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
