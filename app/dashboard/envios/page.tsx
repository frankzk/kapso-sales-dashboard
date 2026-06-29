import { getAccessibleStores } from "@/lib/access";
import {
  getShipmentCounts,
  getStoreShipments,
  isShipmentView,
  type ShipmentView,
} from "@/lib/shipments-access";
import { EmptyState } from "@/components/ui";
import { ShipmentsBoard } from "@/components/shipments";

export const dynamic = "force-dynamic";

export default async function EnviosPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string; view?: string }>;
}) {
  const sp = await searchParams;
  const stores = await getAccessibleStores();
  if (!stores.length) {
    return <EmptyState title="No tienes tiendas asignadas" />;
  }

  const fallback = stores[0]!;
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : fallback.id;
  const view: ShipmentView = isShipmentView(sp.view) ? sp.view : "por_reprogramar";

  // counts span all accessible stores; the queue lists every accessible store too
  // (guides are a shared multitienda pool) — store selector narrows the view.
  const storeIds = stores.map((s) => s.id);
  const [counts, shipments] = await Promise.all([
    getShipmentCounts(storeIds),
    getStoreShipments([storeId], view),
  ]);

  return (
    <ShipmentsBoard
      stores={stores}
      storeId={storeId}
      view={view}
      counts={counts}
      shipments={shipments}
    />
  );
}
