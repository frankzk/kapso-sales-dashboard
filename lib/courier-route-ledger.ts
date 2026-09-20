// La lista de Rutas de Grupo GF Courier (MOM §29.14): una fila por ruta de
// reparto —motorizado y día— con su caja de despacho cuando la tiene.
//
// La ruta (`delivery_routes`) es la verdad (§29.12): las que trajo el cuaderno
// no tienen caja y aun así cuentan; las que nacieron en Despacho del día
// tienen su carga (`dispatch_manifests`) con cotejos y recepción. Aquí se
// juntan las dos vistas que antes vivían en pestañas distintas.

import { createServerSupabase } from "@/lib/db";
import { activeDispatchItems } from "@/lib/dispatch";
import type { DispatchManifestState } from "@/lib/dispatch";

export interface CourierLedgerRow {
  routeId: string;
  routeDate: string;
  /** `planificada` | `en_curso` | `cerrada`. */
  routeStatus: string;
  riderId: string;
  riderName: string;
  /** Caja de despacho de esa ruta, si existe. */
  manifestId: string | null;
  loadNumber: number | null;
  manifestState: DispatchManifestState | null;
  /** Paradas de la ruta, o paquetes de la caja cuando todavía no hay paradas. */
  assignedCount: number;
  armedCount: number | null;
  officeCheckedCount: number | null;
  pickupCheckedCount: number | null;
  /** Paradas ya reportadas (entregado o no). */
  reportedCount: number;
  deliveredCount: number;
  /** Suma de la venta de los pedidos de la ruta (MOM §29.9). */
  codAmount: number;
  /** `null` sin liquidación; si no, el estado de `rider_settlements`. */
  settlementStatus: string | null;
}

export type CourierLedgerSituation =
  | "borrador"
  | "cotejo_oficina"
  | "lista_para_recojo"
  | "en_poder_del_courier"
  | "en_reparto"
  | "cerrada"
  | "liquidada";

/** Un solo estado por fila, del más temprano al más tardío. */
export function ledgerSituation(row: Pick<CourierLedgerRow, "routeStatus" | "manifestState" | "settlementStatus">): CourierLedgerSituation {
  if (row.settlementStatus && row.settlementStatus !== "borrador") return "liquidada";
  if (row.routeStatus === "cerrada") return "cerrada";
  if (row.routeStatus === "en_curso") return "en_reparto";
  switch (row.manifestState) {
    case "in_custody":
      return "en_poder_del_courier";
    case "ready_for_pickup":
    case "pickup_check":
      return "lista_para_recojo";
    case "office_check":
      return "cotejo_oficina";
    default:
      return "borrador";
  }
}

export const LEDGER_SITUATION_LABELS: Record<CourierLedgerSituation, string> = {
  borrador: "Borrador",
  cotejo_oficina: "Cotejo de oficina",
  lista_para_recojo: "Lista para recojo",
  en_poder_del_courier: "En poder del courier",
  en_reparto: "En reparto",
  cerrada: "Cerrada",
  liquidada: "Liquidada",
};

interface RouteRowLite {
  id: string;
  rider_id: string;
  route_date: string;
  status: string;
  settlement_id: string | null;
}

/**
 * Rutas de reparto con su caja. Sin `day` trae las últimas `limit` (hoy
 * primero); con `day` trae solo ese día, sin tope práctico.
 */
