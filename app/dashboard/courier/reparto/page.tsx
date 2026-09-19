import { redirect } from "next/navigation";
import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { legacyReportHref, ROUTES_TAB_HREF } from "@/lib/courier-box-href";
import { EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Enlaces antiguos a «Reparto y liquidación» (`?id=<ruta>`): el reparto y el
 * cierre de una ruta viven ahora en el panel lateral de la lista de Rutas
 * (MOM §29.14, `?reparto=<ruta>`). Aquí solo queda el control de permisos y
 * la redirección; sin `id`, la lista.
 */
export default async function RutasPage({ searchParams }: { searchParams: Promise<{ id?: string; dia?: string }> }) {
  const [sp, stores, perms] = await Promise.all([searchParams, getAccessibleStores(), getMasterPermissions()]);
  if (!stores.length) return <EmptyState title="No tienes tiendas asignadas" />;
  if (!perms.can("routes.manage")) {
    if (perms.can("routes.report_others")) redirect("/reparto");
    return <EmptyState title="Tu rol no permite armar rutas" />;
  }
  if (!sp.id) redirect("/dashboard/courier/rutas");
  redirect(legacyReportHref(sp.id, perms.can("logistics.manage") ? ROUTES_TAB_HREF : "/dashboard/courier/rutas"));
}
