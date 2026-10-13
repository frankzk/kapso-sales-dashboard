// La caja activa de cada salida de Grupo GF y si su motorizado la reportó «No
// entregado» en ella. La leen Despacho del día (cola, «Recibir en oficina»,
// «Sacar con salida nueva») y Repro Lima (dónde está la caja). Movida tal cual
// desde app/dashboard/courier/actions.ts (12-10-2026): un archivo "use server"
// solo exporta acciones.

import type { createAdminSupabase } from "@/lib/db";
import { courierKey } from "@/lib/dispatch";
import { courierRowsByIds } from "@/lib/courier-flow";

type Admin = ReturnType<typeof createAdminSupabase>;

export interface CourierRouteAssignment {
  manifestId: string;
  loadNumber: number;
  deliveryRouteId: string | null;
  routeDate: string;
  riderId: string | null;
  riderName: string;
  state: string;
  officeCheckedAt: string | null;
  pickupCheckedAt: string | null;
  /** El motorizado lo reportó «No entregado» y sigue en su caja: motivo del reporte. */
  undeliveredReason?: string | null;
}

/**
 * La caja activa de cada salida (ítem sin `removed_at`) y, si lo ÚLTIMO que su
 * motorizado reportó en ESA caja es «No entregado», su motivo: exactamente lo
 * que exige `gf_return_to_office` (0206: caja de Grupo GF, última parada por
 * `reported_at`). Para las salidas propias que se reprograman sin solicitud de
 * Grupo GF (`ownRetryOutput`), que no pasan por `accepted`.
 */
export async function loadActiveBoxes(admin: Admin, shipmentIds: string[]): Promise<Map<string, CourierRouteAssignment>> {
  const out = new Map<string, CourierRouteAssignment>();
  if (!shipmentIds.length) return out;
  const { data: items } = await courierRowsByIds(shipmentIds, (ids) => admin
    .from("dispatch_manifest_items")
    .select("shipment_id,manifest_id,office_checked_at,pickup_checked_at")
    .in("shipment_id", ids)
    .is("removed_at", null));
  const boxItems = items as Array<{ shipment_id: string; manifest_id: string; office_checked_at: string | null; pickup_checked_at: string | null }>;
  if (!boxItems.length) return out;
  const [{ data: manifests }, { data: stops }] = await Promise.all([
    courierRowsByIds([...new Set(boxItems.map((item) => item.manifest_id))], (ids) => admin
      .from("dispatch_manifests")
      .select("id,courier,route_date,rider_id,driver_name,state,load_number,delivery_route_id")
      .in("id", ids)),
    courierRowsByIds(boxItems.map((item) => item.shipment_id), (ids) => admin
      .from("delivery_stops")
      .select("shipment_id,dispatch_manifest_id,status,outcome_reason,reported_at")
      .in("shipment_id", ids)
      .not("dispatch_manifest_id", "is", null)),
  ]);
  const manifestById = new Map((manifests as Array<{
    id: string;
    courier: string;
    route_date: string;
    rider_id: string | null;
    driver_name: string | null;
    state: string;
    load_number: number;
    delivery_route_id: string | null;
  }>).map((manifest) => [manifest.id, manifest]));
  // La última parada de cada (caja, salida), como la ordena la 0206.
  const lastStop = new Map<string, { status: string; outcome_reason: string | null; reported_at: string | null }>();
  for (const stop of stops as Array<{ shipment_id: string; dispatch_manifest_id: string; status: string; outcome_reason: string | null; reported_at: string | null }>) {
    const key = `${stop.dispatch_manifest_id}:${stop.shipment_id}`;
    const current = lastStop.get(key);
    if (!current || (stop.reported_at ?? "") > (current.reported_at ?? "")) lastStop.set(key, stop);
  }
  for (const item of boxItems) {
    const manifest = manifestById.get(item.manifest_id);
    const stop = lastStop.get(`${item.manifest_id}:${item.shipment_id}`);
    const undelivered = manifest && courierKey(manifest.courier) === "propio" && stop?.status === "no_entregado";
    out.set(item.shipment_id, {
      manifestId: item.manifest_id,
      loadNumber: manifest?.load_number ?? 1,
      deliveryRouteId: manifest?.delivery_route_id ?? null,
      routeDate: manifest?.route_date ?? "",
      riderId: manifest?.rider_id ?? null,
      riderName: manifest?.driver_name ?? "Motorizado sin nombre",
      state: manifest?.state ?? "unknown",
      officeCheckedAt: item.office_checked_at,
      pickupCheckedAt: item.pickup_checked_at,
      undeliveredReason: undelivered ? stop?.outcome_reason ?? "sin motivo" : null,
    });
  }
  return out;
}
