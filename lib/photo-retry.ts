// La foto que no subió por falta de señal se vuelve a mandar sola (09-10-2026).
// Antes el motorizado tenía que tocar «Reintentar» cada vez que se le caía la
// señal en la calle. Reglas puras: las usa PhotoCapture y las prueban los tests.

/**
 * Cuánto esperar antes del reintento número `attempt` (1, 2, …): 3, 6, 12 y
 * 24 s, y después cada 30 s mientras la pantalla siga abierta. Volver a tener
 * señal o volver a la pantalla lo adelanta.
 */
export function retryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(30_000, 3_000 * 2 ** (n - 1));
}

/**
 * Cuánto dejar correr una subida antes de darla por cortada: un minuto más lo
 * que tardaría a 25 KB/s (una señal muy mala). Sin este tope, una subida
 * colgada en una señal muerta puede quedarse minutos sin fallar y sin
 * reintentarse.
 */
export function uploadTimeoutMs(bytes: number): number {
  return 60_000 + Math.max(0, bytes) / 25;
}

/**
 * ¿Ese código del servidor se arregla solo reintentando? Un corte o una
 * caída suya (5xx), el tiempo agotado (408) o «demasiadas peticiones» (429),
 * sí. Lo demás (sin permiso, ruta cerrada, foto muy grande) no cambia por
 * reintentar: se le dice al motorizado.
 */
export function retryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}
