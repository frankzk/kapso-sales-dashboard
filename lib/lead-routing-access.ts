import { cache } from "react";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { EMPTY_LEAD_ROUTING, type LeadRoutingSettings, type LeadWorkBlock } from "@/lib/lead-routing";
import type { LeadCounts } from "@/lib/leads-access";

export interface LeadRoutingScope {
  enabled: boolean;
  blocks: LeadWorkBlock[];
  blockedIds: string[];
  allowed: boolean;
  signature: string;
  counts?: LeadCounts;
}
/** Internal only: used by offer rotation for advisors already loaded from the database. */
export async function readRoutingForActor(actor: string, storeIds: string[], leadId: string | null = null): Promise<LeadRoutingScope> {
  const { data: scope, error } = await createAdminSupabase().rpc("lead_routing_scope", {
    p_actor: actor, p_stores: storeIds, p_lead: leadId,
  });
  if (error || !scope) throw new Error("No se pudo comprobar la asignación de leads.");
  return scope as LeadRoutingScope;
}
const readScope = cache(async (storesKey: string, leadId: string | null): Promise<LeadRoutingScope> => {
  const sb = await createServerSupabase();
  const { data } = await sb.auth.getClaims();
  const actor = data?.claims?.sub;
  if (!actor) throw new Error("Sin sesión.");
  return readRoutingForActor(actor, storesKey.split(",").filter(Boolean), leadId);
});
export function getLeadRoutingScope(storeIds: string[], leadId: string | null = null) {
  return readScope([...new Set(storeIds)].sort().join(","), leadId);
}
export function filterRoutedLeads<T extends { id?: string }>(rows: T[], scope: LeadRoutingScope): T[] {
  if (!scope.enabled) return rows;
  const blocked = new Set(scope.blockedIds);
  return rows.filter(row => !!row.id && !blocked.has(row.id));
}
export function filterManualSearchLeads<T extends { id?: string; store_id: string }>(rows: T[], scope: LeadRoutingScope, manualStores: readonly string[]) {
  const allowed = new Set(filterRoutedLeads(rows, scope).map(l => l.id));
  const manual = new Set(manualStores);
  return rows.filter(l => !!l.id && (allowed.has(l.id) || manual.has(l.store_id)))
    .map(l => allowed.has(l.id) ? l : { ...l, manual_take_required: true });
}
export async function getTeamLeadRouting(orgId: string): Promise<{ settings: LeadRoutingSettings; installed: boolean }> {
  // Caller must first authorize team.manage for this organization (TeamPage).
  const admin = createAdminSupabase();
  const [{ data: settings, error }, { data: assignments, error: rowsError }] = await Promise.all([
    admin.from("lead_routing_settings").select("enabled,fresh_hours,revision").eq("org_id", orgId).maybeSingle(),
    admin.from("lead_routing_assignments").select("user_id,blocks,backup,manual_take").eq("org_id", orgId),
  ]);
  if (error?.code === "42P01" || error?.code === "PGRST205") return { settings: EMPTY_LEAD_ROUTING, installed: false };
  if (error || rowsError) throw new Error("No se pudo cargar la configuración de Leads.");
  return { installed: true, settings: {
    enabled: settings?.enabled ?? false, freshHours: settings?.fresh_hours ?? 24, revision: settings?.revision ?? 0,
    assignments: (assignments ?? []).map(a => ({ userId: a.user_id, blocks: a.blocks as LeadWorkBlock[], backup: a.backup, manualTake: a.manual_take ?? false })),
  } };
}

/** Only expands explicit search results, never the automatic queue. */
export async function getLeadManualTakeStores(storeIds: string[]): Promise<string[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const { data } = await sb.auth.getClaims();
  const actor = data?.claims?.sub;
  if (!actor) return [];
  const result = await createAdminSupabase().rpc("lead_manual_take_stores", { p_actor: actor, p_stores: storeIds });
  if (result.error) throw new Error("No se pudo comprobar el permiso de toma puntual.");
  return (result.data ?? []) as string[];
}
