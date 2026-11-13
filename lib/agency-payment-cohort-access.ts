import type { SupabaseClient } from "@supabase/supabase-js";
import type { MasterFilters } from "@/lib/order-master-filters";

/** The same paginated source for the Master list, its counts and its export. RLS remains active. */
export function masterCohortQuery(
  sb: SupabaseClient, storeIds: string[], filters: MasterFilters,
  columns: string, options?: { count: "exact"; head: true },
) {
  if (!filters.agencyUnpaid && !filters.historicalPaid) return sb.from("order_master").select(columns, options);
  return sb.rpc("order_master_agency_payments", {
    p_store_ids: storeIds, p_from: filters.agencyUnpaid?.from ?? null, p_to: filters.agencyUnpaid?.to ?? null,
    p_bucket: filters.historicalPaid ? "historical" : filters.agencyPaymentView ?? "collect",
  }, options).select(columns);
}
