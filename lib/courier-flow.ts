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
}>): Promise<{ data: T[] }> {
  const batches: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += 100) batches.push(ids.slice(offset, offset + 100));
  const results: T[][] = new Array(batches.length);
  let next = 0;
  let failed: Error | null = null;
  const worker = async () => {
    while (!failed && next < batches.length) {
      const index = next++;
      const result = await read(batches[index]!);
      if (result.error) {
        failed ??= new Error(result.error.message);
        return;
      }
      results[index] = result.data ?? [];
    }
  };
  await Promise.all(Array.from({ length: Math.min(COURIER_ROWS_CONCURRENCY, batches.length) }, worker));
  if (failed) throw failed;
  return { data: results.flat() };
}
