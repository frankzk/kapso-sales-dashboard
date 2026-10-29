import type { SupabaseClient } from "@supabase/supabase-js";
import type { MasterFilters } from "@/lib/order-master-filters";

/** The same paginated source for the Master list, its counts and its export. RLS remains active. */
export function masterCohortQuery(
  sb: SupabaseClient, storeIds: string[], filters: MasterFilters,
  columns: string, options?: { count: "exact"; head: true },
) {
  if (!filters.agencyUnpaid) return sb.from("order_master").select(columns, options);
  return sb.rpc("order_master_agency_unpaid", {
    p_store_ids: storeIds, p_from: filters.agencyUnpaid.from, p_to: filters.agencyUnpaid.to,
  }, options).select(columns);
}
