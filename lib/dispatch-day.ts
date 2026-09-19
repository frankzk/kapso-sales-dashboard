// Despacho del día (MOM §29.13): lo puro de la pantalla de dos pasos.
// Sin base ni React, probado en test/dispatch-day.test.ts.

import { courierKey, dispatchProgress } from "@/lib/dispatch";

export interface DayItem {
  id: string;
  shipment_id: string;
  removed_at?: string | null;
  removal_reason?: string | null;
  office_checked_at?: string | null;
  pickup_checked_at?: string | null;
  /** 0174: el motorizado no lo recogió de su caja. */
  pickup_declined_at?: string | null;
  pickup_declined_reason?: string | null;
  shipment?: { order_id: string | null; order_name: string | null; customer_name: string | null; district: string | null; output_code: string | null; guide_code: string | null } | null;
}

export interface DayManifest {
  id: string;
  courier: string;
  route_date: string;
  state: string;
  rider_id?: string | null;
  driver_name: string | null;
  load_number?: number;
  items: DayItem[];
}

export interface RiderBox {
  riderId: string | null;
  riderName: string;
  loads: DayManifest[];
  assigned: number;
  officeChecked: number;
  pickupChecked: number;
  declined: number;
  /** El estado de la carga más reciente: es la que se está trabajando. */
  state: string;
}

/** Las cajas de motorizados propios de un día, agrupadas por motorizado. */
export function dayBoxes(manifests: readonly DayManifest[], day: string): RiderBox[] {
  const byRider = new Map<string, RiderBox>();
  for (const m of manifests) {
    if (courierKey(m.courier) !== "propio" || m.route_date !== day || m.state === "cancelled") continue;
    const key = m.rider_id ?? `sin-ficha:${m.driver_name ?? m.id}`;
    const box = byRider.get(key) ?? {
      riderId: m.rider_id ?? null,
      riderName: m.driver_name ?? "Motorizado sin nombre",
      loads: [],
      assigned: 0,
      officeChecked: 0,
      pickupChecked: 0,
      declined: 0,
      state: m.state,
    };
    box.loads.push(m);
    const progress = dispatchProgress(m.items);
    box.assigned += progress.total;
    box.officeChecked += progress.officeChecked;
    box.pickupChecked += progress.pickupChecked;
    box.declined += m.items.filter((item) => !!item.pickup_declined_at).length;
    byRider.set(key, box);
  }
  for (const box of byRider.values()) {
    box.loads.sort((a, b) => (b.load_number ?? 1) - (a.load_number ?? 1));
    box.state = box.loads[0]?.state ?? box.state;
  }
  return [...byRider.values()].sort((a, b) => a.riderName.localeCompare(b.riderName, "es"));
}

export interface DeclinedPackage {
  manifestId: string;
  shipmentId: string;
  riderId: string | null;
  riderName: string;
  reason: string;
  orderName: string | null;
  customerName: string | null;
  district: string | null;
  orderId: string | null;
}

/** Paquetes que un motorizado no recogió de su caja hoy: los que hay que reasignar. */
export function declinedPackages(boxes: readonly RiderBox[]): DeclinedPackage[] {
  const out: DeclinedPackage[] = [];
  for (const box of boxes) {
    for (const load of box.loads) {
      for (const item of load.items) {
        if (!item.pickup_declined_at) continue;
        out.push({
          manifestId: load.id,
          shipmentId: item.shipment_id,
          riderId: box.riderId,
          riderName: box.riderName,
          reason: item.pickup_declined_reason ?? "sin motivo",
          orderName: item.shipment?.order_name ?? null,
          customerName: item.shipment?.customer_name ?? null,
          district: item.shipment?.district ?? null,
          orderId: item.shipment?.order_id ?? null,
        });
      }
    }
  }
  return out;
}

export interface AssignSplit {
  /** Pedidos disponibles: hay que tomarlos y asignarlos en una sola acción. */
  orderIds: string[];
  /** Solicitudes ya tomadas sin ruta: solo asignar. */
  requestIds: string[];
}

/**
 * Una sola selección mezcla disponibles y tomados sin ruta. Cada uno va por
 * su acción, pero para quien asigna es un solo botón.
 */
export function splitAssignment(
  selected: ReadonlySet<string>,
  available: readonly { orderId: string }[],
  accepted: readonly { orderId: string; requestId: string; route: unknown | null; shipmentId: string | null }[],
): AssignSplit {
  const availableIds = new Set(available.map((o) => o.orderId));
  const orderIds: string[] = [];
  const requestIds: string[] = [];
  for (const id of selected) {
    const taken = accepted.find((o) => o.orderId === id && !o.route && o.shipmentId);
    if (taken) requestIds.push(taken.requestId);
    else if (availableIds.has(id)) orderIds.push(id);
  }
  return { orderIds, requestIds };
}

/** Qué le falta a una caja para que el motorizado pueda salir. */
export function boxNextStep(box: Pick<RiderBox, "assigned" | "officeChecked" | "pickupChecked" | "state">): string {
  if (box.state === "in_custody") return "En poder del motorizado";
  if (!box.assigned) return "Sin paquetes";
  if (box.officeChecked < box.assigned) return `Cotejar ${box.assigned - box.officeChecked} en oficina`;
  if (box.pickupChecked < box.assigned) return `Esperando que el motorizado reciba ${box.assigned - box.pickupChecked}`;
  return "Lista";
}
