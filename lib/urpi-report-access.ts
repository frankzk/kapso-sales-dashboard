import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { hasOrgPermission } from "@/lib/permissions-access";

/** El reporte de Urpi es de la organización (Kenku y Aurela comparten libro).
 * Importar y vincular exige `sheets.edit`; marcar entregados, `master.edit`.
 * El vínculo busca en TODAS las tiendas de la organización: si buscara solo en
 * las que ve quien importa, una carga parcial desvincularía las demás. */
export async function requireUrpiReportOrg(orgId: string, permission: "sheets.edit" | "master.edit") {
  const [user, accessible] = await Promise.all([getCurrentUser(), getAccessibleStores()]);
  if (!user) throw new Error("Inicia sesión para continuar.");
  if (!accessible.some((store) => store.org_id === orgId)) throw new Error("No tienes acceso a esta organización.");
  if (!(await hasOrgPermission(orgId, permission))) {
    throw new Error(permission === "master.edit" ? "No tienes permiso para marcar entregas en el Master." : "No tienes permiso para importar reportes de Urpi.");
  }
  const admin = createAdminSupabase();
  const { data, error } = await admin.from("stores").select("id,name").eq("org_id", orgId);
  if (error || !data?.length) throw new Error("No se pudieron leer las tiendas de la organización.");
  // Lo que la persona ve: vincular o marcar entregado solo toca esas tiendas.
  const visibleStoreIds = new Set(accessible.filter((store) => store.org_id === orgId).map((store) => store.id));
  return { user, admin, stores: data as { id: string; name: string }[], visibleStoreIds };
}
