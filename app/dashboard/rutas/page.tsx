import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { getAssignableOrders, getRouteDetail, getRoutes } from "@/lib/routes-access";
import { getRiders } from "@/lib/settlements-access";
import { EmptyState } from "@/components/ui";
import { RoutesBoard } from "@/components/routes";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";

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
    return <EmptyState title="Tu rol no permite armar rutas" />;
  }

  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.dia ?? "")
    ? sp.dia!
    : new Date().toISOString().slice(0, 10);
  const storeIds = stores.map((s) => s.id);

  const [routes, riders] = await Promise.all([getRoutes({ limit: 60 }), getRiders()]);

  const openId = sp.id && routes.some((r) => r.id === sp.id) ? sp.id : null;
  // Los pedidos asignables solo se consultan al abrir una ruta: es la consulta
  // más cara de la pantalla y en el listado no se usa.
  const [detail, assignable] = openId
    ? await Promise.all([getRouteDetail(openId), getAssignableOrders(storeIds, day)])
    : [null, []];

  return (
    <RoutesBoard
      stores={stores}
      riders={riders}
      routes={routes}
      detail={detail}
      assignable={assignable}
      day={day}
    />
  );
}
