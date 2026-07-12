"use server";

import { getAccessibleStores, getUserRoleSummary, type DateRange } from "@/lib/access";
import { getAgentLeadsWorked, type AgentLeadRow, type SourceBucket } from "@/lib/productivity";
import { onlineVendedoraIds } from "@/lib/presence";
import { createAdminSupabase } from "@/lib/db";

/** Vendedoras online AHORA (heartbeat de presencia fresco) en las tiendas del
 *  caller — alimenta los puntos verdes del tablero (polling ~45s). El alcance se
 *  deriva SIEMPRE server-side de las tiendas accesibles (nunca acepta ids del
 *  cliente); `user_presence` tiene RLS sin policies, así que la lectura va con
 *  el service role tras pasar el gate. Best-effort: [] ante cualquier problema. */
export async function getOnlineAdvisorIds(): Promise<string[]> {
  try {
    if ((await getUserRoleSummary()).isVendedoraOnly) return [];
    const stores = await getAccessibleStores();
    if (!stores.length) return [];
    const ids = await onlineVendedoraIds(
      createAdminSupabase(),
      stores.map((s) => s.id),
      Date.now(),
    );
    return [...ids];
  } catch {
    return [];
  }
}

/** Leads a single advisor worked in the range — drives the drill-down rows that
 *  expand under each asesora in the productividad table. RLS-scoped; managers
 *  only (vendedoras don't see this page). Returns [] on any access problem. */
export async function loadAgentLeads(input: {
  vendedoraId: string;
  from: string;
  to: string;
  store?: string | null;
  source?: SourceBucket | null;
}): Promise<AgentLeadRow[]> {
  if ((await getUserRoleSummary()).isVendedoraOnly) return [];
  const stores = await getAccessibleStores();
  if (!stores.length) return [];
  const storeIds = stores.map((s) => s.id);
  const scopeIds = input.store && stores.some((s) => s.id === input.store) ? [input.store] : storeIds;
  const range: DateRange = { from: input.from, to: input.to };
  return getAgentLeadsWorked(scopeIds, range, input.vendedoraId, input.source ?? null);
}
