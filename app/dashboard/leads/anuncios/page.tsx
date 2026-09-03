import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { getAdsParaAsignar, getHandlesConocidos } from "@/lib/ad-products-access";
import { EmptyState } from "@/components/ui";
import { AdProductsBoard } from "@/components/ad-products";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";

export const dynamic = "force-dynamic";

export default function AnunciosPage() {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <AnunciosContent />
    </Suspense>
  );
}

async function AnunciosContent() {
  const [stores, perms] = await Promise.all([getAccessibleStores(), getMasterPermissions()]);
  if (!stores.length) return <EmptyState title="No tienes tiendas asignadas" />;

  const storeIds = stores.map((s) => s.id);
  const [ads, handles] = await Promise.all([
    getAdsParaAsignar(storeIds),
    getHandlesConocidos(storeIds),
  ]);
  return (
    <AdProductsBoard
      ads={ads}
      handles={handles}
      stores={stores.map((s) => ({ id: s.id, name: s.name }))}
      canEdit={perms.can("leads.map_ads")}
    />
  );
}
