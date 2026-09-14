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

export async function courierRowsByIds<T>(ids: string[], read: (ids: string[]) => PromiseLike<{
  data: T[] | null; error: { message: string } | null;
}>): Promise<{ data: T[] }> {
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const result = await read(ids.slice(offset, offset + 100));
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data ?? []));
  }
  return { data: rows };
}
