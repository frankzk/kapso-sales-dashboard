import { dispatchProgress, needsRiderCheck, type DispatchManifestState, type DispatchProgressItem, type DispatchRouteKind } from "./dispatch";

export function nextDispatchMode(manifest: {
  state: DispatchManifestState; kind: DispatchRouteKind; items: DispatchProgressItem[];
} | null, canManage: boolean): "build" | "office" | "pickup" {
  if (!manifest) return canManage ? "build" : "pickup";
  const progress = dispatchProgress(manifest.items);
  if (!progress.total) return canManage ? "build" : "pickup";
  if (!canManage) return "pickup";
  if (!progress.officeComplete) return "office";
  return needsRiderCheck(manifest.kind) ? "pickup" : "office";
}

/** Page through the entire source, including servers imposing a 1,000-row cap. */
export async function allCourierRows<T>(fetchPage: (from: number, to: number) => PromiseLike<{
  data: T[] | null; error: { message: string } | null;
}>): Promise<T[]> {
  const rows: T[] = [];
  const size = 500;
  for (let offset = 0; ; offset += size) {
    const result = await fetchPage(offset, offset + size - 1);
    if (result.error) throw new Error(result.error.message);
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < size) return rows;
  }
}

/**
 * Como `allCourierRows`, sin esperar las páginas una tras otra: la primera pide
 * además el conteo exacto y las que faltan se traen a la vez.
 *
 * POR QUÉ (owner, 25-11-2026: «que Repro Lima quede con carga rápida»). Los
 * ~1.160 pedidos pendientes de Lima son tres páginas de 500, y las dos lecturas
 * de Repro Lima empezaban esperándolas en fila.
 *
 * SOLO LA PRIMERA PÁGINA PIDE EL CONTEO (`counted`). Con el conteo pedido, el
 * servidor responde con error («Requested range not satisfiable») a una página
 * que empieza más allá de la última fila, en vez de devolverla vacía. A la
 * primera no le puede pasar (empieza en cero); a las demás sí, si salieron
 * pedidos de la etapa mientras se leía. Por eso van sin conteo, como siempre.
 *
 * Devuelve lo mismo que `allCourierRows`, en el mismo orden:
 *   - sin conteo (un servidor o una prueba que no lo da), sigue página por página;
 *   - si la última página pedida llega llena (entraron filas mientras se leía),
 *     sigue página por página hasta una que no lo esté;
 *   - el primer error corta la lectura: nunca una lista parcial.
 */
export async function allCourierRowsCounted<T>(fetchPage: (from: number, to: number, counted: boolean) => PromiseLike<{
  data: T[] | null; error: { message: string } | null; count?: number | null;
}>): Promise<T[]> {
  const size = 500;
  const page = async (index: number): Promise<{ rows: T[]; count: number | null }> => {
    const result = await fetchPage(index * size, index * size + size - 1, index === 0);
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], count: typeof result.count === "number" ? result.count : null };
  };
  const first = await page(0);
  const rows: T[] = [...first.rows];
  if (first.rows.length < size) return rows;
  // Las páginas que el conteo dice que faltan, a la vez (de a `COURIER_ROWS_CONCURRENCY`).
  let next = 1;
  if (first.count !== null && first.count > size) {
    const pending = Array.from({ length: Math.ceil(first.count / size) - 1 }, (_, i) => String(i + 1));
    const pages = await inConcurrentBatches(pending, 1, async ([index]) => [(await page(Number(index))).rows]);
    for (const batch of pages) {
      rows.push(...batch);
      next += 1;
      // Una página corta en medio: ahí terminó la lista (salieron filas mientras se leía).
      if (batch.length < size) return rows;
    }
  }
  // Sin conteo, o con la última página llena: se sigue como `allCourierRows`.
  for (; ; next += 1) {
    const more = (await page(next)).rows;
    rows.push(...more);
    if (more.length < size) return rows;
  }
}

/** Lotes de `courierRowsByIds` en vuelo a la vez. */
export const COURIER_ROWS_CONCURRENCY = 4;

/**
 * Lee por lotes de 100 ids, hasta `COURIER_ROWS_CONCURRENCY` a la vez.
 *
 * LOS LOTES IBAN UNO TRAS OTRO (owner, 21-11-2026: «Repro Lima anda cargando
 * súper lento»). Con 1.417 pedidos son 15 lotes por tabla, y Repro Lima lee
 * así una docena de tablas, varias encadenadas: cada vuelta a la base sumaba
 * su espera a la anterior. Ahora van de a cuatro, que es poco para la base y
 * corta la espera a una cuarta parte. Las filas salen en el orden de los
 * lotes, como antes, y el primer error sigue cortando la lectura: una lista
 * parcial nunca se presenta como completa.
 */
