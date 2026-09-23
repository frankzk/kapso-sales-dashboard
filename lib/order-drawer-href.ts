// La ficha del pedido se abre desde cualquier pantalla del panel (MOM §25).
// Este archivo arma y lee las URL que la abren, sin tocar el DOM ni React,
// para que el Master, la ficha global y los enlaces compartan una sola regla.
//
// Dos convenciones conviven a propósito:
// - En el Master de Pedidos la ficha sigue siendo parte de la pantalla y se
//   abre con `?abrir=<pedido>&seccion=…`, como siempre.
// - En el resto del panel la abre la ficha global (order-drawer-host.tsx)
//   con `?ficha=<pedido>&seccion=…`. No se llama `pedido` porque Grupo GF
//   Courier ya usa `?pedido=` para preseleccionar un pedido en su lista.
//
// La sección va en la URL con el nombre que la gente usa («historial»), no con
// el nombre interno de la pestaña («actividad»).

export const MASTER_PATH = "/dashboard/pedidos";

/** Parámetro que abre la ficha global (fuera del Master). */
export const DRAWER_PARAM = "ficha";
/** Parámetro que abre la ficha dentro del Master de Pedidos. */
export const MASTER_OPEN_PARAM = "abrir";
export const SECTION_PARAM = "seccion";

export type OrderDrawerSection = "operar" | "informacion" | "historial";
export type OrderDrawerWorkspace = "operar" | "informacion" | "actividad";

const SECTIONS: readonly OrderDrawerSection[] = ["operar", "informacion", "historial"];

export function isOrderDrawerSection(value: string | null | undefined): value is OrderDrawerSection {
  return SECTIONS.includes(value as OrderDrawerSection);
}

/** Pestaña interna de la ficha para la sección que viene en la URL. */
export function workspaceForDrawerSection(section: string | null | undefined): OrderDrawerWorkspace {
  if (section === "historial") return "actividad";
  if (section === "informacion") return "informacion";
  return "operar";
}

export interface DrawerLocation {
  /** Ruta actual, p. ej. `/dashboard/despacho`. */
  pathname: string;
  /** Query actual, con o sin `?`; puede ir vacía. */
  search?: string | null;
}

// Solo la página del Master, no sus subrutas: /dashboard/pedidos/despacho,
// /almacen o /rotulos no montan la tabla y abren la ficha global como cualquier
// otra pantalla.
function isMasterPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === MASTER_PATH;
}

function paramsOf(search: string | null | undefined): URLSearchParams {
  return new URLSearchParams(search?.replace(/^\?/, "") ?? "");
}

function withQuery(pathname: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * URL que abre la ficha de `orderId` SOBRE la pantalla actual, conservando
 * los demás parámetros (filtros, pestañas, mes…). En el Master usa `abrir`.
 */
export function orderDrawerHref(orderId: string, section?: OrderDrawerSection | null, location?: DrawerLocation): string {
  const pathname = location?.pathname || MASTER_PATH;
  const params = paramsOf(location?.search);
  params.delete(DRAWER_PARAM);
  params.delete(MASTER_OPEN_PARAM);
  params.delete(SECTION_PARAM);
  params.set(isMasterPath(pathname) ? MASTER_OPEN_PARAM : DRAWER_PARAM, orderId);
  if (section && section !== "operar") params.set(SECTION_PARAM, section);
  return withQuery(pathname, params);
}

/** URL del mismo pedido abierto en el Master de Pedidos (para «Abrir en Master»). */
export function masterOrderHref(orderId: string, section?: OrderDrawerSection | null): string {
  return orderDrawerHref(orderId, section, { pathname: MASTER_PATH, search: "" });
}

/** La misma pantalla sin la ficha: lo que queda en la barra al cerrarla. */
export function closeOrderDrawerHref(location: DrawerLocation): string {
  const params = paramsOf(location.search);
  params.delete(DRAWER_PARAM);
  params.delete(SECTION_PARAM);
  return withQuery(location.pathname, params);
}

/**
 * Qué pedido pide la URL a la ficha global. Devuelve null en el Master (ahí la
 * ficha la gobierna la propia pantalla) y cuando no hay `ficha`.
 */
export function readOrderDrawerRequest(location: DrawerLocation): { orderId: string; section: OrderDrawerSection } | null {
  if (isMasterPath(location.pathname)) return null;
  const params = paramsOf(location.search);
  const orderId = params.get(DRAWER_PARAM)?.trim();
  if (!orderId) return null;
  const raw = params.get(SECTION_PARAM);
  return { orderId, section: isOrderDrawerSection(raw) ? raw : "operar" };
}
