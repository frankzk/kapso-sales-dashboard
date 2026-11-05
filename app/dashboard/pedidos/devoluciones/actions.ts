"use server";

import { getReturnsReceptionData, type ReturnsReceptionData } from "@/lib/dispatch-access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { RETURN_MANIFEST_PERMISSION } from "@/lib/return-manifest";

/**
 * Recarga del cuadre tras cada escaneo. El escaneo en sí es
 * `receiveReturnedPackage` (despacho): la forma de resolver un QR es una sola.
 *
 * Si la lectura falla se dice, en vez de pintar un cuadre vacío: la pantalla
 * conserva el anterior y avisa.
 */
export async function loadReturnsReception(): Promise<{ data: ReturnsReceptionData } | { error: string }> {
  // El mismo permiso que la página: el cuadre de Grupo GF se lee con el service
  // role (acotado a las tiendas del usuario) y no se sirve a cualquiera.
  const perms = await getMasterPermissions();
  if (!perms.can(RETURN_MANIFEST_PERMISSION)) return { error: "No tienes acceso al almacén." };
  try {
    return { data: await getReturnsReceptionData() };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}
