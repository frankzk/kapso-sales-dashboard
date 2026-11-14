import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAccessibleStores, getUserRoleSummary } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { EmptyState } from "@/components/ui";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { ImportDetailView } from "@/components/compras/import-detail";
import { COMPRAS_VIEW_PERMISSIONS, comprasVisionCreds, loadImportDetail } from "@/lib/compras-server";
import { limaToday } from "@/lib/compras";

export const dynamic = "force-dynamic";
// «Leer con IA» (MOM §45.10) corre como acción de esta página: la lectura se
// corta a los 105 s (lib/compras-ia-vision.ts), dentro de estos 120.
export const maxDuration = 120;

export default function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <ImportContent params={params} />
    </Suspense>
  );
}

async function ImportContent({ params }: { params: Promise<{ id: string }> }) {
  const [{ isVendedoraOnly }, { id }, master] = await Promise.all([getUserRoleSummary(), params, getMasterPermissions()]);
  // La vendedora con «Recepción de compras» (rol Almacén, MOM §45.11) sí entra.
  if (isVendedoraOnly && !COMPRAS_VIEW_PERMISSIONS.some((p) => master.can(p))) redirect("/dashboard/leads");
  // `loadImportDetail` vuelve a pedir «Compras», «Montos de compras» o
  // «Recepción de compras» en la organización de la importación, y sin
  // «Montos» no lee el dinero.
  const [detail, stores] = await Promise.all([loadImportDetail(id), getAccessibleStores()]);
  if (!detail) {
    return <EmptyState title="Importación no encontrada">No existe o no tienes acceso a Compras en su organización.</EmptyState>;
  }
  // «Leer con IA» solo con «Compras» y con una clave configurada (la acción lo vuelve a pedir).
  const aiEnabled = detail.perms.canManage ? Boolean((await comprasVisionCreds(detail.imp.org_id)).apiKey) : false;
  return (
    <ImportDetailView
      aiEnabled={aiEnabled}
      detail={detail}
      stores={stores.filter((s) => s.org_id === detail.imp.org_id).map((s) => ({ id: s.id, name: s.name }))}
      today={limaToday()}
    />
  );
}
