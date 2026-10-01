"use server";

import { getCurrentUser, getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { getCourierRouteLedger, type CourierLedgerRow } from "@/lib/courier-route-ledger";
import { findCourierRouteMatches } from "@/lib/courier-route-search";

export async function searchCourierRoutes(input: { code?: string; openOnly?: boolean }): Promise<{ rows: CourierLedgerRow[]; limited: boolean } | { error: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: "Tu sesión venció. Vuelve a iniciar sesión." };
  const [permissions, stores] = await Promise.all([getMasterPermissions(), getAccessibleStores()]);
  if (!stores.length || !(permissions.can("logistics.manage") || permissions.can("routes.manage") || permissions.can("dispatch.manage") || permissions.can("dispatch.pickup"))) {
    return { error: "No tienes permiso para consultar rutas." };
  }
  try {
    const code = input.code?.trim() ?? "";
    if (!code) return { rows: await getCourierRouteLedger({ openOnly: input.openOnly === true }), limited: false };
    const matches = await findCourierRouteMatches(code);
    if (matches.limited) return { rows: [], limited: true };
    const rows = await getCourierRouteLedger({ routeIds: Object.keys(matches.ordersByRoute) });
    return { rows: rows.map((row) => ({ ...row, matchedOrders: matches.ordersByRoute[row.routeId] ?? [] })), limited: false };
  } catch (error) {
    console.error("[courier-route-search]", error);
    return { error: "No se pudieron consultar las rutas. Intenta nuevamente." };
  }
}
