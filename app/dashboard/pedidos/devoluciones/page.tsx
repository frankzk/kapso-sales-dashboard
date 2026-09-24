import Link from "next/link";
import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { getReturnsReceptionData } from "@/lib/dispatch-access";
import { EmptyState } from "@/components/ui";
import { ReturnsReception } from "@/components/returns-reception";

export const dynamic = "force-dynamic";

export default async function ReturnsPage() {
  const [stores, permissions] = await Promise.all([getAccessibleStores(), getMasterPermissions()]);
  if (!stores.length) return <EmptyState title="No tienes tiendas asignadas" />;
  if (!permissions.can("warehouse.prepare")) {
    return (
      <EmptyState title="No tienes acceso al almacén">
        <Link href="/dashboard/pedidos" className="text-brand-600 underline">Volver al Master de Pedidos</Link>
      </EmptyState>
    );
  }
  const data = await getReturnsReceptionData();
  return <ReturnsReception initialData={data} />;
}
