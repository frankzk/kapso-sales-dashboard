import { Suspense } from "react";
import { redirect } from "next/navigation";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { EmptyState } from "@/components/ui";
import { getAccessibleStores, getAdminOrgs } from "@/lib/access";
import { canOperateGroupGf } from "@/lib/permissions";
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
  // Despacho del día es de todo el equipo que despacha (11-10-2026, MOM
  // §29.10); el Tarifario sigue siendo de quien administra el courier.
  if (!canOperateGroupGf(permissions.can)) {
    // Quien solo arma rutas o coteja en la salida tiene la lista de Rutas sola.
    if (permissions.can("routes.manage") || permissions.can("dispatch.pickup")) redirect("/dashboard/courier/rutas");
    return (
      <EmptyState title="Acceso restringido">
        Pide al dueño el rol «Despacho y Grupo GF» en Equipo.
      </EmptyState>
    );
  }
  if (!memberships.length) redirect("/login");
  const orgId = memberships[0]!.org_id;
  // Quien solo despacha opera las tiendas que tiene en Equipo; sin ninguna,
  // no ve pedidos (lo mismo comprueban las acciones).
  const storeIds = permissions.can("logistics.manage")
    ? null
    : (await getAccessibleStores()).filter((store) => store.org_id === orgId).map((store) => store.id);
  if (storeIds && !storeIds.length) {
    return <EmptyState title="No tienes tiendas asignadas">Pide acceso a Kenku o Aurela en Equipo.</EmptyState>;
  }
  // Una fecha concreta en la lista de Rutas la trae el servidor (puede ser
  // anterior a las últimas 150 rutas); «hoy» y «todas» filtran en el navegador.
  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.dia ?? "") ? sp.dia! : null;
  const [snapshot, dispatch, ledger, pendingReturns] = await Promise.all([loadCourierConfig(orgId), getDispatchWorkspaceData(), getCourierRouteLedger({ day }), getPendingReturns({ storeIds }).catch(() => [])]);
  const today = limaDate(new Date().toISOString()) ?? new Date().toISOString().slice(0, 10);
  return <GrupoGfCourierBoard orgId={orgId} snapshot={snapshot} manifests={dispatch.manifests} today={today} ledger={ledger} pendingReturns={pendingReturns} />;
}

