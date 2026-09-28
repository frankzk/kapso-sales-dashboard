import type { createAdminSupabase } from "@/lib/db";
import type { OpenLoad } from "@/lib/routes";

/**
 * Lo que el cierre necesita saber de las cargas de Grupo GF de una ruta: si es
 * de Grupo GF (tiene alguna carga no cancelada) y cuáles siguen sin custodia,
 * con sus paquetes activos. Lo leen el cierre (closeRoute) y el panel de la
 * ruta, para que el aviso previo y el error del servidor digan lo mismo.
 *
 * Devuelve null si la lectura falla: «no lo sé» no puede tratarse como «no hay
 * cargas», porque eso dejaría cerrar una ruta con una carga sin recibir.
 */
export interface RouteCloseContext {
  isGf: boolean;
  openLoads: OpenLoad[];
}

export async function loadRouteCloseContext(
  admin: ReturnType<typeof createAdminSupabase>,
  routeId: string,
): Promise<RouteCloseContext | null> {
  const { data, error } = await admin
    .from("dispatch_manifests")
    .select("id,state,load_number")
    .eq("delivery_route_id", routeId)
    .eq("courier", "propio")
    .neq("state", "cancelled");
  if (error) return null;
  const loads = (data ?? []) as { id: string; state: string; load_number: number | null }[];
  const open = loads.filter((load) => load.state !== "in_custody");
  const counts = new Map<string, number>();
  if (open.length) {
    const { data: items, error: itemsError } = await admin
      .from("dispatch_manifest_items")
      .select("manifest_id")
      .in("manifest_id", open.map((load) => load.id))
      .is("removed_at", null);
    if (itemsError) return null;
    for (const item of (items ?? []) as { manifest_id: string }[]) {
      counts.set(item.manifest_id, (counts.get(item.manifest_id) ?? 0) + 1);
    }
  }
  return {
    isGf: loads.length > 0,
    openLoads: open
      .map((load) => ({ id: load.id, load_number: load.load_number ?? 1, state: load.state, items: counts.get(load.id) ?? 0 }))
      .sort((a, b) => a.load_number - b.load_number),
  };
}
