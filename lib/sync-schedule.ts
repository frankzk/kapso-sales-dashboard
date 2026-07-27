// Cómo reparte el trabajo el cron de sincronización: en qué orden entran las
// tiendas y cuántas se sincronizan a la vez.
//
// Vive fuera de `app/api/cron/sync/route.ts` porque un fichero de ruta del App
// Router solo debería exportar handlers y opciones de segmento; cualquier otro
// export es terreno que Next puede reclamar en una versión futura. Además así
// se puede probar sin montar la ruta.

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Recorre `items` con como mucho `limit` en vuelo a la vez, conservando el orden
 * de los resultados.
 *
 * `Promise.all` sobre todas las tiendas de golpe escalaría mal en cuanto haya
 * más de dos: abriría N sesiones de Shopify/Kapso a la vez y las respuestas
 * grandes se acumularían todas en memoria de la función.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Lo que el resumen necesita de cada reporte de tienda. */
export interface RunReportLike {
  storeId: string;
  partial?: boolean;
  skipped?: readonly string[];
  errors?: readonly string[];
  /** Las tiendas que reventaron entran con esto en vez de un reporte completo. */
  error?: string;
}

export interface RunSummary {
  tag: "cron/sync";
  elapsedMs: number;
  remainingMs: number;
  /** Cuánto del presupuesto sobró, en %. Es LA métrica: 0% es rozar el techo. */
  headroomPct: number;
  stores: number;
  partial: boolean;
  yapeAlerts: number;
  /** Etapas saltadas por falta de tiempo, sin repetir, de todas las tiendas. */
  skipped: string[];
  errors: string[];
  perStore: { store: string; partial: boolean; skipped: string[]; errors: string[] }[];
}

// Un error largo (una traza de Shopify, un HTML de error) puede ocupar la línea
// entera y hacerla ilegible. Se recorta: para saber QUÉ falló sobra con el
// principio, y el mensaje completo sigue estando en el cuerpo de la respuesta.
const MAX_ERROR_CHARS = 200;
const MAX_ERRORS_PER_STORE = 5;

function trimErrors(errors: readonly string[]): string[] {
  return errors
    .slice(0, MAX_ERRORS_PER_STORE)
    .map((e) => (e.length > MAX_ERROR_CHARS ? `${e.slice(0, MAX_ERROR_CHARS)}…` : e));
}

/**
 * Resumen de una corrida del cron, pensado para imprimirse en UNA línea.
 *
 * POR QUÉ EXISTE. `partial` y `remainingMs` ya viajaban en el cuerpo de la
 * respuesta, y el cuerpo de la respuesta de un cron no lo lee nadie: de una
 * invocación programada Vercel guarda el código de estado y la duración, no el
 * JSON que devolvió. Sin esta línea, la única señal observable de que el
 * presupuesto está funcionando es la AUSENCIA de timeouts — y a ~0,7 timeouts
 * al día eso tarda una semana o dos en decir algo. `headroomPct` lo dice en
 * horas: si sobra la mitad del presupuesto, no hay nada cerca del techo.
 *
 * Su ausencia también informa. Se imprime al final de la corrida, así que si
 * Vercel mata la función el resumen no llega a salir: una invocación sin línea
 * de resumen es, por definición, una corrida muerta.
 */
export function summarizeRun(input: {
  budgetMs: number;
  elapsedMs: number;
  remainingMs: number;
  stores: number;
  yapeAlerts: number;
  reports: readonly RunReportLike[];
}): RunSummary {
  const perStore = input.reports.map((r) => ({
    store: r.storeId,
    partial: r.partial === true,
    skipped: [...(r.skipped ?? [])],
    // Una tienda que lanzó llega con `error` suelto; una que terminó, con la
    // lista `errors`. Para el resumen las dos cosas son lo mismo: qué falló.
    errors: trimErrors(r.error ? [r.error, ...(r.errors ?? [])] : (r.errors ?? [])),
  }));
  return {
    tag: "cron/sync",
    elapsedMs: input.elapsedMs,
    remainingMs: input.remainingMs,
    headroomPct: input.budgetMs > 0 ? Math.round((input.remainingMs / input.budgetMs) * 100) : 0,
    stores: input.stores,
    partial: perStore.some((s) => s.partial),
    yapeAlerts: input.yapeAlerts,
    skipped: [...new Set(perStore.flatMap((s) => s.skipped))],
    errors: [...new Set(perStore.flatMap((s) => s.errors))],
    perStore,
  };
}

/**
 * Imprime el resumen. Nunca lanza: un fallo escribiendo un log jamás puede
 * tumbar una corrida que ya terminó bien.
 */
export function logRunSummary(summary: RunSummary): void {
  try {
    console.log(JSON.stringify(summary));
  } catch {
    /* ignore */
  }
}

/**
 * Ordena las tiendas por antigüedad de su última sincronización, la más atrasada
 * primero.
 *
 * Importa cuando el presupuesto no alcanza para todas: sin este orden, la tienda
 * que quedó fuera por falta de tiempo volvería a quedar fuera en la corrida
 * siguiente, y la siguiente, porque el orden de `select` es estable. Con él,
 * quedarse fuera te pone el primero en la cola de la próxima.
 */
export async function orderByStaleness(admin: SupabaseClient, storeIds: string[]): Promise<string[]> {
  if (storeIds.length < 2) return storeIds;
  const { data } = await admin.from("sync_state").select("store_id, last_run_at").in("store_id", storeIds);
  const lastRun = new Map<string, number>();
  for (const r of (data ?? []) as { store_id: string; last_run_at: string | null }[]) {
    const t = r.last_run_at ? new Date(r.last_run_at).getTime() : 0;
    const prev = lastRun.get(r.store_id);
    if (prev === undefined || t > prev) lastRun.set(r.store_id, t);
  }
  // Una tienda sin `sync_state` nunca se ha sincronizado: va primera (0).
  return [...storeIds].sort((a, b) => (lastRun.get(a) ?? 0) - (lastRun.get(b) ?? 0));
}
