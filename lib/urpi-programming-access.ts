import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { hasOrgPermission } from "@/lib/permissions-access";

export async function requireUrpiStore(storeId: string, manage = false) {
  const [user, stores] = await Promise.all([getCurrentUser(), getAccessibleStores()]);
  if (!user) throw new Error("Inicia sesión para continuar.");
  const store = stores.find((item) => item.id === storeId);
  if (!store) throw new Error("No tienes acceso a esta tienda.");
  const allowed = await hasOrgPermission(store.org_id, manage ? "sheets.manage" : "sheets.edit");
  if (!allowed) throw new Error(manage ? "No tienes permiso para registrar archivos mensuales." : "No tienes permiso para importar programaciones.");
  return { user, store };
}
