import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/access";
import { getMyRider, getRouteDetail, getRoutes } from "@/lib/routes-access";
import { RiderRouteScreen } from "@/components/rider-route";
import { RiderReceiveBox } from "@/components/rider-receive-box";
import { getMyGfLoads, getMyPickupMode } from "@/lib/gf-rider-loads";
import { riderScreenFor } from "@/lib/grupo-gf-courier";
import { getMasterPermissions } from "@/lib/permissions-access";
import { getRiderSheet, loadRiderVocabulary } from "@/lib/sheets/rider-access";
import { limaDate } from "@/lib/sheets/resolver";
import { CoordinatorReport } from "./coordinacion";

export const dynamic = "force-dynamic";

/**
 * La pantalla del motorizado. Vive FUERA de /dashboard a propósito: no comparte
 * el layout del panel, no tiene barra lateral ni pestañas, y está pensada para
 * un teléfono con una mano y mala señal.
 *
 * No hace falta comprobar el rol para dejar entrar: lo que se ve sale de RLS.
 * Un administrador que abra /reparto y no sea motorizado simplemente no tiene
 * ficha, y se le dice.
 */
export default async function RepartoPage({
  searchParams,
}: {
  searchParams: Promise<{ ruta?: string; modo?: string }>;
}) {
  const [sp, user] = await Promise.all([searchParams, getCurrentUser()]);
  if (!user) redirect("/login");
  // Cada ida y vuelta la espera el motorizado con datos móviles: lo que no
  // depende de otra respuesta sale a la vez (30-09-2026).
  const [perms, rider] = await Promise.all([getMasterPermissions(), getMyRider()]);
  if (sp.modo === "coordinacion" && perms.can("routes.report_others")) {
    return <CoordinatorReport routeId={sp.ruta} email={user.email ?? "Coordinación"} />;
  }

  if (!rider) {
    if (perms.can("routes.report_others")) {
      return <CoordinatorReport routeId={sp.ruta} email={user.email ?? "Coordinación"} />;
    }
    return (
      <main className="rider-scale mx-auto flex min-h-screen max-w-md flex-col justify-center bg-slate-50 p-4">
        <div className="rounded-lg bg-white p-6 text-center shadow-control ring-1 ring-inset ring-line">
          <h1 className="text-lg font-semibold text-ink-900">Reparto</h1>
          <p className="mt-2 text-sm text-ink-600">
            Si eres motorizado, pide vincular tu ficha a <strong className="font-semibold text-ink-900">{user.email}</strong>.
            Si eres jefe o coordinador, pide activar «Reportar entregas de rutas» en Equipo. No necesitas una ficha de motorizado.
          </p>
        </div>
      </main>
    );
  }

  // RLS solo devuelve las rutas ya entregadas al motorizado ('en_curso' o
  // 'cerrada'), así que no hay que filtrar por estado aquí.
  // Una sola pantalla (MOM §29.12): la ruta es la verdad y el vocabulario de
  // su hoja de Reparto propio viaja con ella para escribir como en el cuaderno.
  const [routes, loads, sheet, pickupMode] = await Promise.all([getRoutes({ riderId: rider.id, limit: 30 }), getMyGfLoads(), getRiderSheet(rider.id), getMyPickupMode()]);
  const active = routes.find((r) => r.status === "en_curso");
  const wanted = sp.ruta && routes.some((r) => r.id === sp.ruta) ? sp.ruta : null;
  const routeId = wanted ?? active?.id ?? routes[0]?.id ?? null;
  const [vocabulary, detail] = await Promise.all([sheet ? loadRiderVocabulary(sheet) : null, routeId ? getRouteDetail(routeId) : null]);
  const today = limaDate(new Date().toISOString()) ?? new Date().toISOString().slice(0, 10);

  // La recepción bloquea la ruta de hoy, no los reportes de días anteriores.
  // Solo una selección explícita, visible para este motorizado y leída con
  // RLS permite entrar al historial; un id ajeno o inválido no evita la caja.
  // En modo «confirmar» (0185) la ruta aparece al asignar y cada parada nace
  // «por confirmar»: el motorizado dice «Lo llevo» al sacarla del almacén.
  const receptionPending = riderScreenFor(pickupMode, loads.map((load) => load.state)) === "recibir_caja";
  const selectedPastRoute = !!wanted && !!detail && detail.route.route_date < today;
  if (receptionPending && !selectedPastRoute) {
    return <RiderReceiveBox
      riderName={rider.full_name}
      loads={loads}
      previousRoutes={routes.filter((r) => r.route_date < today).map(({ id, route_date, status }) => ({ id, route_date, status }))}
    />;
  }
  return (
    <><RiderRouteScreen
      riderName={rider.full_name}
      routes={routes}
      route={detail?.route ?? null}
      stops={detail?.stops ?? []}
      vocabulary={vocabulary}
      today={today}
      pickupMode={pickupMode}
      receptionPending={receptionPending}
    /></>
  );
}
