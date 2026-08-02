import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAccessibleStores, getAdminOrgs, getUserRoleSummary } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { EmptyState } from "@/components/ui";
import { CostsBoard } from "@/components/costs";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { loadCosts, loadShopifyProducts } from "./actions";

export const dynamic = "force-dynamic";

export default function CostosPage() {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <CostosContent />
    </Suspense>
  );
}

async function CostosContent() {
  const [{ isVendedoraOnly }, orgs, stores, perms] = await Promise.all([
    getUserRoleSummary(),
    getAdminOrgs(),
    getAccessibleStores(),
    getMasterPermissions(),
  ]);
  if (isVendedoraOnly) redirect("/dashboard/leads");

  const adminOrg = orgs.find((m) => m.role === "owner" || m.role === "admin");
  if (!adminOrg) {
    return (
      <EmptyState title="Sección de administradores">
        La configuración de costos la gestionan los administradores de la organización.
      </EmptyState>
    );
  }

  const [costs, products] = await Promise.all([
    loadCosts(adminOrg.org_id),
    loadShopifyProducts(adminOrg.org_id),
  ]);

  return (
    <CostsBoard
      orgId={adminOrg.org_id}
      stores={stores}
      costs={costs}
      products={products}
      canEdit={perms.can("costs.manage")}
    />
  );
}
