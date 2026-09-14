import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { getDispatchWorkspaceData, getDispatchRiders } from "@/lib/dispatch-access";
import { DispatchWorkspace } from "@/components/dispatch-workspace";
import { EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function CourierDispatchPage({ searchParams }: { searchParams: Promise<{ manifiesto?: string }> }) {
  const [params, stores, permissions] = await Promise.all([searchParams, getAccessibleStores(), getMasterPermissions()]);
  const canManage = permissions.can("dispatch.manage");
  const canPickup = permissions.can("dispatch.pickup");
  if (!stores.length || (!canManage && !canPickup)) return <EmptyState title="No tienes permiso para cotejar cargas." />;
  const [data, riders] = await Promise.all([getDispatchWorkspaceData(params.manifiesto), getDispatchRiders()]);
  return <DispatchWorkspace initialData={data} initialSelectedId={params.manifiesto} stores={stores} riders={riders}
    canPrepare={permissions.can("warehouse.prepare")} canManage={canManage} canPickup={canPickup} surface="gf" />;
}
