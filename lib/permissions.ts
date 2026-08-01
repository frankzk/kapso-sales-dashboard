// Permisos finos del Master de Pedidos. Puro + testeado.
//
// La especificación (§16 y "Acceso restringido a la clave") pide permisos por
// acción — `shalom.view_pickup_key`, `shalom.register_payment`, … — pero el
// sistema solo tiene cuatro roles (`memberships.role`). Se resuelve en dos
// capas:
//
//   1. Un mapa rol → permisos, aquí, puro y testeable. Cubre el 100 % de los
//      casos normales.
//   2. Concesiones y revocaciones puntuales por usuario (tabla
//      `user_permissions`), para las excepciones, sin tener que tocar código.
//
// Regla que no se negocia: **Viewer no modifica nada**. Consulta pedidos,
// filtra, abre el detalle, lee comentarios e historial — y nada más.

export const PERMISSIONS = [
  // Master de Pedidos
  "master.edit", // registrar estados, comentarios, devoluciones, corregir vínculos
  "master.override_status", // cambiar el estado de un pedido ya cerrado (entregado/anulado/devuelto)
  "master.import_report", // cargar reportes de couriers
  // Preparación y despacho físico (MOM Fase 2)
  "warehouse.prepare", // escanear y dejar una salida lista para despacho
  "dispatch.manage", // crear rutas, cotejar en oficina y retirar paquetes
  "dispatch.pickup", // segundo cotejo del motorizado y transferencia de custodia
  // Pagos Yape / clave de recojo Shalom
  "shalom.register_payment",
  "shalom.validate_payment",
  "shalom.reveal_pickup_key",
  "shalom.view_pickup_key",
  "shalom.override_payment_validation",
  // Crear una preguía real y cobrable mediante la API directa de Shalom.
  "shalom.create_guide",
  // Costos
  "costs.manage",
  // Aliclik: crear una guía es una escritura hacia AFUERA e irreversible, con
  // ventanas de cancelación estrictas. Por eso tiene permiso propio y no cae
  // bajo `master.edit`.
  "aliclik.create_guide",
  "aliclik.cancel_guide",
  "aliclik.manage_catalog",
  // Tanders: mismo razonamiento que Aliclik —escritura hacia afuera, con un
  // paquete real detrás— pero permiso propio: son couriers distintos y una
  // tienda puede querer habilitar uno sin el otro.
  "tanders.create_guide",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Permisos por rol.
 *
 *  - `owner` / `admin` — todo, incluidas las excepciones auditadas.
 *  - `vendedora` — opera: registra estados, comentarios y comprobantes. NO
 *    valida pagos ni ve la clave de recojo (§"Acceso restringido a la clave":
 *    la clave es para administradores, y los demás solo pueden pedirla cuando el
 *    pago completo está validado). Sí crea guías en Aliclik y en Tanders —es su
 *    trabajo— pero NO las cancela ni toca el catálogo: cancelar tiene ventana y
 *    el catálogo es dato maestro compartido por todas las tiendas.
 *  - `viewer` — nada.
 */
const ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  vendedora: [
    "master.edit",
    "master.import_report",
    "warehouse.prepare",
    "dispatch.manage",
    "dispatch.pickup",
    "shalom.register_payment",
    "shalom.reveal_pickup_key",
    "shalom.create_guide",
    "aliclik.create_guide",
    "tanders.create_guide",
  ],
  viewer: [],
};

/** Concesión o revocación explícita para un usuario concreto. */
export interface PermissionGrant {
  permission: string;
  /** false = revocada aunque el rol la conceda. */
  granted?: boolean;
}

/**
 * Permisos efectivos de un usuario: la unión de los de sus roles, más las
 * concesiones explícitas, menos las revocaciones explícitas (que ganan siempre —
 * si alguien quiso quitarle un permiso a una persona, el rol no debe devolvérselo).
 */
export function permissionsFor(
  roles: readonly string[],
  grants: readonly PermissionGrant[] = [],
): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of roles) {
    for (const p of ROLE_PERMISSIONS[role] ?? []) out.add(p);
  }
  for (const g of grants) {
    if (!isPermission(g.permission)) continue;
    if (g.granted === false) out.delete(g.permission);
    else out.add(g.permission);
  }
  return out;
}

export function hasPermission(
  roles: readonly string[],
  permission: Permission,
  grants: readonly PermissionGrant[] = [],
): boolean {
  return permissionsFor(roles, grants).has(permission);
}

/**
 * ¿Este usuario es solo-lectura en el Master? Cierto para `viewer` puro y para
 * cualquiera cuyos permisos de edición hayan sido revocados. Un usuario SIN
 * ningún rol tampoco edita (no debería llegar aquí: RLS ya lo dejaría sin
 * tiendas, pero el guard no depende de eso).
 */
export function isReadOnly(
  roles: readonly string[],
  grants: readonly PermissionGrant[] = [],
): boolean {
  return !hasPermission(roles, "master.edit", grants);
}

/** Etiqueta legible del rol, para la cabecera del panel. */
export function roleLabel(roles: readonly string[]): string {
  if (roles.includes("owner") || roles.includes("admin")) return "Administrador";
  if (roles.length && roles.every((r) => r === "vendedora")) return "Vendedora";
  if (roles.length && roles.every((r) => r === "viewer")) return "Solo lectura";
  return "Equipo";
}
