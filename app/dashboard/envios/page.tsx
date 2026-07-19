import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import {
  getReprogramStats,
  getShipmentCounts,
  getStoreShipments,
  isShipmentView,
  type ShipmentView,
} from "@/lib/shipments-access";
import { EmptyState } from "@/components/ui";
import { ShipmentsBoard } from "@/components/shipments";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";

export const dynamic = "force-dynamic";

export default function EnviosPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <EnviosContent searchParams={searchParams} />
    </Suspense>
  );
}

async function EnviosContent({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const [sp, stores] = await Promise.all([searchParams, getAccessibleStores()]);
  if (!stores.length) {
    return <EmptyState title="No tienes tiendas asignadas" />;
  }

  const view: ShipmentView = isShipmentView(sp.view) ? sp.view : "pendiente";

  // counts + queue span ALL accessible stores (guides are a shared multitienda
  // pool); the store/province/district filters happen client-side in the board.
  const storeIds = stores.map((s) => s.id);
  const [counts, shipments, reprogram] = await Promise.all([
    getShipmentCounts(storeIds),
    getStoreShipments(storeIds, view),
    getReprogramStats(storeIds),
  ]);

  return (
    <ShipmentsBoard
      stores={stores}
      view={view}
      reprogram={reprogram}
      counts={counts}
      shipments={shipments}
    />
  );
}
