import { getAccessibleStores } from "@/lib/access";
import { getReviewShipments } from "@/lib/shipments-access";
import { EmptyState } from "@/components/ui";
import { ImportReview } from "@/components/import-review";

export const dynamic = "force-dynamic";

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string }>;
}) {
  const sp = await searchParams;
  const stores = await getAccessibleStores();
  if (!stores.length) {
    return <EmptyState title="No tienes tiendas asignadas" />;
  }
  const fallback = stores[0]!;
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : fallback.id;
  const reviewRows = await getReviewShipments(stores.map((s) => s.id));

  return <ImportReview stores={stores} storeId={storeId} reviewRows={reviewRows} />;
}
