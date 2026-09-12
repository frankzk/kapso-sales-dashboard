import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/access";
import { getMyRider, getRouteDetail, getRoutes } from "@/lib/routes-access";
import { RiderRouteScreen } from "@/components/rider-route";
import { GfRiderReceipt } from "@/components/gf-rider-receipt";
import { getMyGfLoads } from "@/lib/gf-rider-loads";
import { getMasterPermissions } from "@/lib/permissions-access";
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
  const perms = await getMasterPermissions();
  if (sp.modo === "coordinacion" && perms.can("routes.report_others")) {
    return <CoordinatorReport routeId={sp.ruta} email={user.email ?? "Coordinación"} />;
  }

  const rider = await getMyRider();
  if (!rider) {
    if (perms.can("routes.report_others")) {
      return <CoordinatorReport routeId={sp.ruta} email={user.email ?? "Coordinación"} />;
    }
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900">Reparto</h1>
          <p className="mt-2 text-sm text-slate-500">
            Si eres motorizado, pide vincular tu ficha a <strong className="text-slate-700">{user.email}</strong>.
            Si eres jefe o coordinador, pide activar «Reportar entregas de rutas» en Equipo. No necesitas una ficha de motorizado.
          </p>
        </div>
      </main>
    );
  }

  // RLS solo devuelve las rutas ya entregadas al motorizado ('en_curso' o
  // 'cerrada'), así que no hay que filtrar por estado aquí.
  const [routes, loads] = await Promise.all([getRoutes({ riderId: rider.id, limit: 30 }), getMyGfLoads()]);
  const active = routes.find((r) => r.status === "en_curso");
  const wanted = sp.ruta && routes.some((r) => r.id === sp.ruta) ? sp.ruta : null;
  const routeId = wanted ?? active?.id ?? routes[0]?.id ?? null;
  const detail = routeId ? await getRouteDetail(routeId) : null;

  return (
    <><GfRiderReceipt loads={loads} /><RiderRouteScreen
      riderName={rider.full_name}
      routes={routes}
      route={detail?.route ?? null}
      stops={detail?.stops ?? []}
    /></>
  );
}
