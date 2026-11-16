// Una semana midiendo cuánto tarda cada parte del Consolidado (owner,
// 16-11-2026: «a veces» tarda en cargar; «sí, déjalo midiendo una semana»).
//
// Cada entrada deja UNA línea en los logs de Vercel, `[consolidado-timing]`,
// con los milisegundos de cada consulta del bloque principal, el total y si la
// instancia del servidor estaba en frío (su primera página). Con eso se decide
// si hace falta separar el Consolidado por bloques o si la espera es el
// arranque en frío. Pasada la fecha ya no escribe nada. No cambia lo que se ve.

export const CONSOLIDADO_TIMING_UNTIL = "2026-11-23T05:00:00Z";

/** La primera página que sirve esta instancia del servidor es «en frío». */
let warm = false;

export interface ConsolidadoTimer {
  /** Mide una consulta: anota cuánto tardó, resuelva o falle, y la devuelve igual. */
  time<T>(label: string, promise: Promise<T>): Promise<T>;
  /** Escribe la línea (si sigue la medición) y la devuelve, para las pruebas. */
  done(extra?: Record<string, unknown>): Record<string, unknown> | null;
}

export function consolidadoTimer(opts: { now?: () => number; log?: (line: string) => void; until?: string } = {}): ConsolidadoTimer {
  const now = opts.now ?? (() => performance.now());
  const start = now();
  const cold = !warm;
  warm = true;
  const marks: Record<string, number> = {};
  return {
    time<T>(label: string, promise: Promise<T>): Promise<T> {
      const s = now();
      return promise.finally(() => {
        marks[label] = Math.round(now() - s);
      });
    },
    done(extra = {}) {
      if (Date.now() >= Date.parse(opts.until ?? CONSOLIDADO_TIMING_UNTIL)) return null;
      const entries = Object.entries(marks);
      const slowest = entries.reduce<[string, number] | null>((a, e) => (!a || e[1] > a[1] ? e : a), null);
      const line = { totalMs: Math.round(now() - start), cold, slowest: slowest?.[0] ?? null, ...extra, ms: marks };
      (opts.log ?? ((l: string) => console.info(l)))(`[consolidado-timing] ${JSON.stringify(line)}`);
      return line;
    },
  };
}
