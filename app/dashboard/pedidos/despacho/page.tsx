import Link from "next/link";
import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { getDispatchWorkspaceData, getDispatchRiders } from "@/lib/dispatch-access";
import { EmptyState } from "@/components/ui";
import { DispatchWorkspace } from "@/components/dispatch-workspace";

export const dynamic = "force-dynamic";

export default async function DispatchPage() {
  const [stores, permissions] = await Promise.all([getAccessibleStores(), getMasterPermissions()]);
  if (!stores.length) return <EmptyState title="No tienes tiendas asignadas" />;
  const canPrepare = permissions.can("warehouse.prepare");
  const canManage = permissions.can("dispatch.manage");
  const canPickup = permissions.can("dispatch.pickup");
  if (!canPrepare && !canManage && !canPickup) {
    return (
      <EmptyState title="No tienes acceso a la mesa de despacho">
        <Link href="/dashboard/pedidos" className="text-brand-600 underline">Volver al Master de Pedidos</Link>
      </EmptyState>
    );
  }
  const [data, riders] = await Promise.all([getDispatchWorkspaceData(), getDispatchRiders()]);
  return (
    <DispatchWorkspace
      initialData={data}
      stores={stores}
      riders={riders}
      canPrepare={canPrepare}
      canManage={canManage}
      canPickup={canPickup}
    />
  );
}

