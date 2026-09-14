import { hasOrgPermission } from "@/lib/permissions-access";
import { getRoutes, getRouteDetail } from "@/lib/routes-access";
import { getRiders } from "@/lib/settlements-access";
import { RiderRouteScreen } from "@/components/rider-route";

/** No rider impersonation: selected route and organization are server checked. */
export async function CoordinatorReport({ routeId, email }: { routeId?: string; email: string }) {
  const [visible, riders] = await Promise.all([getRoutes({ limit: 60 }), getRiders()]);
  const orgIds = [...new Set(visible.map((r) => r.org_id).filter((id): id is string => Boolean(id)))];
  const allowed = new Set((await Promise.all(orgIds.map(async (id) =>
    await hasOrgPermission(id, "routes.report_others") ? id : null))).filter(Boolean));
  const routes = visible.filter((r) => r.status === "en_curso" && allowed.has(r.org_id ?? ""));
  const selected = routeId ? routes.find((r) => r.id === routeId) : routes[0];
  const detail = selected ? await getRouteDetail(selected.id) : null;
  if (!detail) return <div className="mx-auto max-w-md space-y-3 p-6">
    <h1 className="text-lg font-semibold">Reportar entregas de rutas</h1>
    <p>{routeId ? "Esta ruta no está en curso o no tienes permiso para reportarla." : "No hay rutas en curso disponibles para reportar."}</p>
    <a className="inline-flex min-h-12 items-center underline" href="/dashboard/rutas">Volver a Rutas</a>
  </div>;
  const name = (id: string) => riders.find((r) => r.id === id)?.full_name ?? "Motorizado";
  return <RiderRouteScreen key={detail.route.id} coordinator={email} riderName={name(detail.route.rider_id)} routes={routes} route={detail.route} stops={detail.stops}
    routeLabels={Object.fromEntries(routes.map((r) => [r.id, `${name(r.rider_id)} · ${r.route_date}`]))} />;
}
