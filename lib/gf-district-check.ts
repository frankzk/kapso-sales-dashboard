// Si Grupo GF puede tomar un pedido de Lima por su distrito: la misma regla que
// la cola de Despacho del día (`loadCourierOperations`, MOM §29.10 y §29.13) y
// que «Sale a reparto» en Repro Lima (§29.16). Pura.

import { resolveLimaDistrict } from "@/lib/order-coverage";
import {
  resolveDistrictAvailability,
  resolveDistrictTariff,
  type DistrictAvailabilityEventRow,
  type DistrictTariffRow,
} from "@/lib/grupo-gf-courier";

/** La clave de distrito del Tarifario y de las pausas de Grupo GF. */
export function gfDistrictKey(value: string | null): string | null {
  let key = resolveLimaDistrict(value, { searchInText: true });
  if (key === "lurigancho chosica") key = "lurigancho";
  return key;
}

export type GfDistrictBlock = "distrito_invalido" | "tarifa_faltante" | "servicio_pausado";

/**
 * Por qué Grupo GF no toma hoy un pedido de ese distrito, o null si puede: sin
 * convenio con la tienda o sin distrito reconocible, «distrito_invalido»; sin
 * tarifa vigente, «tarifa_faltante»; con el distrito en pausa, general o de
 * ese convenio, «servicio_pausado». Sin tarifa y en pausa dice la tarifa.
 */
export function gfDistrictBlock(input: {
  providerId: string;
  agreementId: string | null;
  district: string | null;
  day: string;
  tariffs: readonly DistrictTariffRow[];
  events: readonly DistrictAvailabilityEventRow[];
}): GfDistrictBlock | null {
  const districtKey = gfDistrictKey(input.district);
  if (!input.agreementId || !districtKey) return "distrito_invalido";
  const scope = { providerId: input.providerId, agreementId: input.agreementId, districtKey, day: input.day };
  if (resolveDistrictTariff(input.tariffs, scope).kind === "missing") return "tarifa_faltante";
  return resolveDistrictAvailability(input.events, scope).status === "paused" ? "servicio_pausado" : null;
}
