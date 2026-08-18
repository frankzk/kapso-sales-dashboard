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
  // Cierre MOM (Fase 4). Se separan porque una persona puede recibir una caja
  // sin tener permiso para conciliar dinero o ejecutar un reembolso.
  "closure.return", // solicitar/recibir retornos y devoluciones de cliente
  "closure.inventory", // reingreso a inventario o cierre como merma
  "closure.finance", // observar/cerrar liquidaciones e indemnizaciones
  "closure.finalize", // cerrar o reabrir el expediente operativo
  "closure.refund", // confirmar que el reembolso externo ya fue ejecutado
  // Pagos Yape / clave de recojo Shalom
  "shalom.register_payment",
  // Permiso transversal de pagos. Se concede persona por persona desde Equipo;
  // no viene incluido en ningun rol para que cambiar a alguien a admin no le
  // permita validar movimientos bancarios de forma implicita.
  "payments.validate",
  // Nombre historico. Se conserva para poder migrar concesiones existentes,
  // pero las acciones nuevas usan `payments.validate`.
  "shalom.validate_payment",
  // Ver la clave cuando el cobro cumple las reglas operativas. Es distinto de
  // administrarla o forzar una excepción: las vendedoras pueden usar este
  // permiso sin poder registrar/reemplazar claves ni saltarse bloqueos.
  "shalom.reveal_pickup_key",
  "shalom.view_pickup_key",
  "shalom.override_payment_validation",
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
  // Shalom por API (0061). Ojo con la vecindad: los `shalom.*` de arriba son del
  // flujo de cobro y de la clave de recojo. Este es el de crear la preguía, que
  // es una escritura hacia afuera y cobrable — mismo criterio que Aliclik y
  // Tanders. Crear la guía NO implica poder ver la clave que la acompaña.
  "shalom.create_guide",
  // Dar por bueno un cobro que el lector de comprobantes rechazó. Es la única
  // forma de levantar el bloqueo, así que NO cae bajo `master.edit`: quien
  // revisa un posible Yape a otra cuenta no puede ser cualquiera que pueda
  // tocar el pedido. Solo owner/admin.
  "tanders.review_payment",
  // Liquidaciones de motorizados
  "settlements.manage", // cargar liquidaciones y corregir vínculos
  "settlements.close", // congelar el pago al motorizado: no se deshace
  // Rutas de reparto
  "routes.manage", // armar la ruta del día y asignarla
  "routes.deliver", // reportar SUS propias paradas desde /reparto
  // Recuperación del pedido devuelto (0112): escribirle a la clienta cuya guía
  // volvió, proponiéndole el reenvío por agencia con adelanto. Permiso propio y
  // no `master.edit` por el mismo motivo que las guías: es una escritura hacia
  // AFUERA e irreversible —el mensaje sale del WhatsApp de la tienda y pide
  // plata por adelantado—, y un envío desafortunado no se retira: se reporta, y
  // los reportes le cuestan la plantilla a toda la tienda.
  "recovery.contact",
  // Registro de motorizados: alta/edición de la ficha y vínculo con un usuario
  // para dar acceso a /reparto. Vive en Equipo (owner/admin). El alta rápida por
  // nombre desde Liquidaciones sigue bajo settlements.manage.
  "riders.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Permisos por rol.
 *
 *  - `owner` / `admin` — todo, incluidas las excepciones auditadas.
 *  - `vendedora` — opera: registra estados, comentarios y comprobantes. Puede
 *    revelar la clave solo por el circuito auditado cuando el cobro alcanza el
 *    total; NO valida pagos, registra/reemplaza claves ni fuerza excepciones.
 *    Sí crea guías en Aliclik, Tanders y Shalom
 *    —es su trabajo— pero NO las cancela ni toca el catálogo: cancelar tiene
 *    ventana y el catálogo es dato maestro compartido por todas las tiendas.
 *    Que cree la guía de Shalom no le da acceso a la clave de recojo: la clave
 *    la genera el servidor y solo se revela por el circuito auditado de pagos.
 *  - `viewer` — nada.
 */
const ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  // El owner conserva la capacidad financiera por continuidad operativa, pero
  // puede revocarsela explicitamente cuando ya exista otro validador.
  owner: PERMISSIONS.filter((permission) => permission !== "shalom.validate_payment"),
  // Solo el owner (Frankz en la operación actual) confirma reembolsos. Un
  // administrador conserva el resto de facultades de cierre.
  admin: PERMISSIONS.filter(
    (permission) =>
      permission !== "closure.refund" &&
      permission !== "payments.validate" &&
      permission !== "shalom.validate_payment",
  ),
  // La vendedora carga la liquidación y corrige vínculos, pero NO la cierra:
  // cerrar congela lo que se le paga al motorizado y no se deshace.
  vendedora: [
    "master.edit",
    "master.import_report",
    "warehouse.prepare",
    "dispatch.manage",
    "dispatch.pickup",
    "closure.return",
    "closure.inventory",
    "shalom.register_payment",
    "shalom.reveal_pickup_key",
    "aliclik.create_guide",
    "tanders.create_guide",
    "shalom.create_guide",
    "settlements.manage",
    // Recuperar una devolución es gestión de venta, que es su trabajo: la misma
    // persona que llamaría a esa clienta es la que manda el mensaje.
    "recovery.contact",
    // Coordinar el reparto es operativo, no financiero: arma la ruta del día.
    "routes.manage",
  ],
  viewer: [],
  // El motorizado NO es un usuario del panel: entra a /reparto, ve solo su ruta
  // y reporta sus paradas. No lee el Master, no ve pedidos que no sean suyos y
  // no toca liquidaciones — la suya la cierra el coordinador.
  motorizado: ["routes.deliver"],
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
  const hasNewPaymentGrant = grants.some((grant) => grant.permission === "payments.validate");
  for (const g of grants) {
    if (!isPermission(g.permission)) continue;
    if (g.granted === false) out.delete(g.permission);
    else out.add(g.permission);
    // Compatibilidad sin migracion: una excepcion individual guardada con el
    // nombre historico sigue funcionando hasta que Equipo escriba el nuevo
    // permiso. Una fila nueva siempre gana y evita dos fuentes de verdad.
    if (g.permission === "shalom.validate_payment" && !hasNewPaymentGrant) {
      if (g.granted === false) out.delete("payments.validate");
      else out.add("payments.validate");
    }
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
  if (roles.length && roles.every((r) => r === "motorizado")) return "Motorizado";
  if (roles.length && roles.every((r) => r === "viewer")) return "Solo lectura";
  return "Equipo";
}
