// Reprogramar con Grupo GF lo que otro courier no entregó (29-09-2026).
//
// EL CASO. #KP135035 (Tanders lo devolvía) y #KP135161 (ya devuelto) no salían
// en «Desde la lista»: la cola de Despacho del día solo miraba Preparación y Por
// despachar, y un pedido que otro courier no entregó está En curso. El MOM §9 ya
// decía qué toca —«un no entregado pasa a Por reprogramar Lima» y «no es
// obligatorio esperar la devolución anterior para crear otra salida»—, pero para
// Grupo GF no había puerta.
//
// Qué entra: el pedido en recuperación, es decir `pendiente_nuevo_courier` (la
// misma regla de lib/reproprovincia.ts que decide el Master). Qué NO entra: un
// «Por reprogramar Lima» cuya guía sigue viva con su courier —una
// reprogramación de Aliclik, por ejemplo—: esa la lleva ese courier.
//
// Al tomarlo se crea una salida NUEVA con su QR y Almacén arma otra caja (§9.3):
// la caja anterior es de otro courier y trae su rótulo. Si todavía vuelve, la
// salida nueva es adicional y su motivo se escribe solo (§9, «otra salida viva
// pide motivo, no bloquea»): el porqué ya lo dijo el courier.

import { guideFailedAfterDispatch, type RecoveryGuideLike } from "@/lib/reproprovincia";
import { nombreDeCourier } from "@/lib/shipment-output";

/** ¿El pedido espera un courier nuevo porque otro no lo entregó? */
export function isRetryAdmission(
  stage: unknown,
  substage: unknown,
  operational: unknown,
): boolean {
  return stage === "en_curso" && substage === "por_reprogramar_lima" && operational === "pendiente_nuevo_courier";
}

/** Filtro PostgREST de la cola: el mismo criterio que `isRetryAdmission`. */
export const RETRY_QUEUE_FILTER =
  "and(macro_stage.eq.en_curso,macro_substage.eq.por_reprogramar_lima,operational_status.eq.pendiente_nuevo_courier)";

/** La salida que no se entregó, para decirlo en la fila y en el motivo. */
export interface FailedOutput {
  courier: string;
  /** La caja ya está de vuelta en el almacén (o el courier dice que lo está). */
  returned: boolean;
}

type OutputLike = RecoveryGuideLike & {
  returned_at?: string | null;
  custody_state?: string | null;
  output_number?: number | null;
};

/**
 * Las salidas que SÍ impiden que Grupo GF lo tome: las vivas que no fallaron.
 * La de Tanders que vuelve sigue `en_ruta`, pero ya no la trabaja nadie.
 */
export function outputsBlockingRetry<T extends OutputLike>(outputs: readonly T[]): T[] {
  return outputs.filter((output) => !guideFailedAfterDispatch(output));
}

/** La última salida que falló (la de consecutivo más alto), o null. */
export function lastFailedOutput(outputs: readonly OutputLike[]): FailedOutput | null {
  let best: OutputLike | null = null;
  for (const output of outputs) {
    if (!guideFailedAfterDispatch(output)) continue;
    if (!best || (output.output_number ?? 0) >= (best.output_number ?? 0)) best = output;
  }
  if (!best) return null;
  return {
    courier: best.courier,
    returned: Boolean(best.returned_at) || best.custody_state === "devuelto",
  };
}

/** «Tanders no entregó · vuelve» / «· volvió»: la chapa de la fila. */
export function failedOutputLabel(failed: FailedOutput): string {
  return `${nombreDeCourier(failed.courier)} no entregó · ${failed.returned ? "volvió" : "vuelve"}`;
}

/**
 * El motivo de la salida adicional cuando la caja anterior todavía no volvió.
 * Lo escribe el sistema porque el hecho ya consta: lo reportó el courier.
 */
export function retryAdditionalReason(failed: FailedOutput): string {
  return `${nombreDeCourier(failed.courier)} no entregó y su caja todavía vuelve: se reprograma con Grupo GF desde Despacho del día.`;
}

/** La línea del historial al tomarlo: dice por qué hay una salida nueva. */
export function retryTakenNote(failed: FailedOutput): string {
  return `Grupo GF Courier tomó el pedido para reprogramarlo: ${nombreDeCourier(failed.courier)} no lo entregó y sale en una salida nueva.`;
}
