import { createAdminSupabase } from "@/lib/db";
import { getMyRider } from "@/lib/routes-access";

export interface RiderLoad { id: string; route_date: string; load_number: number; total: number; received: number }

export async function getMyGfLoads(): Promise<RiderLoad[]> {
  const rider = await getMyRider();
  if (!rider) return [];
  const admin = createAdminSupabase();
  const { data, error } = await admin.from("dispatch_manifests").select("id,route_date,load_number")
    .eq("rider_id", rider.id).eq("courier", "propio").in("state", ["ready_for_pickup", "pickup_check"])
    .order("route_date", { ascending: false });
  if (error) throw new Error(error.message);
  return Promise.all((data ?? []).map(async (load) => {
    const { data: items, error } = await admin.from("dispatch_manifest_items")
      .select("pickup_checked_at").eq("manifest_id", load.id).is("removed_at", null);
    if (error) throw new Error(error.message);
    return { ...load, total: items?.length ?? 0, received: items?.filter((item) => item.pickup_checked_at).length ?? 0 };
  }));
}
