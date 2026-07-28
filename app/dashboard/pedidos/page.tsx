import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import {
  MASTER_PAGE_SIZE,
  getAgencySummary,
  getMasterFacets,
  getOrderMasterCounts,
  getOrderMasterPage,
  isMasterView,
  type MasterView,
} from "@/lib/orders-master-access";
import { parseMasterQuery } from "@/lib/master-query";
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
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [sp, stores, perms] = await Promise.all([
    searchParams,
    getAccessibleStores(),
    getMasterPermissions(),
  ]);
  if (!stores.length) {
    return <EmptyState title="No tienes tiendas asignadas" />;
  }

  // Los filtros viven en la URL para que el SERVIDOR pueda aplicarlos. Antes se
  // bajaban las ~10.000 filas al navegador y se filtraban allí: 13 MB por carga
  // y unos diez segundos mirando el esqueleto antes de ver nada.
  const flat: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(sp)) flat[k] = Array.isArray(v) ? v[0] : v;
  const { filters, sortKey, page } = parseMasterQuery(flat);

  const view: MasterView = isMasterView(flat.view) ? flat.view : "todos";

  // El Master es consolidado: se consultan TODAS las tiendas accesibles, y el
  // filtro por tienda es uno más, aplicado también en la base.
  const storeIds = stores.map((s) => s.id);
  const [counts, pageData, facets, agency] = await Promise.all([
    getOrderMasterCounts(storeIds),
    getOrderMasterPage(storeIds, { view, filters, sortKey, page }),
    getMasterFacets(storeIds),
    getAgencySummary(storeIds),
  ]);

  return (
    <OrdersMasterBoard
      stores={stores}
      view={view}
      counts={counts}
      rows={pageData.rows}
      total={pageData.total}
      page={pageData.page}
      pageSize={pageData.pageSize || MASTER_PAGE_SIZE}
      filters={filters}
      sortKey={sortKey}
      facets={facets}
      agency={agency}
      canEdit={!perms.readOnly}
      canOverride={perms.can("master.override_status")}
      canCreateGuide={perms.can("aliclik.create_guide")}
      canCreateTandersGuide={perms.can("tanders.create_guide")}
      canCreateShalomGuide={perms.can("shalom.create_guide")}
    />
  );
}
