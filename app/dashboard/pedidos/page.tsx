import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import {
  getOrderMasterAgencySummary,
  getOrderMasterMomCounts,
  getOrderMasterRows,
  isMasterView,
  MASTER_PAGE_SIZE,
  type MasterView,
} from "@/lib/orders-master-access";
import { MACRO_SUBSTAGES_BY_STAGE, type MacroSubstage } from "@/lib/order-macro-stage";
import { EmptyState } from "@/components/ui";
import { OrdersMasterBoard } from "@/components/orders-master";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";

export const dynamic = "force-dynamic";

export default function PedidosPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; substage?: string; page?: string }>;
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
  searchParams: Promise<{ view?: string; substage?: string; page?: string }>;
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
  const substage: MacroSubstage | null =
    view !== "todos" &&
    !!sp.substage &&
    MACRO_SUBSTAGES_BY_STAGE[view].includes(sp.substage as MacroSubstage)
      ? (sp.substage as MacroSubstage)
      : null;
  const requestedPage = Number.parseInt(sp.page ?? "1", 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  // El Master es consolidado, pero solo entrega una página pequeña al navegador.
  // Los totales del MOM y de agencia se calculan aparte sin transferir las filas.
  const storeIds = stores.map((s) => s.id);
  const [momCounts, agencySummary, rows] = await Promise.all([
    getOrderMasterMomCounts(storeIds),
    getOrderMasterAgencySummary(storeIds),
    getOrderMasterRows(storeIds, view, {
      limit: MASTER_PAGE_SIZE,
      offset: (page - 1) * MASTER_PAGE_SIZE,
      substage,
    }),
  ]);

  return (
    <OrdersMasterBoard
      stores={stores}
      view={view}
      substage={substage}
      page={page}
      pageSize={MASTER_PAGE_SIZE}
      counts={momCounts.stages}
      substageCounts={momCounts.substages}
      agency={agencySummary}
      rows={rows}
      canEdit={!perms.readOnly}
      canOverride={perms.can("master.override_status")}
      canCreateGuide={perms.can("aliclik.create_guide")}
      canCreateTandersGuide={perms.can("tanders.create_guide")}
      canDispatch={perms.can("warehouse.prepare") || perms.can("dispatch.manage") || perms.can("dispatch.pickup")}
    />
  );
}
