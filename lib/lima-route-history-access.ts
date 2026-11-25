import type { createAdminSupabase } from "@/lib/db";
import { allCourierRows, COURIER_ROWS_WIDE_BATCH, courierRowsByIds } from "@/lib/courier-flow";
import { compareDispatchCodes } from "@/lib/dispatched-with";

type Admin = ReturnType<typeof createAdminSupabase>;
type Read<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
export interface LimaReportedRoute { status: string | null; day: string | null; rider: string | null }

/** Solo visitas reportadas y todas identificadas. Asignar o preparar no prueba salida. */
export function limaHistoryFromReportedRoutes(stops: readonly LimaReportedRoute[]): string[] | null {
  if (!stops.length || stops.some((s) => !["entregado", "no_entregado"].includes(s.status ?? "")
    || !/^\d{4}-\d{2}-\d{2}$/.test(s.day ?? "") || !s.rider?.trim())) return null;
  return [...new Set(stops.map((s) => `gf:${s.rider!.trim()}`))].sort(compareDispatchCodes);
}

/** El llamador limita a historial vacío y salidas exclusivamente propias. Lecturas paginadas por lote (por eso el lote puede ser ancho). */
export async function loadLimaReportedHistory(admin: Admin, orderIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!orderIds.length) return result;
  type Stop = { id: string; order_id: string; route_id: string | null; status: string | null };
  const { data: stops } = await courierRowsByIds<Stop>(orderIds, (ids) => allCourierRows<Stop>((from, to) => admin.from("delivery_stops")
    .select("id,order_id,route_id,status").in("order_id", ids).in("status", ["entregado", "no_entregado"])
    .order("id").range(from, to) as unknown as Read<Stop>).then((data) => ({ data, error: null })), COURIER_ROWS_WIDE_BATCH);
  const routeIds = [...new Set(stops.flatMap((s) => s.route_id ? [s.route_id] : []))];
  type Route = { id: string; route_date: string | null; rider_id: string | null };
  const { data: routes } = await courierRowsByIds<Route>(routeIds, (ids) => allCourierRows<Route>((from, to) => admin.from("delivery_routes")
    .select("id,route_date,rider_id").in("id", ids).order("id").range(from, to) as unknown as Read<Route>).then((data) => ({ data, error: null })), COURIER_ROWS_WIDE_BATCH);
  const riderIds = [...new Set(routes.flatMap((r) => r.rider_id ? [r.rider_id] : []))];
  type Rider = { id: string; full_name: string | null };
  const { data: riders } = await courierRowsByIds<Rider>(riderIds, (ids) => allCourierRows<Rider>((from, to) => admin.from("riders")
    .select("id,full_name").in("id", ids).order("id").range(from, to) as unknown as Read<Rider>).then((data) => ({ data, error: null })), COURIER_ROWS_WIDE_BATCH);
  const routeById = new Map(routes.map((r) => [r.id, r]));
  const riderById = new Map(riders.map((r) => [r.id, r.full_name]));
  const byOrder = new Map<string, LimaReportedRoute[]>();
  for (const stop of stops) {
    const route = stop.route_id ? routeById.get(stop.route_id) : undefined;
    const proof = { status: stop.status, day: route?.route_date?.slice(0, 10) ?? null,
      rider: route?.rider_id ? riderById.get(route.rider_id) ?? null : null };
    byOrder.set(stop.order_id, [...(byOrder.get(stop.order_id) ?? []), proof]);
  }
  for (const [id, proof] of byOrder) {
    const codes = limaHistoryFromReportedRoutes(proof);
    if (codes) result.set(id, codes);
  }
  return result;
}