export async function getCourierRouteLedger(opts: { day?: string | null; limit?: number } = {}): Promise<CourierLedgerRow[]> {
  const sb = await createServerSupabase();
  let query = sb.from("delivery_routes").select("id,rider_id,route_date,status,settlement_id");
  if (opts.day) query = query.eq("route_date", opts.day);
  const { data: routeRows, error } = await query
    .order("route_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(opts.day ? 500 : (opts.limit ?? 150));
  if (error) throw new Error(error.message);
  const routes = (routeRows ?? []) as RouteRowLite[];
  if (!routes.length) return [];

  const routeIds = routes.map((r) => r.id);
  const riderIds = [...new Set(routes.map((r) => r.rider_id))];
  const settlementIds = [...new Set(routes.map((r) => r.settlement_id).filter((id): id is string => Boolean(id)))];

  const [ridersRes, stopsRes, manifestsRes, settlementsRes] = await Promise.all([
    sb.from("riders").select("id,full_name").in("id", riderIds),
    // Lotes pequeños a propósito: PostgREST corta cada respuesta en 1.000
    // filas. Con 150 rutas de ~30 paradas en una sola consulta, las paradas
    // de las rutas de hoy se quedaban fuera y la fila salía con S/ 0,00.
    chunked(routeIds, 12, (ids) => sb.from("delivery_stops").select("route_id,order_id,status").in("route_id", ids)),
    chunked(routeIds, 200, (ids) =>
      sb.from("dispatch_manifests").select("id,delivery_route_id,load_number,state").eq("courier", "propio").neq("state", "cancelled").in("delivery_route_id", ids),
    ),
    settlementIds.length ? sb.from("rider_settlements").select("id,status").in("id", settlementIds) : Promise.resolve({ data: [] as { id: string; status: string }[] }),
  ]);

  const riderName = new Map(((ridersRes.data ?? []) as { id: string; full_name: string }[]).map((r) => [r.id, r.full_name]));
  const settlementStatus = new Map(((settlementsRes.data ?? []) as { id: string; status: string }[]).map((s) => [s.id, s.status]));

  const stopsByRoute = new Map<string, { order_id: string; status: string }[]>();
  for (const stop of stopsRes as { route_id: string; order_id: string; status: string }[]) {
    const list = stopsByRoute.get(stop.route_id) ?? [];
    list.push(stop);
    stopsByRoute.set(stop.route_id, list);
  }

  // Una ruta puede tener varias cargas (§29.13, «carga adicional»): la fila
  // enseña la última y suma los paquetes de todas.
  type ManifestLite = { id: string; delivery_route_id: string | null; load_number: number | null; state: DispatchManifestState };
  const manifestsByRoute = new Map<string, ManifestLite[]>();
  for (const m of manifestsRes as ManifestLite[]) {
    if (!m.delivery_route_id) continue;
    const list = manifestsByRoute.get(m.delivery_route_id) ?? [];
    list.push(m);
    manifestsByRoute.set(m.delivery_route_id, list);
  }
  const manifestIds = (manifestsRes as ManifestLite[]).map((m) => m.id);
  const items = manifestIds.length
    ? await chunked(manifestIds, 12, (ids) =>
        sb.from("dispatch_manifest_items").select("manifest_id,shipment_id,office_checked_at,pickup_checked_at,removed_at,pickup_declined_at").in("manifest_id", ids),
      )
    : [];
  type ItemLite = { manifest_id: string; shipment_id: string; office_checked_at: string | null; pickup_checked_at: string | null; removed_at: string | null; pickup_declined_at: string | null };
  const itemsByManifest = new Map<string, ItemLite[]>();
  for (const item of items as ItemLite[]) {
    const list = itemsByManifest.get(item.manifest_id) ?? [];
    list.push(item);
    itemsByManifest.set(item.manifest_id, list);
  }
  const shipmentIds = [...new Set((items as ItemLite[]).filter((i) => !i.removed_at).map((i) => i.shipment_id))];
  const armed = new Set<string>();
  if (shipmentIds.length) {
    const rows = await chunked(shipmentIds, 200, (ids) => sb.from("shipments").select("id,preparation_state").in("id", ids));
    for (const s of rows as { id: string; preparation_state: string }[]) if (s.preparation_state === "listo_despacho") armed.add(s.id);
  }

  // Efectivo previsto: la venta de los pedidos de las paradas (§29.9).
  const orderIds = [...new Set([...stopsByRoute.values()].flat().map((s) => s.order_id))];
  const total = new Map<string, number>();
  if (orderIds.length) {
    const rows = await chunked(orderIds, 200, (ids) => sb.from("order_master").select("order_id,order_total").in("order_id", ids));
    for (const o of rows as { order_id: string; order_total: number | null }[]) total.set(o.order_id, Number(o.order_total ?? 0));
  }

  const rows = routes.map((route) => {
    const stops = stopsByRoute.get(route.id) ?? [];
    const manifests = (manifestsByRoute.get(route.id) ?? []).sort((a, b) => (b.load_number ?? 0) - (a.load_number ?? 0));
    const last = manifests[0] ?? null;
    let packages = 0;
    let armedCount = 0;
    let officeChecked = 0;
    let pickupChecked = 0;
    for (const m of manifests) {
      const active = activeDispatchItems(itemsByManifest.get(m.id) ?? []) as ItemLite[];
      packages += active.length;
      armedCount += active.filter((i) => armed.has(i.shipment_id)).length;
      officeChecked += active.filter((i) => i.office_checked_at).length;
      pickupChecked += active.filter((i) => i.pickup_checked_at).length;
    }
    const reported = stops.filter((s) => s.status !== "pendiente").length;
    return {
      routeId: route.id,
      routeDate: route.route_date,
      routeStatus: route.status,
      riderId: route.rider_id,
      riderName: riderName.get(route.rider_id) ?? "Motorizado",
      manifestId: last?.id ?? null,
      loadNumber: last?.load_number ?? null,
      manifestState: last?.state ?? null,
      assignedCount: stops.length || packages,
      armedCount: last ? armedCount : null,
      officeCheckedCount: last ? officeChecked : null,
      pickupCheckedCount: last ? pickupChecked : null,
      reportedCount: reported,
      deliveredCount: stops.filter((s) => s.status === "entregado").length,
      codAmount: stops.reduce((sum, s) => sum + (total.get(s.order_id) ?? 0), 0),
      settlementStatus: route.settlement_id ? (settlementStatus.get(route.settlement_id) ?? "borrador") : null,
    };
  });
  // Una ruta abierta sin paradas ni paquetes no es una ruta: es la caja que
  // quedó vacía tras «Quitar» o «No lo llevo». Las cerradas o liquidadas se
  // conservan aunque queden en cero, porque son historia.
  return rows.filter((r) => r.assignedCount > 0 || r.routeStatus === "cerrada" || r.settlementStatus != null);
}

async function chunked<T>(ids: string[], size: number, run: (ids: string[]) => PromiseLike<{ data: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; start < ids.length; start += size) {
    const { data, error } = await (run(ids.slice(start, start + size)) as PromiseLike<{ data: unknown; error?: { message: string } | null }>);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}
