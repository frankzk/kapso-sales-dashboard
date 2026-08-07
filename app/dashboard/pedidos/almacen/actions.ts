"use server";

import { getWarehouseStationData, type WarehouseStationData } from "@/lib/dispatch-access";

/**
 * El escaneo que arma la caja sigue siendo `markShipmentReady` (despacho):
 * la regla del armado es una sola y no se duplica por vivir en otra pantalla.
 */
export async function loadWarehouseStation(): Promise<WarehouseStationData> {
  return getWarehouseStationData();
}
