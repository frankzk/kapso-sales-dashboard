import { Suspense } from "react";
import { createServerSupabase } from "@/lib/db";
import { getAccessibleStores } from "@/lib/access";
import {
  getReprogramStats,
  getShipmentCounts,
  getStoreShipments,
  isShipmentView,
  type ShipmentView,
} from "@/lib/shipments-access";
import { normalizeCity } from "@/lib/shipments";
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
  // pool); the store/city multi-select filters happen client-side in the board.
  const storeIds = stores.map((s) => s.id);
  const sb = await createServerSupabase();
  const [counts, shipments, stock, reprogram] = await Promise.all([
    getShipmentCounts(storeIds),
    getStoreShipments(storeIds, view),
    sb.from("fenix_stock").select("city,quantity").gt("quantity", 0),
    getReprogramStats(storeIds),
  ]);

  // Provinces where Fenix currently has stock — the province filter defaults to
  // these (normalized coverage keys).
  const fenixStockCities = Array.from(
    new Set(((stock.data as { city: string }[]) ?? []).map((r) => normalizeCity(r.city))),
  );

  return (
    <ShipmentsBoard
      stores={stores}
      view={view}
      reprogram={reprogram}
      counts={counts}
      shipments={shipments}
      fenixStockCities={fenixStockCities}
    />
  );
}
