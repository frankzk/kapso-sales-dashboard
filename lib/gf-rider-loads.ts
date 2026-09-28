import { createAdminSupabase } from "@/lib/db";
import { getMyRider } from "@/lib/routes-access";
import { riderPickupMode } from "@/lib/grupo-gf-courier-route-access";
import { riderLoadOpenToReceive, type RiderPickupMode } from "@/lib/grupo-gf-courier";

export interface RiderLoadItem {
  id: string;
  shipment_id: string;
  order_id: string | null;
  order_name: string | null;
  customer_name: string | null;
  district: string | null;
  output_code: string | null;
  guide_code: string | null;
  /** Null: oficina todavía no lo verifica y no se puede recibir (0196). */
  office_checked_at: string | null;
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
  /** Activos sin verificar por oficina: se ven, pero todavía no se reciben. */
  awaitingOffice: number;
  items: RiderLoadItem[];
}

/**
 * Las cargas que el motorizado tiene por recibir: sin custodia y con algo que
 * oficina ya verificó. Desde 0196 incluye la caja que oficina todavía coteja,
 * porque se le siguen sumando paquetes en paralelo: el motorizado recibe lo
 * verificado y ve lo demás «esperando a oficina». Con sus paquetes, para que
 * «Recibir mi caja» muestre qué falta y permita decir «no lo recojo» (0182,
 * MOM §29.13).
 */
export async function getMyGfLoads(): Promise<RiderLoad[]> {
  const rider = await getMyRider();
  if (!rider) return [];
  const admin = createAdminSupabase();
  const { data, error } = await admin.from("dispatch_manifests").select("id,route_date,load_number,state")
    .eq("rider_id", rider.id).eq("courier", "propio").in("state", ["office_check", "ready_for_pickup", "pickup_check"])
    .order("route_date", { ascending: false });
  if (error) throw new Error(error.message);
  const loads = await Promise.all((data ?? []).map(async (load) => {
    const { data: rows, error: itemsError } = await admin.from("dispatch_manifest_items")
      .select("id,shipment_id,office_checked_at,pickup_checked_at,pickup_declined_at,pickup_declined_reason,removed_at,shipments(order_id,order_name,customer_name,district,output_code,guide_code)")
      .eq("manifest_id", load.id)
      .order("added_at", { ascending: true });
    if (itemsError) throw new Error(itemsError.message);
    const typed = (rows ?? []) as unknown as Array<{
      id: string; shipment_id: string; office_checked_at: string | null; pickup_checked_at: string | null; pickup_declined_at: string | null; pickup_declined_reason: string | null; removed_at: string | null;
      shipments: { order_id: string | null; order_name: string | null; customer_name: string | null; district: string | null; output_code: string | null; guide_code: string | null } | null;
    }>;
    if (!riderLoadOpenToReceive(String(load.state), typed)) return null;
    const items: RiderLoadItem[] = typed
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
        office_checked_at: row.office_checked_at,
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
      awaitingOffice: active.filter((item) => !item.office_checked_at && !item.pickup_checked_at).length,
      items,
    };
  }));
  return loads.filter((load): load is RiderLoad => load !== null);
}

/** El modo de recojo del motorizado (0185): se lee por la organización de su ficha. */
export async function getMyPickupMode(): Promise<RiderPickupMode> {
  const rider = await getMyRider();
  if (!rider) return "exigir";
  const admin = createAdminSupabase();
  const { data } = await admin.from("riders").select("org_id").eq("id", rider.id).maybeSingle();
  if (!data?.org_id) return "exigir";
  return riderPickupMode(admin, data.org_id as string);
}
