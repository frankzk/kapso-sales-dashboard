// Cuánto tarda en leer cada pantalla: una línea por carga en los logs de Vercel.
//
// POR QUÉ (owner, 25-11-2026: «es clave el tiempo de carga del sistema»). Solo
// Repro Lima dejaba su línea (`[repro-lima] carga {…}`), y con ella se pudo
// medir en vez de adivinar: 1.056 cargas en un día, de 2 a 8,7 s. Leads, el
// Master, Courier y Envíos no dejaban nada, así que no había cómo saber cuánto
// mejoraba (o empeoraba) un cambio. Esta es la misma línea para todas:
//
//   [leads] carga {"totalMs":1840,"cola":310,"leads":1790,"filas":2412}
//
// QUÉ LLEVA. El nombre de la pantalla, milisegundos por lectura y conteos. Nada
// más: ni pedidos, ni clientas, ni tiendas, ni quién la abrió. Los tipos lo
// obligan (solo números).
//
// QUÉ MIDE Y QUÉ NO. El tiempo de leer los datos en el servidor. No el viaje al
// navegador ni lo que tarda en pintarse; eso lo mide `dashboard:navigation`
// (lib/client-performance.ts), que solo llega hasta el esqueleto.
//
// Las lecturas van en paralelo: sus tiempos se solapan y no suman `totalMs`.

export interface PageLoadTimer {
  /** Mide una lectura sin cambiar su resultado ni su error. */
  timed<T>(label: string, work: Promise<T>): Promise<T>;
  /** Escribe la línea, una sola vez. `counts`: cuántas filas se leyeron. */
  done(counts?: Record<string, number>): void;
}

export function pageLoadTimer(
  screen: string,
  options: { now?: () => number; log?: (line: string) => void } = {},
): PageLoadTimer {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.info(line));
  const started = now();
  const times: Record<string, number> = {};
  let written = false;
  return {
    async timed<T>(label: string, work: Promise<T>): Promise<T> {
      const from = now();
      try {
        return await work;
      } finally {
        times[label] = now() - from;
      }
    },
    done(counts: Record<string, number> = {}) {
      if (written) return;
      written = true;
      const numbers = Object.fromEntries(Object.entries(counts).filter(([, value]) => typeof value === "number" && Number.isFinite(value)));
      log(`[${screen}] carga ${JSON.stringify({ totalMs: now() - started, ...times, ...numbers })}`);
    },
  };
}

/**
 * Las etapas EN FILA de una lectura: cada marca anota cuánto pasó desde la
 * anterior (`c.etapa`, `c.hechos`, `p.lecturas`…).
 *
 * POR QUÉ (owner, 25-11-2026: «que Repro Lima quede con carga rápida»). Con los
 * lotes anchos Repro Lima bajó de 2,3–3,6 s a 1,6–2,3 s, menos de lo estimado,
 * y `casos` y `pendientes` solos no dicen cuál de sus esperas en fila pesa. Con
 * esto la línea `[repro-lima] carga` lo dice. Solo números; sin `times` no
 * anota nada (los demás usos de esas lecturas no miden).
 */
export function stageClock(times: Record<string, number> | undefined, now: () => number = Date.now): (label: string) => void {
  let last = now();
  return (label) => {
    const at = now();
    if (times) times[label] = at - last;
    last = at;
  };
}

/** Una lectura que va A LA VEZ que otras dentro de una etapa. Sin `times` no mide. */
export async function stageTimed<T>(times: Record<string, number> | undefined, label: string, work: Promise<T>, now: () => number = Date.now): Promise<T> {
  if (!times) return work;
  const from = now();
  try {
    return await work;
  } finally {
    times[label] = now() - from;
  }
}
