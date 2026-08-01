export const DISPATCH_MANIFEST_STATES = [
  "draft",
  "office_check",
  "ready_for_pickup",
  "pickup_check",
  "in_custody",
  "cancelled",
] as const;

export type DispatchManifestState = (typeof DISPATCH_MANIFEST_STATES)[number];
export type DispatchScanStage = "office" | "pickup";

export interface DispatchProgressItem {
  removed_at?: string | null;
  office_checked_at?: string | null;
  pickup_checked_at?: string | null;
}

export interface DispatchProgress {
  total: number;
  officeChecked: number;
  pickupChecked: number;
  officeComplete: boolean;
  pickupComplete: boolean;
  percent: number;
}

export function activeDispatchItems<T extends DispatchProgressItem>(items: readonly T[]): T[] {
  return items.filter((item) => !item.removed_at);
}

export function dispatchProgress(items: readonly DispatchProgressItem[]): DispatchProgress {
  const active = activeDispatchItems(items);
  const total = active.length;
  const officeChecked = active.filter((item) => !!item.office_checked_at).length;
  const pickupChecked = active.filter((item) => !!item.pickup_checked_at).length;
  return {
    total,
    officeChecked,
    pickupChecked,
    officeComplete: total > 0 && officeChecked === total,
    pickupComplete: total > 0 && pickupChecked === total,
    percent: total ? Math.round((pickupChecked / total) * 100) : 0,
  };
}

/** Estado derivado de la ruta. `in_custody` solo llega desde la confirmación atómica del servidor. */
export function deriveDispatchManifestState(
  items: readonly DispatchProgressItem[],
  current: DispatchManifestState,
): DispatchManifestState {
  if (current === "cancelled" || current === "in_custody") return current;
  const progress = dispatchProgress(items);
  if (!progress.total) return "draft";
  if (!progress.officeComplete) return "office_check";
  if (progress.pickupChecked === 0) return "ready_for_pickup";
  return "pickup_check";
}

export const DISPATCH_STATE_LABELS: Record<DispatchManifestState, string> = {
  draft: "Borrador",
  office_check: "Cotejo de oficina",
  ready_for_pickup: "Listo para recojo",
  pickup_check: "Cotejo del motorizado",
  in_custody: "En poder del courier",
  cancelled: "Cancelada",
};

/**
 * Los lectores USB suelen escribir el valor completo y Enter. La cámara puede
 * entregar una URL o el token desnudo. Conservamos solo el identificador final.
 */
export function normalizeDispatchScan(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    const fromQuery = url.searchParams.get("qr") ?? url.searchParams.get("code");
    if (fromQuery) return fromQuery.trim();
    const last = url.pathname.split("/").filter(Boolean).at(-1);
    if (last) return decodeURIComponent(last).trim();
  } catch {
    // No era una URL; es el caso normal de un lector de código de barras.
  }
  return value.replace(/^#+/, "").trim();
}

export function courierKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

