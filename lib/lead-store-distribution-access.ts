import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { PRIORITY_DISTRIBUTION, type LeadStoreDistribution } from "@/lib/lead-store-distribution";

/** No caller-supplied actor and no cross-organization/store telemetry. */
export async function getLeadStoreDistribution(storeIds: string[]): Promise<LeadStoreDistribution> {
  const [user, stores] = await Promise.all([getCurrentUser(), getAccessibleStores()]);
  if (!user) throw new Error("Sin sesión.");
  if (!storeIds.length) return PRIORITY_DISTRIBUTION;
  if (storeIds.length > 100 || storeIds.some(id => !stores.some(s => s.id === id))) throw new Error("Sin acceso a estas tiendas.");
  const { data, error } = await createAdminSupabase().rpc("lead_store_distribution", { p_actor: user.id, p_stores: [...new Set(storeIds)] });
  if (error || !data) throw new Error("No se pudo comprobar la distribución por tienda. Reintenta.");
  return data as LeadStoreDistribution;
}