export async function courierRowsByIds<T>(ids: string[], read: (ids: string[]) => PromiseLike<{
  data: T[] | null; error: { message: string } | null;
}>, batchSize: number = 100): Promise<{ data: T[] }> {
  return { data: await inConcurrentBatches(ids, batchSize, async (batch) => {
    const result = await read(batch);
    if (result.error) throw new Error(result.error.message);
    return result.data ?? [];
  }) };
}

/** Los lotes de a `COURIER_ROWS_CONCURRENCY`, en su orden; el primer error corta la lectura. */
async function inConcurrentBatches<T>(ids: string[], batchSize: number, readBatch: (batch: string[]) => Promise<T[]>): Promise<T[]> {
  const batches: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += batchSize) batches.push(ids.slice(offset, offset + batchSize));
  const results: T[][] = new Array(batches.length);
  let next = 0;
  let failed: Error | null = null;
  const worker = async () => {
    while (!failed && next < batches.length) {
      const index = next++;
      try {
        results[index] = await readBatch(batches[index]!);
      } catch (error) {
        failed ??= error instanceof Error ? error : new Error(String(error));
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COURIER_ROWS_CONCURRENCY, batches.length) }, worker));
  if (failed) throw failed;
  return results.flat();
}

/** Ids por lote en las lecturas anchas (`courierRowsByIdsWide`). */
export const COURIER_ROWS_WIDE_BATCH = 400;

/**
 * Sin el conteo exacto, una respuesta con tantas filas o más se trata como
 * posiblemente cortada. Va por debajo del tope de filas del servidor:
 * `allCourierRows` ya depende de recibir páginas completas de 500.
 */
export const COURIER_ROWS_SAFE_RESPONSE = 500;

/**
 * Como `courierRowsByIds`, con lotes de 400 ids y una guarda contra el tope
 * de filas del servidor.
 *
 * POR QUÉ (owner, 25-11-2026: «que Repro Lima quede con carga rápida»). Medido
 * ese día: cada carga de Repro Lima hacía unas 260 consultas pequeñas, porque
 * cada tabla se leía de a 100 pedidos (12 a 15 lotes por tabla) y tardaba de
 * 2,3 a 3,6 s; con cinco personas a la vez, 5 a 8,7 s. La base estaba quieta:
 * lo que se esperaba era la fila de consultas. Con lotes de 400 son la cuarta
 * parte.
 *
 * LA GUARDA. Un lote ancho puede traer más filas de las que el servidor
 * devuelve en una respuesta (varias guías por pedido), y esa respuesta llega
 * cortada sin avisar. Aquí no puede pasar:
 *   - con el conteo exacto (`.select(cols, { count: "exact" })`), si hay más
 *     filas que las que llegaron, el lote se parte en dos y se vuelve a leer;
 *   - sin el conteo, una respuesta de 500 filas o más se da por posiblemente
 *     cortada y se parte igual.
 * Un solo id que no cabe en una respuesta no se puede partir: se lanza el
 * error en vez de devolver una lista parcial (esa lectura va paginada).
 *
 * Las filas salen en el orden de los lotes y el primer error corta la lectura,
 * como en `courierRowsByIds`.
 */
export async function courierRowsByIdsWide<T>(ids: string[], read: (ids: string[]) => PromiseLike<{
  data: T[] | null; error: { message: string } | null; count?: number | null;
}>, batchSize: number = COURIER_ROWS_WIDE_BATCH): Promise<{ data: T[] }> {
  const readComplete = async (batch: string[]): Promise<T[]> => {
    const result = await read(batch);
    if (result.error) throw new Error(result.error.message);
    const rows = result.data ?? [];
    const cut = typeof result.count === "number" ? result.count > rows.length : rows.length >= COURIER_ROWS_SAFE_RESPONSE;
    if (!cut) return rows;
    if (batch.length === 1) throw new Error("Una lectura por lotes trajo más filas de las que caben en una respuesta para un solo id: tiene que ir paginada.");
    const half = Math.ceil(batch.length / 2);
    const [first, second] = await Promise.all([readComplete(batch.slice(0, half)), readComplete(batch.slice(half))]);
    return [...first, ...second];
  };
  return { data: await inConcurrentBatches(ids, batchSize, readComplete) };
}
