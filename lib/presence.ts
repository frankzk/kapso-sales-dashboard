// Presence reads over `user_presence` (heartbeat upserted by the dashboard's
// Yape polling — see listYapeAlerts). The table has RLS with NO policies, so
// every read here requires the SERVICE-ROLE client; callers must authorize the
// requester themselves before calling in. Extracted from
// app/dashboard/leads/actions.ts so non-"use server" code (the productivity
// board) can reuse it — exporting from a "use server" file would turn the
// helper into a public endpoint.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ONLINE_TTL_MS, type RoutingAdvisor } from "@/lib/yape-routing";

/** Online vendedoras (presence heartbeat fresh) with access to the store. */
export async function onlineVendedorasForStore(
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

/** Union of the online vendedora ids across several stores ("En línea ahora"
 *  for the productivity board). Best-effort: a failing store contributes none. */
export async function onlineVendedoraIds(
  admin: SupabaseClient,
  storeIds: string[],
  nowMs: number,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const perStore = await Promise.all(
    storeIds.map((sid) => onlineVendedorasForStore(admin, sid, nowMs).catch(() => [] as RoutingAdvisor[])),
  );
  for (const advisors of perStore) for (const a of advisors) ids.add(a.id);
  return ids;
}
