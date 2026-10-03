"use server";

import { getReturnsReceptionData, type ReturnsReceptionData } from "@/lib/dispatch-access";

/**
 * Recarga del cuadre tras cada escaneo. El escaneo en sí es
 * `receiveReturnedPackage` (despacho): la forma de resolver un QR es una sola.
 *
 * Si la lectura falla se dice, en vez de pintar un cuadre vacío: la pantalla
 * conserva el anterior y avisa.
 */
export async function loadReturnsReception(): Promise<{ data: ReturnsReceptionData } | { error: string }> {
  try {
    return { data: await getReturnsReceptionData() };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}
