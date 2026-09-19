// La caja del motorizado se abre al lado de la lista de Rutas (MOM §29.14),
// como la ficha del pedido (lib/order-drawer-href.ts): un parámetro en la
// URL, un host que lo lee y cerrar con `replaceState` conservando el resto
// de la query. Sin React ni DOM aquí, para que la lista, el panel y los
// enlaces antiguos (`/dashboard/courier/rutas?manifiesto=`) compartan una
// sola regla.
//
// Dos parámetros porque hay dos identidades:
// - `caja=<manifiesto>`: una carga de despacho (tiene los tres pasos).
// - `ruta=<ruta de reparto>`: una ruta sin caja, por ejemplo las que trajo
//   el cuaderno (§29.12). El panel enseña la ruta y lleva a su reparto.
// Cuando una fila tiene caja, gana `caja`.

export const BOX_PARAM = "caja";
export const ROUTE_PARAM = "ruta";
export const COURIER_PATH = "/dashboard/courier";
export const ROUTES_TAB_HREF = `${COURIER_PATH}?tab=routes`;

export interface BoxLocation {
  pathname: string;
  search?: string | null;
}

export type CourierBoxRequest = { kind: "caja"; manifestId: string } | { kind: "ruta"; routeId: string };

function paramsOf(search: string | null | undefined): URLSearchParams {
  return new URLSearchParams(search?.replace(/^\?/, "") ?? "");
}

function withQuery(pathname: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function clear(params: URLSearchParams): void {
  params.delete(BOX_PARAM);
  params.delete(ROUTE_PARAM);
}

/** URL que abre la caja `manifestId` SOBRE la pantalla actual. */
export function courierBoxHref(manifestId: string, location?: BoxLocation): string {
  const params = paramsOf(location?.search);
  clear(params);
  params.set(BOX_PARAM, manifestId);
  return withQuery(location?.pathname || COURIER_PATH, params);
}

/** URL que abre una ruta sin caja SOBRE la pantalla actual. */
export function courierRouteDrawerHref(routeId: string, location?: BoxLocation): string {
  const params = paramsOf(location?.search);
  clear(params);
  params.set(ROUTE_PARAM, routeId);
  return withQuery(location?.pathname || COURIER_PATH, params);
}

/** La misma pantalla sin el panel: lo que queda en la barra al cerrarlo. */
export function closeCourierBoxHref(location: BoxLocation): string {
  const params = paramsOf(location.search);
  clear(params);
  return withQuery(location.pathname, params);
}

/** Qué pide la URL al panel; null cuando no pide nada. */
export function readCourierBoxRequest(location: BoxLocation): CourierBoxRequest | null {
  const params = paramsOf(location.search);
  const manifestId = params.get(BOX_PARAM)?.trim();
  if (manifestId) return { kind: "caja", manifestId };
  const routeId = params.get(ROUTE_PARAM)?.trim();
  if (routeId) return { kind: "ruta", routeId };
  return null;
}

/**
 * Destino de los enlaces antiguos a `/dashboard/courier/rutas?manifiesto=…`:
 * la pestaña Rutas con esa caja abierta.
 */
export function legacyManifestHref(manifestId: string | null | undefined, base: string = ROUTES_TAB_HREF): string {
  if (!manifestId) return base;
  const [pathname, search] = base.split("?");
  return courierBoxHref(manifestId, { pathname: pathname || COURIER_PATH, search: search ?? "" });
}
