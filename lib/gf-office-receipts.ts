import type { createAdminSupabase } from "@/lib/db";
import { courierRowsByIds } from "@/lib/courier-flow";

type Admin = ReturnType<typeof createAdminSupabase>;

/** Repetir una lectura confirma un hecho; nunca vuelve a recibir ni mueve stock. */
export async function findOfficeReceipts(admin: Admin, shipmentIds: string[], manifestIds?: ReadonlySet<string>): Promise<string[]> {
  if (!shipmentIds.length) return [];
  const [{ data: shipments }, { data: items }, { data: receipts }] = await Promise.all([
    courierRowsByIds(shipmentIds, (ids) => admin.from("shipments")
      .select("id,custody_state,delivery_status,dispatched_at").in("id", ids)),
    courierRowsByIds(shipmentIds, (ids) => admin.from("dispatch_manifest_items")
      .select("shipment_id").in("shipment_id", ids).is("removed_at", null)),
    courierRowsByIds(shipmentIds, (ids) => admin.from("order_events")
      .select("shipment_id,occurred_at,payload").in("shipment_id", ids)
      .in("kind", ["returned_to_office", "return_received"]).eq("source", "dispatch").not("actor", "is", null)),
  ]);
  const inBox = new Set(items.map((item) => item.shipment_id as string));
  return shipments.filter((shipment) => {
    if (inBox.has(shipment.id) || shipment.delivery_status === "entregado"
      || !["empresa", "devuelto"].includes(shipment.custody_state ?? "")) return false;
    return receipts.some((receipt) => receipt.shipment_id === shipment.id
      && (!manifestIds || manifestIds.has(String((receipt.payload as { manifest_id?: string } | null)?.manifest_id ?? "")))
      && (!shipment.dispatched_at || Date.parse(receipt.occurred_at) >= Date.parse(shipment.dispatched_at)));
  }).map((shipment) => shipment.id as string);
}
