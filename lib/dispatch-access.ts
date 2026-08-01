import { createServerSupabase } from "@/lib/db";
import type { DispatchManifestState } from "@/lib/dispatch";

export interface DispatchShipment {
  id: string;
  store_id: string;
  courier: string;
  guide_code: string;
  output_number: number | null;
  output_code: string | null;
  qr_token: string | null;
  preparation_state: string;
  custody_state: string;
  ready_at: string | null;
  order_id: string | null;
  order_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  district: string | null;
  province: string | null;
  product: string | null;
}

export interface DispatchManifestItem {
  id: string;
  manifest_id: string;
  shipment_id: string;
  store_id: string;
  added_by: string | null;
  added_at: string;
  office_checked_by: string | null;
  office_checked_at: string | null;
  pickup_checked_by: string | null;
  pickup_checked_at: string | null;
  removed_by: string | null;
  removed_at: string | null;
  removal_reason: string | null;
  shipment: DispatchShipment | null;
}

export interface DispatchManifest {
  id: string;
  org_id: string;
  courier: string;
  route_date: string;
  route_label: string;
  driver_name: string | null;
  state: DispatchManifestState;
  created_by: string | null;
  office_completed_at: string | null;
  custody_completed_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
  items: DispatchManifestItem[];
}

export interface DispatchWorkspaceData {
  manifests: DispatchManifest[];
  readyShipments: DispatchShipment[];
}

export const DISPATCH_SHIPMENT_COLUMNS =
  "id,store_id,courier,guide_code,output_number,output_code,qr_token," +
  "preparation_state,custody_state,ready_at,order_id,order_name,customer_name," +
  "customer_phone,district,province,product";

const MANIFEST_COLUMNS =
  "id,org_id,courier,route_date,route_label,driver_name,state,created_by," +
  "office_completed_at,custody_completed_at,cancellation_reason,created_at";

const ITEM_COLUMNS =
  "id,manifest_id,shipment_id,store_id,added_by,added_at,office_checked_by," +
  "office_checked_at,pickup_checked_by,pickup_checked_at,removed_by,removed_at,removal_reason";

export async function getDispatchWorkspaceData(): Promise<DispatchWorkspaceData> {
  const sb = await createServerSupabase();
  const [activeManifestRes, historyManifestRes, readyRes] = await Promise.all([
    sb
      .from("dispatch_manifests")
      .select(MANIFEST_COLUMNS)
      .not("state", "in", "(in_custody,cancelled)")
      .order("route_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(100),
    sb
      .from("dispatch_manifests")
      .select(MANIFEST_COLUMNS)
      .in("state", ["in_custody", "cancelled"])
      .order("route_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(20),
    sb
      .from("shipments")
      .select(DISPATCH_SHIPMENT_COLUMNS)
      .eq("preparation_state", "listo_despacho")
      .eq("custody_state", "empresa")
      .order("ready_at", { ascending: false })
      .limit(300),
  ]);

  const rawManifests = [
    ...((activeManifestRes.data ?? []) as unknown as Omit<DispatchManifest, "items">[]),
    ...((historyManifestRes.data ?? []) as unknown as Omit<DispatchManifest, "items">[]),
  ];
  const manifestIds = rawManifests.map((manifest) => manifest.id);
  let rawItems: Omit<DispatchManifestItem, "shipment">[] = [];
  if (manifestIds.length) {
    const { data } = await sb
      .from("dispatch_manifest_items")
      .select(ITEM_COLUMNS)
      .in("manifest_id", manifestIds)
      .order("added_at", { ascending: true });
    rawItems = (data ?? []) as unknown as Omit<DispatchManifestItem, "shipment">[];
  }

  const shipmentIds = [...new Set(rawItems.map((item) => item.shipment_id))];
  const shipmentMap = new Map<string, DispatchShipment>();
  for (let start = 0; start < shipmentIds.length; start += 200) {
    const { data } = await sb
      .from("shipments")
      .select(DISPATCH_SHIPMENT_COLUMNS)
      .in("id", shipmentIds.slice(start, start + 200));
    for (const row of (data ?? []) as unknown as DispatchShipment[]) shipmentMap.set(row.id, row);
  }

  const itemsByManifest = new Map<string, DispatchManifestItem[]>();
  for (const item of rawItems) {
    const hydrated: DispatchManifestItem = {
      ...item,
      shipment: shipmentMap.get(item.shipment_id) ?? null,
    };
    const list = itemsByManifest.get(item.manifest_id) ?? [];
    list.push(hydrated);
    itemsByManifest.set(item.manifest_id, list);
  }

  const activeShipmentIds = new Set(
    rawItems.filter((item) => !item.removed_at).map((item) => item.shipment_id),
  );
  return {
    manifests: rawManifests.map((manifest) => ({
      ...manifest,
      items: itemsByManifest.get(manifest.id) ?? [],
    })),
    readyShipments: ((readyRes.data ?? []) as unknown as DispatchShipment[]).filter(
      (shipment) => !activeShipmentIds.has(shipment.id),
    ),
  };
}
