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
