// Presupuesto de tiempo para trabajos acotados por el `maxDuration` de Vercel.
//
// POR QUÉ EXISTE. Una función serverless que se pasa de `maxDuration` no
// "termina mal": Vercel la MATA en seco. Lo que estuviera a medio escribir queda
// a medias, no hay reporte, no hay log de cierre, y el error que se ve es un
// escueto "Task timed out after 300 seconds" sin decir en qué etapa fue.
//
// El cron de sincronización (`/api/cron/sync`) llevaba semanas rozando ese techo:
// cada tienda tarda entre 2 y 3.5 minutos y se sincronizaban en serie, así que
// dos tiendas ya sumaban de 4 a 7 minutos contra un límite de 5.
//
// La salida no es "que corra más rápido" (siempre habrá una tienda con más
// backlog), sino que la corrida SEPA cuánto le queda y pare por su cuenta antes
// de que la maten. Eso es correcto aquí porque cada etapa del sync es
// incremental y reanudable: los cursores de `sync_state` avanzan solo sobre lo
// ya ingerido, y el cron vuelve a pasar a los 5 minutos. Una corrida parcial no
// pierde datos, solo los difiere.

/** Presupuesto de tiempo consultable de una corrida. */
export interface Deadline {
  /** Milisegundos que quedan. Nunca negativo: 0 significa agotado. */
  remainingMs(): number;
  /**
   * ¿Queda margen para una etapa que se estima en `estimateMs`?
   *
   * Se pregunta ANTES de empezar la etapa, no durante: el objetivo es no
   * arrancar trabajo que no va a caber, porque una etapa cortada a la mitad por
   * el runtime es justamente lo que queremos evitar.
   */
  hasRoomFor(estimateMs: number): boolean;
  /** ¿Se agotó el presupuesto? */
  expired(): boolean;
}

/**
 * Crea un presupuesto de `budgetMs` a partir de ahora.
 *
 * `now` es inyectable para los tests: sin eso, probar un presupuesto exige
 * esperar en tiempo real.
 */
export function createDeadline(budgetMs: number, now: () => number = Date.now): Deadline {
  const endsAt = now() + Math.max(0, budgetMs);
  const remainingMs = () => Math.max(0, endsAt - now());
  return {
    remainingMs,
    // Estrictamente mayor: una etapa estimada en exactamente lo que queda no
    // cabe, porque la estimación siempre se queda corta antes que larga.
    hasRoomFor: (estimateMs) => remainingMs() > Math.max(0, estimateMs),
    expired: () => remainingMs() <= 0,
  };
}

/** Presupuesto ilimitado: para las rutas que llaman al sync sin techo de tiempo. */
export function unlimitedDeadline(): Deadline {
  return {
    remainingMs: () => Number.POSITIVE_INFINITY,
    hasRoomFor: () => true,
    expired: () => false,
  };
}
