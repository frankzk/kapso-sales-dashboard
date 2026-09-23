import { Suspense } from "react";
import { redirect } from "next/navigation";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { EmptyState } from "@/components/ui";
import { getAdminOrgs } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { GrupoGfCourierBoard } from "@/components/grupo-gf-courier";
import { loadCourierConfig } from "./actions";
import { getDispatchWorkspaceData } from "@/lib/dispatch-access";
import { getCourierRouteLedger, getPendingReturns } from "@/lib/courier-route-ledger";
import { limaDate } from "@/lib/sheets/resolver";

export const dynamic = "force-dynamic";

type SP = { tab?: string; dia?: string; caja?: string; ruta?: string; motorizado?: string };

export default function CourierPage({ searchParams }: { searchParams: Promise<SP> }) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <CourierContent searchParams={searchParams} />
    </Suspense>
  );
}

async function CourierContent({ searchParams }: { searchParams: Promise<SP> }) {
  const [sp, permissions, memberships] = await Promise.all([
    searchParams,
    getMasterPermissions(),
    getAdminOrgs(),
  ]);
  if (!permissions.can("logistics.manage")) {
    // Quien solo arma rutas, coteja o recibe tiene la lista de Rutas sola.
    if (permissions.can("routes.manage") || permissions.can("dispatch.manage") || permissions.can("dispatch.pickup")) redirect("/dashboard/courier/rutas");
    return (
      <EmptyState title="Acceso restringido">
        Frankz puede habilitarte “Administrar Grupo GF Courier” desde Equipo.
      </EmptyState>
    );
  }
  if (!memberships.length) redirect("/login");
  const orgId = memberships[0]!.org_id;
  // Una fecha concreta en la lista de Rutas la trae el servidor (puede ser
  // anterior a las últimas 150 rutas); «hoy» y «todas» filtran en el navegador.
  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.dia ?? "") ? sp.dia! : null;
  const [snapshot, dispatch, ledger, pendingReturns] = await Promise.all([loadCourierConfig(orgId), getDispatchWorkspaceData(), getCourierRouteLedger({ day }), getPendingReturns().catch(() => [])]);
  const today = limaDate(new Date().toISOString()) ?? new Date().toISOString().slice(0, 10);
  return <GrupoGfCourierBoard orgId={orgId} snapshot={snapshot} manifests={dispatch.manifests} today={today} ledger={ledger} pendingReturns={pendingReturns} />;
}

