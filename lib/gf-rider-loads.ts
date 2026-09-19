import { createAdminSupabase } from "@/lib/db";
import { getMyRider } from "@/lib/routes-access";
import { riderPickupMode } from "@/lib/grupo-gf-courier-route-access";
import type { RiderPickupMode } from "@/lib/grupo-gf-courier";

export interface RiderLoadItem {
  id: string;
  shipment_id: string;
  order_id: string | null;
  order_name: string | null;
  customer_name: string | null;
  district: string | null;
  output_code: string | null;
  guide_code: string | null;
  pickup_checked_at: string | null;
  pickup_declined_at: string | null;
  pickup_declined_reason: string | null;
}

export interface RiderLoad {
  id: string;
  route_date: string;
  load_number: number;
  state: string;
  total: number;
  received: number;
  declined: number;
  items: RiderLoadItem[];
}

/**
 * Las cargas que el motorizado tiene por recibir: cotejadas por oficina y
 * todavía sin custodia. Con sus paquetes, para que «Recibir mi caja» muestre
 * qué falta y permita decir «no lo recojo» (0174, MOM §29.13).
 */
export async function getMyGfLoads(): Promise<RiderLoad[]> {
  const rider = await getMyRider();
  if (!rider) return [];
  const admin = createAdminSupabase();
  const { data, error } = await admin.from("dispatch_manifests").select("id,route_date,load_number,state")
    .eq("rider_id", rider.id).eq("courier", "propio").in("state", ["ready_for_pickup", "pickup_check"])
    .order("route_date", { ascending: false });
  if (error) throw new Error(error.message);
  return Promise.all((data ?? []).map(async (load) => {
    const { data: rows, error: itemsError } = await admin.from("dispatch_manifest_items")
      .select("id,shipment_id,pickup_checked_at,pickup_declined_at,pickup_declined_reason,removed_at,shipments(order_id,order_name,customer_name,district,output_code,guide_code)")
      .eq("manifest_id", load.id)
      .order("added_at", { ascending: true });
    if (itemsError) throw new Error(itemsError.message);
    const items: RiderLoadItem[] = ((rows ?? []) as unknown as Array<{
      id: string; shipment_id: string; pickup_checked_at: string | null; pickup_declined_at: string | null; pickup_declined_reason: string | null; removed_at: string | null;
      shipments: { order_id: string | null; order_name: string | null; customer_name: string | null; district: string | null; output_code: string | null; guide_code: string | null } | null;
    }>)
      // Los retirados por el supervisor no se muestran; los que el propio
      // motorizado rechazó sí, para que vea lo que dijo.
      .filter((row) => !row.removed_at || row.pickup_declined_at)
      .map((row) => ({
        id: row.id,
        shipment_id: row.shipment_id,
        order_id: row.shipments?.order_id ?? null,
        order_name: row.shipments?.order_name ?? null,
        customer_name: row.shipments?.customer_name ?? null,
        district: row.shipments?.district ?? null,
        output_code: row.shipments?.output_code ?? null,
        guide_code: row.shipments?.guide_code ?? null,
        pickup_checked_at: row.pickup_checked_at,
        pickup_declined_at: row.pickup_declined_at,
        pickup_declined_reason: row.pickup_declined_reason,
      }));
    const active = items.filter((item) => !item.pickup_declined_at);
    return {
      ...load,
      state: String(load.state),
      total: active.length,
      received: active.filter((item) => item.pickup_checked_at).length,
      declined: items.length - active.length,
      items,
    };
  }));
}

/** El modo de recojo del motorizado (0177): se lee por la organización de su ficha. */
export async function getMyPickupMode(): Promise<RiderPickupMode> {
  const rider = await getMyRider();
  if (!rider) return "exigir";
  const admin = createAdminSupabase();
  const { data } = await admin.from("riders").select("org_id").eq("id", rider.id).maybeSingle();
  if (!data?.org_id) return "exigir";
  return riderPickupMode(admin, data.org_id as string);
}
