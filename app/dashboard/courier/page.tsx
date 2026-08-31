import { Suspense } from "react";
import { redirect } from "next/navigation";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { EmptyState } from "@/components/ui";
import { getAdminOrgs } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { GrupoGfCourierBoard } from "@/components/grupo-gf-courier";
import { loadCourierConfig } from "./actions";

export const dynamic = "force-dynamic";

export default function CourierPage() {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <CourierContent />
    </Suspense>
  );
}

async function CourierContent() {
  const [permissions, memberships] = await Promise.all([
    getMasterPermissions(),
    getAdminOrgs(),
  ]);
  if (!memberships.length) redirect("/login");
  if (!permissions.can("logistics.manage")) {
    return (
      <EmptyState title="Acceso restringido">
        Frankz puede habilitarte “Administrar Grupo GF Courier” desde Equipo.
      </EmptyState>
    );
  }
  const orgId = memberships[0]!.org_id;
  const snapshot = await loadCourierConfig(orgId);
  return <GrupoGfCourierBoard orgId={orgId} snapshot={snapshot} />;
}

