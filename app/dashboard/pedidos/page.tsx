import { Suspense } from "react";
import { getAccessibleStores, getAdminOrgs } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { DEFAULT_CONFIRMATION_CYCLE_DAYS } from "@/lib/order-confirmation";
import {
  MASTER_PAGE_SIZE,
  getAgencySummaryCached,
  getConfirmationCycleDays,
  getConfirmationDueCounts,
  getMasterFacetsCached,
  getOrderMasterMomCounts,
  getOrderMasterPage,
  isMasterView,
  type MasterView,
} from "@/lib/orders-master-access";
import { parseMasterQuery } from "@/lib/master-query";
import { MACRO_SUBSTAGES_BY_STAGE, type MacroSubstage } from "@/lib/order-macro-stage";
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
  const [sp, stores, perms, adminOrgs] = await Promise.all([
    searchParams,
    getAccessibleStores(),
    getMasterPermissions(),
    getAdminOrgs(),
  ]);
  if (!stores.length) {
    return <EmptyState title="No tienes tiendas asignadas" />;
  }

  // Los filtros viven en la URL para que el SERVIDOR pueda aplicarlos. Antes se
  // bajaban las ~10.000 filas al navegador y se filtraban allí: 13 MB por carga
  // y unos diez segundos mirando el esqueleto antes de ver nada.
  const flat: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(sp)) flat[k] = Array.isArray(v) ? v[0] : v;
  const { filters, page } = parseMasterQuery(flat);

  const view: MasterView = isMasterView(flat.view) ? flat.view : "todos";
  const substage: MacroSubstage | null =
    view !== "todos" &&
    !!flat.substage &&
    MACRO_SUBSTAGES_BY_STAGE[view].includes(flat.substage as MacroSubstage)
      ? (flat.substage as MacroSubstage)
      : null;

  // El Master es consolidado: se consultan TODAS las tiendas accesibles, y el
  // filtro por tienda es uno más, aplicado también en la base.
  const storeIds = stores.map((s) => s.id);
  const showConfirmationDue =
    view === "por_confirmar" && (substage === null || substage === "volver_a_contactar");
  // El ciclo de recontacto se muestra junto a los chips de «Fecha pactada», así
  // que solo hace falta en esa vista.
  const showConfirmation = view === "por_confirmar";
  const [momCounts, pageData, facets, agency, confirmationDueCounts, cycleDays] = await Promise.all([
    getOrderMasterMomCounts(storeIds),
    getOrderMasterPage(storeIds, { view, substage, filters, sortKey: "created", page }),
    // Cacheadas: no dependen de lo que se esté filtrando ni buscando.
    getMasterFacetsCached(storeIds),
    getAgencySummaryCached(storeIds),
    showConfirmationDue
      ? getConfirmationDueCounts(storeIds, { substage, filters })
      : Promise.resolve({ all: 0, vencido: 0, hoy: 0, proximo: 0 }),
    showConfirmation
      ? getConfirmationCycleDays(storeIds)
      : Promise.resolve({} as Record<string, number>),
  ]);

  // Owner o admin de la organización de la tienda: el ciclo reparte la carga de
  // todo el equipo, así que se ve siempre pero solo lo mueve quien manda ahí.
  const adminOrgIds = new Set(
    adminOrgs.filter((o) => o.role === "owner" || o.role === "admin").map((o) => o.org_id),
  );
  const confirmationCycles = showConfirmation
    ? stores.map((s) => ({
        storeId: s.id,
        storeName: s.name,
        days: cycleDays[s.id] ?? DEFAULT_CONFIRMATION_CYCLE_DAYS,
        canEdit: adminOrgIds.has(s.org_id),
      }))
    : [];

  return (
    <OrdersMasterBoard
      stores={stores}
      view={view}
      substage={substage}
      counts={momCounts.stages}
      substageCounts={momCounts.substages}
      confirmationDueCounts={confirmationDueCounts}
      confirmationCycles={confirmationCycles}
      rows={pageData.rows}
      total={pageData.total}
      page={pageData.page}
      pageSize={pageData.pageSize || MASTER_PAGE_SIZE}
      filters={filters}
      sortKey="created"
      facets={facets}
      agency={agency}
      canEdit={!perms.readOnly}
      canOverride={perms.can("master.override_status")}
      canCreateGuide={perms.can("aliclik.create_guide")}
      canCreateTandersGuide={perms.can("tanders.create_guide")}
      canCreateShalomGuide={perms.can("shalom.create_guide")}
      canDispatch={perms.can("dispatch.manage") || perms.can("dispatch.pickup")}
      canWarehouse={perms.can("warehouse.prepare")}
      closurePermissions={{
        canReturn: perms.can("closure.return"),
        canInventory: perms.can("closure.inventory"),
        canFinance: perms.can("closure.finance"),
        canFinalize: perms.can("closure.finalize"),
        canRefund: perms.can("closure.refund"),
        canReopen: perms.can("master.override_status") && perms.can("closure.finalize"),
      }}
    />
  );
}
