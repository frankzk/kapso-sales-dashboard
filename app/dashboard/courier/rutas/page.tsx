import Link from "next/link";
import { redirect } from "next/navigation";
import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { getDispatchRiders } from "@/lib/dispatch-access";
import { getCourierRouteLedger } from "@/lib/courier-route-ledger";
import { legacyManifestHref, ROUTES_TAB_HREF } from "@/lib/courier-box-href";
import { limaDate } from "@/lib/sheets/resolver";
import { EmptyState } from "@/components/ui";
import { CourierRoutesLedger } from "@/components/courier-routes-ledger";
import { CourierBoxDrawer } from "@/components/courier-box-drawer";
import { CourierRouteReportDrawer } from "@/components/courier-route-report-drawer";

export const dynamic = "force-dynamic";

type SP = { manifiesto?: string; dia?: string; caja?: string; ruta?: string; reparto?: string; motorizado?: string };

/**
 * Rutas de Grupo GF Courier para quien no administra el courier (cotejo,
 * recepción, coordinación de rutas): la misma lista y el mismo panel que la
 * pestaña Rutas (MOM §29.14). Quien sí administra va a la pestaña. Los
 * enlaces antiguos `?manifiesto=` abren esa caja.
 */
export default async function CourierDispatchPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [params, stores, permissions] = await Promise.all([searchParams, getAccessibleStores(), getMasterPermissions()]);
  if (permissions.can("logistics.manage")) redirect(legacyManifestHref(params.manifiesto ?? params.caja, ROUTES_TAB_HREF));
  if (params.manifiesto) redirect(legacyManifestHref(params.manifiesto, "/dashboard/courier/rutas"));
  const canManage = permissions.can("dispatch.manage");
  const canPickup = permissions.can("dispatch.pickup");
  if (!stores.length || (!canManage && !canPickup && !permissions.can("routes.manage"))) return <EmptyState title="No tienes permiso para ver las rutas." />;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.dia ?? "") ? params.dia! : null;
  const [rows, riders] = await Promise.all([getCourierRouteLedger({ day }), getDispatchRiders()]);
  const today = limaDate(new Date().toISOString()) ?? new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-4">
      <header>
        <Link href="/dashboard/courier" className="text-xs font-medium text-slate-500 hover:text-slate-900">Grupo GF Courier</Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-950">Rutas</h1>
      </header>
      <CourierRoutesLedger rows={rows} riders={riders.map((r) => ({ id: r.id, fullName: r.full_name }))} today={today} />
      <CourierBoxDrawer />
      <CourierRouteReportDrawer />
    </div>
  );
}
