// Swayp desde Por confirmar (MOM §11.11, v1.24, 09-10-2026, decisión del owner).
//
// QUÉ ES. Desde la mesa de confirmación de un pedido de provincia COD con
// «Swayp ok · con stock», el botón «Enviar por Swayp» emite la guía Swayp sin
// esperar la confirmación. Si Swayp ENTREGA, terminó. Si NO entrega —por el
// motivo que sea—, el pedido VUELVE a Por confirmar en la subetapa «Swayp no
// entregó», para que entre otra vez a las llamadas y normalmente salga por
// Aliclik. No hay segunda guía automática: la decide una persona al volver a
// llamar.
//
// POR QUÉ ASÍ. Es el orden inverso de la Fase 3 del MOM («Aliclik primero,
// Swayp tras el fallo»), elegido por el owner para los pedidos que Swayp puede
// llevar hoy. La alternativa que se descartó era generar la guía Aliclik sola
// al día siguiente del reporte de Swayp; la llamada de por medio es más barata
// que un envío a una clienta que quizás ya dijo que no.
//
// Este archivo es PURO: decide sobre las guías y los hechos ya cargados. Lo leen
// el resolvedor de la macroetapa (`resolveMacroStage`), la acción que crea la
// guía y la pantalla del registro, para que los tres digan lo mismo.

import { apiGuideReceivedBack, guideDoorRejection, swaypGuideFailed, type RecoveryGuideLike } from "@/lib/reproprovincia";
import { swaypLabelSaysOwnFailure } from "@/lib/swayp";

/** El hecho que marca la guía Swayp como salida desde Por confirmar. */
export const SWAYP_DESDE_CONFIRMACION_KIND = "swayp_desde_por_confirmar";

/** Por qué no entregó, en el vocabulario del Master. */
export type SwaypNoEntregoMotivo = "rechazo_en_puerta" | "falla_swayp" | "no_entregado";

export const SWAYP_NO_ENTREGO_MOTIVO_LABEL: Record<SwaypNoEntregoMotivo, string> = {
  rechazo_en_puerta: "Rechazó en la puerta",
  falla_swayp: "Falla de Swayp",
  no_entregado: "No se entregó",
};

export interface CaseGuideLike extends RecoveryGuideLike {
  id: string;
}

export interface CaseEventLike {
  kind: string;
  occurred_at: string;
  shipment_id?: string | null;
}

export interface SwaypDesdeConfirmacionCase<G extends CaseGuideLike> {
  /** La guía Swayp que salió con el botón. */
  guide: G;
  /** Cuándo se pulsó el botón. */
  sentAt: string;
}

/**
 * El caso vigente del pedido: el ÚLTIMO hecho del botón cuya guía sigue en la
 * lista. Si hubo dos (salió, volvió, salió otra vez por el botón), manda el
 * último: el anterior ya se resolvió volviendo a Por confirmar.
 */
export function swaypDesdeConfirmacionCase<G extends CaseGuideLike>(
  guides: readonly G[],
  events: readonly CaseEventLike[],
): SwaypDesdeConfirmacionCase<G> | null {
  let best: SwaypDesdeConfirmacionCase<G> | null = null;
  for (const event of events) {
    if (event.kind !== SWAYP_DESDE_CONFIRMACION_KIND || !event.shipment_id) continue;
    const guide = guides.find((g) => g.id === event.shipment_id);
    if (!guide) continue;
    if (!best || event.occurred_at > best.sentAt) best = { guide, sentAt: event.occurred_at };
  }
  return best;
}

/**
 * ¿Swayp ya no la va a entregar?
 *
 * - Devolución (8), Devolución confirmada (9) o con cobro (12): la misma regla
 *   que Reproprovincia (`swaypGuideFailed`). En provincia Swayp deja la guía en
 *   8 y no la pasa a 9, así que esperar al 9 sería esperar para siempre.
 * - La caja ya escaneada de vuelta aunque Swayp la siga dando por viva
 *   (`apiGuideReceivedBack`).
 * - Anulada o devuelta en Kapta: se canceló, salió y volvió, o se anuló a mano.
 *
 * Una novedad abierta (6) NO es un fallo: Swayp todavía puede entregarla, y
 * vuelve de 6 a reparto todos los días.
 */
export function swaypDesdeConfirmacionFailed(guide: RecoveryGuideLike): boolean {
  return (
    swaypGuideFailed(guide) ||
    apiGuideReceivedBack(guide) ||
    guide.delivery_status === "anulado" ||
    guide.delivery_status === "devuelto"
  );
}

/** El motivo con que vuelve a Por confirmar, para que la asesora sepa a qué llama. */
export function swaypNoEntregoMotivo(guide: RecoveryGuideLike): SwaypNoEntregoMotivo {
  if (guideDoorRejection(guide)) return "rechazo_en_puerta";
  if (swaypLabelSaysOwnFailure(guide.reported_status)) return "falla_swayp";
  return "no_entregado";
}

/**
 * ¿Es una guía Swayp que ya no va a entregar —en Devolución, o con la caja ya
 * de vuelta— y por eso NO frena la salida siguiente?
 *
 * La regla de «una sola salida viva fuera de Lima» pide gestionar o anular la
 * anterior antes de emitir otra, pero una guía Swayp en Devolución no se puede
 * anular (Swayp solo cancela en Generada, 1) ni se va a entregar: la caja vuelve
 * a su bodega. Sin esta excepción, el pedido que vuelve a Por confirmar no podría
 * salir por Aliclik nunca. Riesgo aceptado: Swayp a veces devuelve una
 * Devolución a Reparto (MOM §11.2); si pasara con la Aliclik ya emitida, el
 * Master avisa de dos salidas vivas (§4).
 */
export function swaypGuiaDeVuelta(guide: RecoveryGuideLike): boolean {
  const courier = (guide.courier ?? "").trim().toLowerCase();
  if (courier !== "fenix" && courier !== "swayp") return false;
  return swaypGuideFailed(guide) || apiGuideReceivedBack(guide);
}

/** En qué quedó un caso, para la pantalla del registro. */
export type SwaypDesdeConfirmacionOutcome =
  | "en_camino"
  | "entregado"
  | "volvio_a_confirmar"
  | "nueva_salida"
  | "anulado_shopify";

export const SWAYP_DESDE_CONFIRMACION_OUTCOME_LABEL: Record<SwaypDesdeConfirmacionOutcome, string> = {
  en_camino: "Swayp en camino",
  entregado: "Entregado por Swayp",
  volvio_a_confirmar: "Volvió a Por confirmar",
  nueva_salida: "Salió por otra vía",
  anulado_shopify: "Anulado en Shopify",
};

/**
 * El resultado de UN caso, con la misma regla que el Master: falló según
 * `swaypDesdeConfirmacionFailed`; después, o salió otra guía, o el pedido está de
 * vuelta en Por confirmar. La entrega gana a todo; la anulación en Shopify, a lo
 * que no se entregó.
 */
export function swaypDesdeConfirmacionOutcome(input: {
  guide: RecoveryGuideLike;
  /** Otras salidas del pedido nacidas DESPUÉS del envío por Swayp, sin las anuladas. */
  laterOutputs: readonly { delivery_status: string }[];
  cancelledAt: string | null;
}): SwaypDesdeConfirmacionOutcome {
  if (input.guide.delivery_status === "entregado") return "entregado";
  if (input.cancelledAt) return "anulado_shopify";
  if (!swaypDesdeConfirmacionFailed(input.guide)) return "en_camino";
  return input.laterOutputs.length ? "nueva_salida" : "volvio_a_confirmar";
}
