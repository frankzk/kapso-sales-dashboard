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

import { courierKey } from "@/lib/dispatch";
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

// ---------------------------------------------------------------------------
// Lo que Grupo GF no entregó con su propia salida (06-10-2026, decisión del owner)
// ---------------------------------------------------------------------------
//
// EL CASO. #KP132798 salió el 06/09 en una ruta del cuaderno con su salida
// KP132798-S01 de Grupo GF y el 07/09 volvió «No entregado · rechazado». El
// Master lo puso en «Por reprogramar Lima», pero la cola solo traía ese
// apartado con `pendiente_nuevo_courier` (lo que OTRO courier no entregó), y el
// pedido no tenía solicitud de Grupo GF ni caja: no aparecía en «Desde la
// lista» ni se podía tomar por QR. Medido el 05-10-2026: 45 así y 10 con la S01
// todavía dentro de una caja de Grupo GF sin solicitud. El Master tenía 336 en
// «Por reprogramar Lima»; la tarjeta «Por reprogramar», 277.
//
// LA REGLA. La cola trae «Por reprogramar Lima» por su ETAPA, sin mirar el
// estado operativo, y cada pedido dice qué toca o por qué no sale. Si la única
// salida viva es la propia de Grupo GF, se toma con ESA salida: mismo
// consecutivo, QR, rótulo y armado. No se crea otra, no gasta una de las cinco
// ni pide motivo de salida adicional. Si sigue en una caja de un día anterior,
// primero se recibe en oficina («Recibir en oficina» o su escaneo).

/** «En curso · Por reprogramar Lima» en el Master, sea cual sea el estado operativo. */
export function isReprogramStage(stage: unknown, substage: unknown): boolean {
  return stage === "en_curso" && substage === "por_reprogramar_lima";
}

/**
 * Filtro PostgREST de la cola: la etapa del Master, la misma que cuenta la
 * tarjeta «Por reprogramar». Contiene al reintento (`RETRY_QUEUE_FILTER`).
 */
export const REPROGRAM_QUEUE_FILTER = "and(macro_stage.eq.en_curso,macro_substage.eq.por_reprogramar_lima)";

type OwnOutputLike = OutputLike & { status_category?: string | null };

/** Los estados de una salida que sigue viva (los mismos que `activeAssignedOutput`). */
const LIVE_DELIVERY_STATUSES = ["pendiente", "en_ruta"];

/**
 * La salida propia de Grupo GF que no se entregó y vuelve a salir tal cual, o
 * null. Solo en «Por reprogramar Lima», sin nada entregado y con esa salida
 * como ÚNICA viva: la de otro courier que falló no cuenta
 * (`outputsBlockingRetry`); si hay otra viva de verdad, la lleva ese courier.
 */
export function ownRetryOutput<T extends OwnOutputLike>(
  order: { macro_stage?: unknown; macro_substage?: unknown },
  outputs: readonly T[],
): T | null {
  if (!isReprogramStage(order.macro_stage, order.macro_substage)) return null;
  if (outputs.some((output) => output.delivery_status === "entregado" || output.status_category === "delivered")) return null;
  const live = outputsBlockingRetry(outputs).filter((output) => LIVE_DELIVERY_STATUSES.includes(output.delivery_status));
  if (live.length !== 1) return null;
  const output = live[0]!;
  if (courierKey(output.courier) !== "propio" || output.delivery_status !== "pendiente") return null;
  if (output.returned_at || output.custody_state === "devuelto") return null;
  return output;
}

/**
 * Qué toca con esa salida según dónde está el paquete:
 * - `oficina`: en custodia de la empresa y sin caja → se toma con ella.
 * - `recibir_en_oficina`: sigue en una caja y su motorizado lo reportó «No
 *   entregado» en ESA caja → primero «Recibir en oficina» (0188/0206).
 * - `caja_sin_reporte`: sigue en una caja sin ese reporte (la parada de esa
 *   caja dice otra cosa, o solo hay la del cuaderno) → hay que revisarlo.
 * - `fuera_de_oficina`: la custodia no es de la empresa y no está en caja.
 */
export type OwnRetrySpot = "oficina" | "recibir_en_oficina" | "caja_sin_reporte" | "fuera_de_oficina";

export function ownRetrySpot(
  output: { custody_state?: string | null },
  box: { undeliveredReason?: string | null } | null,
): OwnRetrySpot {
  if (box) return box.undeliveredReason ? "recibir_en_oficina" : "caja_sin_reporte";
  return output.custody_state === "empresa" ? "oficina" : "fuera_de_oficina";
}

/** La línea del historial al tomarlo: dice que sale con la misma salida. */
export function ownRetryTakenNote(outputCode: string | null | undefined): string {
  return `Grupo GF Courier tomó el pedido para reprogramarlo con su misma salida${outputCode ? ` ${outputCode}` : ""}: mismo QR y rótulo, sin salida nueva.`;
}

/** dd/mm de un día ISO (`2026-09-17` → `17/09`). */
function dayMonth(day: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day.slice(8, 10)}/${day.slice(5, 7)}` : day;
}

/** Por qué no se puede tomar todavía, según dónde está el paquete. */
export function ownRetrySpotMessage(
  spot: Exclude<OwnRetrySpot, "oficina">,
  box: { riderName: string; routeDate: string } | null,
): string {
  const where = box ? `en la caja de ${box.riderName} del ${dayMonth(box.routeDate)}` : "";
  if (spot === "recibir_en_oficina") return `Sigue ${where} como «No entregado»: recíbelo en oficina (o escanéalo) y después asígnalo.`;
  if (spot === "caja_sin_reporte") return `Sigue ${where} sin «No entregado» de esa caja: revisa su parada antes de sacarlo otra vez.`;
  return "El paquete no consta en la oficina: recíbelo antes de asignarlo.";
}

/** «Grupo GF no entregó · sale con su S01»: la chapa de la fila. */
export function ownOutputLabel(outputCode: string | null | undefined): string {
  const consecutive = /-(S\d+)$/i.exec(outputCode ?? "")?.[1]?.toUpperCase();
  return `Grupo GF no entregó · sale con su ${consecutive ?? "misma salida"}`;
}

/**
 * Por qué un «Por reprogramar Lima» no se puede tomar cuando no es reintento
 * ni salida propia: otra salida sigue viva (la lleva su courier), o no queda
 * ninguna viva que sacar (una propia ya devuelta, por ejemplo).
 */
export function reprogramBlockReason(outputs: readonly OutputLike[]): "otra_salida_viva" | "sin_salida" {
  return outputsBlockingRetry(outputs).some((output) => LIVE_DELIVERY_STATUSES.includes(output.delivery_status))
    ? "otra_salida_viva"
    : "sin_salida";
}
