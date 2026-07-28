import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import {
  getOrderMasterCounts,
  getOrderMasterRows,
  isMasterView,
  type MasterView,
} from "@/lib/orders-master-access";
import { EmptyState } from "@/components/ui";
import { OrdersMasterBoard } from "@/components/orders-master";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";

export const dynamic = "force-dynamic";

/**
 * Las server actions de esta ruta incluyen `connectShalomSession`, que hace un
 * login real contra pro.shalom.pe a través del wrapper y tarda hasta 2 minutos
 * la primera vez de cada cuenta. Con el límite por defecto se cortaría sola.
 */
export const maxDuration = 300;

export default function PedidosPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <PedidosContent searchParams={searchParams} />
    </Suspense>
  );
}

async function PedidosContent({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const [sp, stores, perms] = await Promise.all([
    searchParams,
    getAccessibleStores(),
    getMasterPermissions(),
  ]);
  if (!stores.length) {
    return <EmptyState title="No tienes tiendas asignadas" />;
  }

  const view: MasterView = isMasterView(sp.view) ? sp.view : "todos";

  // El Master es consolidado: se cargan TODAS las tiendas accesibles y el filtro
  // por tienda vive en el board, donde se combina con el resto de filtros.
  const storeIds = stores.map((s) => s.id);
  const [counts, rows] = await Promise.all([
    getOrderMasterCounts(storeIds),
    getOrderMasterRows(storeIds, view),
  ]);

  return (
    <OrdersMasterBoard
      stores={stores}
      view={view}
      counts={counts}
      rows={rows}
      canEdit={!perms.readOnly}
      canOverride={perms.can("master.override_status")}
      canCreateGuide={perms.can("aliclik.create_guide")}
      canCreateTandersGuide={perms.can("tanders.create_guide")}
      canCreateShalomGuide={perms.can("shalom.create_guide")}
    />
  );
}
