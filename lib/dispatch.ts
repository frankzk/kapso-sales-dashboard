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

/**
 * Los dos tipos de ruta.
 *
 * - `reparto`: la caja se le entrega a un motorizado que sale a repartir. Doble
 *   cotejo: oficina arma la caja y el motorizado confirma lo que recibe.
 * - `entrega_courier`: Aliclik recoge, o la caja se lleva a la agencia. Hay
 *   cotejo de oficina, pero el segundo no existe porque nadie del otro lado
 *   escanea; se cierra anotando quién recogió.
 */
export const DISPATCH_ROUTE_KINDS = ["reparto", "entrega_courier"] as const;
export type DispatchRouteKind = (typeof DISPATCH_ROUTE_KINDS)[number];

export const ROUTE_KIND_LABELS: Record<DispatchRouteKind, string> = {
  reparto: "Ruta de reparto",
  entrega_courier: "Entrega al courier",
};

/** ¿Esta ruta termina con el cotejo del motorizado? */
export function needsRiderCheck(kind: DispatchRouteKind): boolean {
  return kind === "reparto";
}

/** Fecha corta de una ruta, como se lee en su tarjeta: `03/08`. */
export function routeDay(routeDate: string): string {
  return routeDate.slice(5).split("-").reverse().join("/");
}

/**
 * Cómo se nombra una ruta dentro de una frase: «Roy · 03/08».
 *
 * Es el texto de la confirmación antes de asignar, y lo que identifica una ruta
 * es **quién se lleva la caja y qué día**. El nombre de la zona («Surco», «San
 * Isidro») se omite a propósito: no distingue nada —dos rutas del mismo día
 * pueden cubrir la misma zona— y alargar la frase resta fuerza a lo único que
 * importa no confundir, que es la persona.
 *
 * Sin persona asignada sí se cae al nombre de la ruta: una fecha sola no
 * identifica nada.
 */
export function routeName(manifest: {
  driver_name?: string | null;
  received_by?: string | null;
  route_label: string;
  route_date: string;
}): string {
  const who = manifest.received_by ?? manifest.driver_name;
  return [who || manifest.route_label, routeDay(manifest.route_date)].filter(Boolean).join(" · ");
}

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

/**
 * Estado derivado de la ruta. `in_custody` solo llega desde la confirmación
 * atómica del servidor.
 *
 * En una `entrega_courier` no hay segundo cotejo —Aliclik recoge, o la caja se
 * lleva a la agencia, y nadie del otro lado escanea—, así que la ruta se queda
 * en «Listo para recojo» hasta que se cierra anotando quién recogió. Sin esta
 * distinción esas rutas esperaban para siempre un cotejo imposible.
 */
export function deriveDispatchManifestState(
  items: readonly DispatchProgressItem[],
  current: DispatchManifestState,
  kind: DispatchRouteKind = "reparto",
): DispatchManifestState {
  if (current === "cancelled" || current === "in_custody") return current;
  const progress = dispatchProgress(items);
  if (!progress.total) return "draft";
  if (!progress.officeComplete) return "office_check";
  if (!needsRiderCheck(kind)) return "ready_for_pickup";
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

