import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import {
  getAssignableOrders,
  getRetryCandidates,
  getRouteDetail,
  getRoutes,
} from "@/lib/routes-access";
import { assessRisk, sortByAttention } from "@/lib/retries";
import { getRiders } from "@/lib/settlements-access";
import { EmptyState } from "@/components/ui";
import { RoutesBoard } from "@/components/routes";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { redirect } from "next/navigation";
import { routeReportAccess } from "@/lib/route-report-access";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default function RutasPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; dia?: string }>;
}) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <RutasContent searchParams={searchParams} />
    </Suspense>
  );
}

async function RutasContent({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; dia?: string }>;
}) {
  const [sp, stores, perms] = await Promise.all([
    searchParams,
    getAccessibleStores(),
    getMasterPermissions(),
  ]);
  if (!stores.length) return <EmptyState title="No tienes tiendas asignadas" />;
  if (!perms.can("routes.manage")) {
    if (perms.can("routes.report_others")) redirect("/reparto");
    return <EmptyState title="Tu rol no permite armar rutas" />;
  }
  // La lista de rutas vive en la pestaña Rutas de Grupo GF Courier (MOM
  // §29.14); aquí queda solo el reparto y el cierre de UNA ruta.
  if (!sp.id) redirect("/dashboard/courier/rutas");

  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.dia ?? "")
    ? sp.dia!
    : new Date().toISOString().slice(0, 10);
  const storeIds = stores.map((s) => s.id);

  const [routes, riders] = await Promise.all([getRoutes({ limit: 60 }), getRiders()]);

  const openId = sp.id && routes.some((r) => r.id === sp.id) ? sp.id : null;
  // Los pedidos asignables solo se consultan al abrir una ruta: es la consulta
  // más cara de la pantalla y en el listado no se usa.
  const [detail, assignable, retryRaw] = openId
    ? await Promise.all([
        getRouteDetail(openId),
        getAssignableOrders(storeIds, day),
        getRetryCandidates(storeIds),
      ])
    : [null, [], []];

  // El riesgo se evalúa en el servidor (puro y probado) y baja ya calculado:
  // así la pantalla solo pinta, y la regla vive en un solo sitio.
  const retries = sortByAttention(
    retryRaw.map((c) => ({ ...c, risk: assessRisk(c) })),
  );

  if (!openId) redirect("/dashboard/courier/rutas");
  return (
    <div className="space-y-5">
    <header>
      <Link href={`/dashboard/courier?tab=routes&ruta=${encodeURIComponent(openId)}`} className="text-xs font-medium text-slate-500 hover:text-slate-900">← Grupo GF Courier · Rutas</Link>
      <h1 className="mt-1 text-xl font-semibold text-slate-950">Reparto y liquidación</h1>
    </header>
    <RoutesBoard
      detailOnly
      stores={stores}
      riders={riders}
      routes={routes}
      detail={detail}
      assignable={assignable}
      retries={retries}
      day={day}
      canReport={detail ? Boolean(await routeReportAccess(detail.route.id)) : false}
    />
    </div>
  );
}
