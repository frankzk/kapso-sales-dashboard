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
  searchParams: Promise<{ view?: string }>;
}) {
  const sp = await searchParams;
  const stores = await getAccessibleStores();
  if (!stores.length) {
    return <EmptyState title="No tienes tiendas asignadas" />;
  }

  const view: ShipmentView = isShipmentView(sp.view) ? sp.view : "por_reprogramar";

  // counts + queue span ALL accessible stores (guides are a shared multitienda
  // pool); the store/city multi-select filters happen client-side in the board.
  const storeIds = stores.map((s) => s.id);
  const [counts, shipments] = await Promise.all([
    getShipmentCounts(storeIds),
    getStoreShipments(storeIds, view),
  ]);

  return (
    <ShipmentsBoard
      stores={stores}
      view={view}
      counts={counts}
      shipments={shipments}
    />
  );
}
