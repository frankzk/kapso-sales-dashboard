"use server";

import { getWarehouseStationData, type WarehouseStationData } from "@/lib/dispatch-access";
import { getWarehouseRetries } from "@/lib/warehouse-retries-access";
import type { WarehouseRetriesData } from "@/lib/warehouse-retries";

/**
 * El escaneo que arma la caja sigue siendo `markShipmentReady` (despacho):
 * la regla del armado es una sola y no se duplica por vivir en otra pantalla.
 */
export async function loadWarehouseStation(): Promise<WarehouseStationData> {
  return getWarehouseStationData();
}

/**
 * «Reintentos por salir» (entrega 1c, MOM §9.5): solo lee. La puerta
 * (`warehouse.prepare` y las tiendas de Equipo) va dentro del cargador, que
 * nunca lanza.
 */
export async function loadWarehouseRetries(): Promise<WarehouseRetriesData> {
  return getWarehouseRetries();
}
