"use server";

import { getAccessibleStores, getUserRoleSummary, type DateRange } from "@/lib/access";
import { getAgentLeadsWorked, type AgentLeadRow } from "@/lib/productivity";

/** Leads a single advisor worked in the range — drives the drill-down rows that
 *  expand under each asesora in the productividad table. RLS-scoped; managers
 *  only (vendedoras don't see this page). Returns [] on any access problem. */
export async function loadAgentLeads(input: {
  vendedoraId: string;
  from: string;
  to: string;
  store?: string | null;
  source?: "meta_ad" | "cod_cart" | "organic" | null;
}): Promise<AgentLeadRow[]> {
  if ((await getUserRoleSummary()).isVendedoraOnly) return [];
  const stores = await getAccessibleStores();
  if (!stores.length) return [];
  const storeIds = stores.map((s) => s.id);
  const scopeIds = input.store && stores.some((s) => s.id === input.store) ? [input.store] : storeIds;
  const range: DateRange = { from: input.from, to: input.to };
  return getAgentLeadsWorked(scopeIds, range, input.vendedoraId, input.source ?? null);
}
