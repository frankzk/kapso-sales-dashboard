"use server";

// «No se entregó» desde Repro Lima (owner, 15-11-2026; MOM §9.5, cuarta
// vuelta): en «Sin reporte de la ruta», cuando la clienta confirma que no lo
// recibió, el equipo registra el no entregado por el motorizado de Grupo GF.
// Aquí solo se busca la parada abierta del pedido: el reporte lo escribe
// `reportStop` (app/reparto/actions.ts), el mismo camino de Coordinación, con
// sus guardas (ruta en curso, `routes.report_others`, el motivo del catálogo y
// la captura obligatoria, owner 15-11-2026: «captura obligatoria, como hoy»).
// Con la parada reportada, el Master lo pasa a «Por reprogramar Lima» como
// cualquier no entregado del motorizado (v1.14). Las guías de otros couriers
// no tienen parada en Kapta: su resultado lo reporta el courier.
import { createAdminSupabase } from "@/lib/db";
import { requireReproLima, REPRO_NO_PERMISSION, REPRO_OUTSIDE_STORE } from "@/lib/repro-lima-access";
import { routeReportAccess } from "@/lib/route-report-access";

export type NoEntregoStop = { stopId: string; riderName: string; routeDate: string | null } | { error: string };

const NO_ENTREGO_NO_STOP =
  "Este pedido no tiene una parada abierta de Grupo GF en una ruta en curso, o tu rol no permite reportar por el motorizado (pide «Reportar por otros» en Equipo).";

/** La parada abierta del pedido en una ruta en curso que quien pide puede reportar por el motorizado. */
export async function loadNoEntregoStop(orderId: string): Promise<NoEntregoStop> {
  const scope = await requireReproLima();
  if ("error" in scope) return { error: scope.error };
  if (scope.retriesOnly) return { error: REPRO_NO_PERMISSION };
  const admin = createAdminSupabase();
  const { data: order, error: orderError } = await admin.from("order_master").select("store_id").eq("order_id", orderId).maybeSingle();
  if (orderError) return { error: `No pudimos leer el pedido: ${orderError.message}` };
  const storeId = (order as { store_id?: string | null } | null)?.store_id;
  if (!storeId || !scope.storeIds.has(storeId)) return { error: REPRO_OUTSIDE_STORE };
  const { data: stops, error } = await admin
    .from("delivery_stops")
    .select("id,route_id,status,created_at")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) return { error: `No pudimos leer la parada: ${error.message}` };
  for (const stop of (stops ?? []) as { id: string; route_id: string; status: string }[]) {
    if (stop.status !== "pendiente") continue;
    // La misma llave que /reparto: ruta en curso y permiso para esa ruta.
    const access = await routeReportAccess(stop.route_id);
    if (!access) continue;
    const { data: route } = await admin.from("delivery_routes").select("route_date").eq("id", stop.route_id).maybeSingle();
    return { stopId: stop.id, riderName: access.riderName, routeDate: (route as { route_date?: string | null } | null)?.route_date ?? null };
  }
  return { error: NO_ENTREGO_NO_STOP };
}
