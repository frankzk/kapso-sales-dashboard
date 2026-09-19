import { Suspense } from "react";
import { redirect } from "next/navigation";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { EmptyState } from "@/components/ui";
import { getAdminOrgs } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { GrupoGfCourierBoard } from "@/components/grupo-gf-courier";
import { loadCourierConfig } from "./actions";
import { getDispatchWorkspaceData } from "@/lib/dispatch-access";
import { limaDate } from "@/lib/sheets/resolver";

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
  if (!permissions.can("logistics.manage")) {
    if (permissions.can("routes.manage")) redirect("/dashboard/courier/reparto");
    if (permissions.can("dispatch.manage") || permissions.can("dispatch.pickup")) redirect("/dashboard/courier/rutas");
    return (
      <EmptyState title="Acceso restringido">
        Frankz puede habilitarte “Administrar Grupo GF Courier” desde Equipo.
      </EmptyState>
    );
  }
  if (!memberships.length) redirect("/login");
  const orgId = memberships[0]!.org_id;
  const [snapshot, dispatch] = await Promise.all([loadCourierConfig(orgId), getDispatchWorkspaceData()]);
  const today = limaDate(new Date().toISOString()) ?? new Date().toISOString().slice(0, 10);
  return <GrupoGfCourierBoard orgId={orgId} snapshot={snapshot} manifests={dispatch.manifests} today={today} />;
}

