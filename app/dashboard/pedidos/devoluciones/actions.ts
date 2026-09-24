"use server";

import { getReturnsReceptionData } from "@/lib/dispatch-access";
import type { ReconciliationBuckets } from "@/lib/returns-reception";

/**
 * Recarga del cuadre tras cada escaneo. El escaneo en sí es
 * `receiveReturnedPackage` (despacho): la forma de resolver un QR es una sola.
 */
export async function loadReturnsReception(): Promise<ReconciliationBuckets> {
  return getReturnsReceptionData();
}
