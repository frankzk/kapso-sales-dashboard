// Cuándo recargar el tablero de Leads. Pura, para poder probarla.
//
// EL COSTE. Cada recarga del tablero (`router.refresh()`) vuelve a bajar la
// cola entera de «Por llamar» —unos 2.500 leads con cuarenta columnas— y los
// contadores. El sondeo de la firma cada 30 s evitaba recargar cuando NADA
// cambió; pero en horario de atención algo cambia casi siempre: cada mensaje
// de WhatsApp toca `last_interaction_at` y mueve la firma. Resultado, medido
// el 10-09-2026: 24,5 millones de filas de `leads` servidas en 24 horas, la
// mayor partida del egress después de las tarifas.
//
// LA REGLA. Dos clases de cambio:
//   * URGENTE: cambió el número de «Atender ahora» o de Yapes por verificar.
//     Es la cola que se trabaja al momento: se recarga ya.
//   * TRANQUILO: cualquier otra cosa (un mensaje más, un lead editado, uno
//     nuevo por llamar). Se recarga, pero como mucho cada `QUIET_REFRESH_MS`.
// Y pase lo que pase, una recarga cada `FORCED_REFRESH_MS` por si la firma se
// quedara ciega (una base sin el trigger `leads_touch`).

/** Los contadores que hacen urgente una recarga. */
export const URGENT_COUNTS = ["handoff", "yape"] as const;

/** Entre dos recargas «tranquilas». */
export const QUIET_REFRESH_MS = 2 * 60_000;
/** Red de seguridad: se recarga aunque la firma no cambie. */
export const FORCED_REFRESH_MS = 5 * 60_000;

export interface QueueCountsLike {
  handoff: number;
  yape: number;
}

export type RefreshDecision = "urgent" | "quiet" | "forced" | "skip";

export function decideQueueRefresh(input: {
  prevSignature: string | null;
  nextSignature: string;
  prevCounts: QueueCountsLike | null;
  nextCounts: QueueCountsLike;
  lastRefreshAt: number;
  now: number;
}): RefreshDecision {
  if (input.now - input.lastRefreshAt >= FORCED_REFRESH_MS) return "forced";
  // Sin firma previa no hay con qué comparar: se comporta como antes y recarga.
  if (input.prevSignature === null) return "quiet";
  if (input.nextSignature === input.prevSignature) return "skip";
  if (
    input.prevCounts &&
    URGENT_COUNTS.some((k) => input.prevCounts![k] !== input.nextCounts[k])
  ) {
    return "urgent";
  }
  return input.now - input.lastRefreshAt >= QUIET_REFRESH_MS ? "quiet" : "skip";
}
