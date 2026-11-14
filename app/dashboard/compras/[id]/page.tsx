import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAccessibleStores, getUserRoleSummary } from "@/lib/access";
import { EmptyState } from "@/components/ui";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { ImportDetailView } from "@/components/compras/import-detail";
import { loadImportDetail } from "@/lib/compras-server";
import { limaToday } from "@/lib/compras";

export const dynamic = "force-dynamic";

export default function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <ImportContent params={params} />
    </Suspense>
  );
}

async function ImportContent({ params }: { params: Promise<{ id: string }> }) {
  const [{ isVendedoraOnly }, { id }] = await Promise.all([getUserRoleSummary(), params]);
  if (isVendedoraOnly) redirect("/dashboard/leads");
  // `loadImportDetail` vuelve a pedir «Compras» o «Montos de compras» en la
  // organización de la importación, y sin «Montos» no lee el dinero.
  const [detail, stores] = await Promise.all([loadImportDetail(id), getAccessibleStores()]);
  if (!detail) {
    return <EmptyState title="Importación no encontrada">No existe o no tienes acceso a Compras en su organización.</EmptyState>;
  }
  return (
    <ImportDetailView
      detail={detail}
      stores={stores.filter((s) => s.org_id === detail.imp.org_id).map((s) => ({ id: s.id, name: s.name }))}
      today={limaToday()}
    />
  );
}
