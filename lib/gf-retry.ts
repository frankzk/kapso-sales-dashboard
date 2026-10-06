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
// misma regla de lib/reproprovincia.ts que decide el Master). Qué NO se toma: un
// «Por reprogramar Lima» cuya guía sigue viva con su courier —una
// reprogramación de Aliclik, por ejemplo—: esa la lleva ese courier. Desde el
// 06-10-2026 la cola trae todo «Por reprogramar Lima» por su etapa y lo que
// Grupo GF no entregó con su propia salida sale con ESA salida (abajo).
//
// Al tomarlo se crea una salida NUEVA con su QR y Almacén arma otra caja (§9.3):
// la caja anterior es de otro courier y trae su rótulo. Si todavía vuelve, la
// salida nueva es adicional y su motivo se escribe solo (§9, «otra salida viva
// pide motivo, no bloquea»): el porqué ya lo dijo el courier.

import { courierKey } from "@/lib/dispatch";
import { guideFailedAfterDispatch, type RecoveryGuideLike } from "@/lib/reproprovincia";
import { isCourierTbd, nombreDeCourier } from "@/lib/shipment-output";

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
  // Una salida devuelta (la 0189 deja `pendiente` con custodia `devuelto`) ya
  // no está viva: no se reusa ni estorba a otra que sí lo esté.
  const live = outputsBlockingRetry(outputs).filter((output) =>
    LIVE_DELIVERY_STATUSES.includes(output.delivery_status) && !output.returned_at && output.custody_state !== "devuelto");
  if (live.length !== 1) return null;
  const output = live[0]!;
  return courierKey(output.courier) === "propio" && output.delivery_status === "pendiente" ? output : null;
}

/**
 * Qué toca con esa salida, la misma decisión en la cola y al tomarlo:
 * - `tomar`: en custodia de la empresa, sin caja y sin otra solicitud → se toma
 *   con ella.
 * - `recibir_en_oficina`: sigue en una caja y lo ÚLTIMO que su motorizado
 *   reportó en ESA caja es «No entregado» → primero «Recibir en oficina» (lo
 *   mismo que exige `gf_return_to_office`, 0206).
 * - `bloquear`, con el motivo de «Sin condiciones»:
 *   - `caja_sin_reporte`: en una caja sin ese reporte (la parada de la caja
 *     dice otra cosa, o solo está la del cuaderno): hay que revisar la parada.
 *   - `fuera_de_oficina`: ni en la empresa ni en una caja.
 *   - `salida_en_otra_solicitud`: la salida ya estuvo en otra solicitud de
 *     Grupo GF, aunque cancelada (`logistics_requests_shipment_uniq`, 0138).
 */
export type OwnRetryBlock = "caja_sin_reporte" | "fuera_de_oficina" | "salida_en_otra_solicitud";

export type OwnRetryDecision =
  | { action: "tomar" }
  | { action: "recibir_en_oficina" }
  | { action: "bloquear"; reason: OwnRetryBlock };

export function ownRetryDecision(
  output: { custody_state?: string | null; custody_transferred_at?: string | null },
  box: { undeliveredReason?: string | null } | null,
  inOtherRequest: boolean,
): OwnRetryDecision {
  if (box) return box.undeliveredReason ? { action: "recibir_en_oficina" } : { action: "bloquear", reason: "caja_sin_reporte" };
  if (output.custody_state !== "empresa" || output.custody_transferred_at) return { action: "bloquear", reason: "fuera_de_oficina" };
  if (inOtherRequest) return { action: "bloquear", reason: "salida_en_otra_solicitud" };
  return { action: "tomar" };
}

/** La línea del historial al tomarlo: dice que sale con la misma salida. */
export function ownRetryTakenNote(outputCode: string | null | undefined): string {
  return `Grupo GF Courier tomó el pedido para reprogramarlo con su misma salida${outputCode ? ` ${outputCode}` : ""}: mismo QR y rótulo, sin salida nueva.`;
}

/** dd/mm de un día ISO (`2026-09-17` → `17/09`). */
function dayMonth(day: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day.slice(8, 10)}/${day.slice(5, 7)}` : day;
}

/** Por qué no se puede tomar todavía, dicho al tomarlo o al escanearlo. */
export function ownRetryDecisionMessage(
  decision: Exclude<OwnRetryDecision, { action: "tomar" }>,
  box: { riderName: string; routeDate: string } | null,
  outputCode?: string | null,
): string {
  const where = box ? `en la caja de ${box.riderName}${box.routeDate ? ` del ${dayMonth(box.routeDate)}` : ""}` : "en una caja";
  if (decision.action === "recibir_en_oficina") return `Sigue ${where} como «No entregado»: recíbelo en oficina (o escanéalo) y después asígnalo.`;
  if (decision.reason === "caja_sin_reporte") return `Sigue ${where} sin «No entregado» de esa caja: revisa su parada antes de sacarlo otra vez.`;
  if (decision.reason === "salida_en_otra_solicitud") return `${outputCode ?? "Su salida"} ya estuvo en otra solicitud de Grupo GF: revísalo antes de volver a tomarlo.`;
  return "El paquete no consta en la oficina ni en una caja: revisa su custodia en la ficha antes de asignarlo.";
}

/** «Grupo GF no entregó · sale con su S01»: la chapa de la fila. */
export function ownOutputLabel(outputCode: string | null | undefined): string {
  const consecutive = /-(S\d+)$/i.exec(outputCode ?? "")?.[1]?.toUpperCase();
  return `Grupo GF no entregó · sale con su ${consecutive ?? "misma salida"}`;
}

/**
 * Por qué un «Por reprogramar Lima» no se puede tomar cuando no es reintento
 * ni salida propia que se reusa. Una salida devuelta (custodia `devuelto` o
 * `returned_at`: el rechazo que la 0189 recibió, que deja `pendiente`) no está
 * viva aunque su `delivery_status` lo diga.
 * - `otra_salida_viva`: la lleva otro courier (una reprogramación de Aliclik).
 * - `varias_salidas_vivas`: más de una salida de Grupo GF o «por definir» viva.
 * - `salida_devuelta`: la propia ya volvió al almacén y no queda otra viva.
 * - `sin_salida`: no queda ninguna.
 */
export type ReprogramBlock = "otra_salida_viva" | "varias_salidas_vivas" | "salida_devuelta" | "sin_salida";

export function reprogramBlockReason(outputs: readonly OutputLike[]): ReprogramBlock {
  const returned = (output: OutputLike) => Boolean(output.returned_at) || output.custody_state === "devuelto";
  const live = outputsBlockingRetry(outputs).filter((output) => LIVE_DELIVERY_STATUSES.includes(output.delivery_status) && !returned(output));
  const ours = (output: OutputLike) => courierKey(output.courier) === "propio" || isCourierTbd(output.courier);
  if (live.some((output) => !ours(output))) return "otra_salida_viva";
  if (live.length > 1) return "varias_salidas_vivas";
  if (outputs.some((output) => courierKey(output.courier) === "propio" && returned(output))) return "salida_devuelta";
  return "sin_salida";
}
