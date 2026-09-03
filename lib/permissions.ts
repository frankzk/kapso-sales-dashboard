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
  // Reasignar un pago a otro pedido o forzar su estado. Se concede persona por
  // persona, igual que `payments.validate`: mover dinero de un pedido a otro es
  // de la misma familia que darlo por bueno, y venía incluido en el rol `admin`
  // —catorce personas— sin que nadie lo hubiera decidido.
  "shalom.override_payment_validation",
  // Costos
  "costs.manage",
  // Grupo GF Courier: contratos, tarifas, clientes y parámetros operativos.
  // Se concede persona por persona porque Daysi debe administrarlo sin recibir
  // acceso implícito a todas las facultades financieras de un admin.
  "logistics.manage",
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
  // Swayp: resolver una novedad (estado 6) es responderle al mensajero que está
  // parado frente a la puerta —volver a ofrecer, devolver o reprogramar—. Es una
  // escritura hacia AFUERA que mueve un paquete real, así que sigue el criterio
  // de Aliclik/Tanders/Shalom y no cae bajo `master.edit`.
  //
  // OJO con la acción 2 (devolver al remitente): termina el intento de entrega y
  // dispara la devolución física, que en Swayp se recoge cada semana o quincena
  // (MOM §9.4). Por eso la acción exige ADEMÁS `closure.return`, que ya significa
  // exactamente eso —"solicitar/recibir retornos"— en vez de inventar un permiso
  // nuevo. Hoy la vendedora tiene los dos, así que nadie pierde capacidad; lo que
  // se gana es que quitarle `closure.return` a alguien también le impida cerrar
  // una entrega por esta puerta lateral.
  "swayp.solve_novelty",
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
  // Declarar qué producto vende un anuncio de Meta (0139). No es edición de un
  // lead: cambia cómo se lee la cola ENTERA de esa tienda —los 460 leads del
  // anuncio de la caspa caen o no caen en «Shampoo Birú» según esta firma—, y
  // firmar mal manda a toda la mesa con el argumentario equivocado. Por eso es
  // propio y no cae bajo la gestión diaria de la cola.
  "leads.map_ads",
  // Crear un pedido desde el dashboard. NO es gestión de la cola: `draftOrderCreate`
  // + `completeDraftOrder` escriben hacia AFUERA y crean un pedido real en
  // Shopify, con su stock descontado y su guía por delante. Mismo criterio que
  // las guías de Aliclik, Tanders y Shalom: quien puede leer la cola no queda
  // habilitado por eso a vender a nombre de la tienda.
  "orders.create",
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
/**
 * Permisos que no vienen con el rol `admin` y se conceden persona por persona
 * desde Equipo. El `owner` los conserva por continuidad operativa y puede
 * revocárselos a sí mismo cuando ya haya otra persona con ellos.
 *
 * POR QUÉ EXISTE LA LISTA, Y NO SOLO LA COSTUMBRE. `payments.validate` ya se
 * trataba así, pero la regla vivía en un comentario y en tres `.in([...])`
 * escritos a mano —la consulta de Equipo, la de sus acciones y el `upsert`—.
 * Añadir el segundo permiso a esa manera de hacerlo habría sido escribir la
 * misma lista en un cuarto sitio.
 *
 * De acá salen las dos cosas a la vez: qué se descuenta del rol `admin` y qué
 * casillas dibuja Equipo. Así no puede haber un permiso que se quite del rol y
 * nadie pueda conceder — que lo dejaría sin poder ejercer NADIE.
 */
export const GRANTED_ONE_BY_ONE = [
  {
    permission: "payments.validate",
    label: "Validar pagos",
    /** Lo que se le dice a quien concede, no el nombre técnico. */
    description: "Dar por bueno un comprobante y el dinero que representa.",
    /** Sin nadie con este permiso, la cola de validación se queda parada. */
    lastOneMatters: true,
  },
  {
    permission: "shalom.override_payment_validation",
    label: "Corregir pagos",
    description: "Mover un pago al pedido correcto o forzar su estado.",
    lastOneMatters: true,
  },
  {
    permission: "logistics.manage",
    label: "Administrar Grupo GF Courier",
    description: "Gestionar clientes, tarifas y parámetros del operador logístico.",
    lastOneMatters: false,
  },
] as const satisfies readonly {
  permission: Permission;
  label: string;
  description: string;
  lastOneMatters: boolean;
}[];

const ONE_BY_ONE: ReadonlySet<string> = new Set(
  GRANTED_ONE_BY_ONE.map((entry) => entry.permission),
);

/** ¿Este permiso se concede a mano en vez de venir con el rol? */
export function isGrantedOneByOne(permission: string): boolean {
  return ONE_BY_ONE.has(permission);
}

const ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  // El owner conserva la capacidad financiera por continuidad operativa, pero
  // puede revocarsela explicitamente cuando ya exista otro validador.
  // El owner los conserva TODOS, también los de concesión individual: es la
  // continuidad operativa, y puede revocárselos explícitamente cuando ya exista
  // otra persona con el permiso. Descontárselos acá le habría quitado la
  // capacidad de validar que ya tenía — lo cazaron las pruebas.
  owner: PERMISSIONS.filter((permission) => permission !== "shalom.validate_payment"),
  // Solo el owner (Frankz en la operación actual) confirma reembolsos. Un
  // administrador conserva el resto de facultades de cierre.
  admin: PERMISSIONS.filter(
    (permission) =>
      permission !== "closure.refund" &&
      permission !== "shalom.validate_payment" &&
      // Los de concesión individual se descuentan desde la lista, no uno a uno:
      // enumerarlos acá era lo que dejó a `shalom.override_payment_validation`
      // dentro del rol `admin` —catorce personas— cuando `payments.validate` ya
      // se había sacado por la misma razón.
      !ONE_BY_ONE.has(permission),
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
    // Gestionar la novedad es gestión de venta: la misma persona que llamaría a
    // la clienta para preguntarle por qué no abrió es la que le dice al mensajero
    // si vuelve a intentarlo o reprograma. Mismo criterio que `recovery.contact`.
    "swayp.solve_novelty",
    "settlements.manage",
    // Recuperar una devolución es gestión de venta, que es su trabajo: la misma
    // persona que llamaría a esa clienta es la que manda el mensaje.
    "recovery.contact",
    // Coordinar el reparto es operativo, no financiero: arma la ruta del día.
    "routes.manage",
    // Generar el pedido ES su trabajo: la vendedora cierra la venta por teléfono
    // o por WhatsApp y la registra. El permiso existe para que tenerlo sea una
    // decisión —un `viewer` no vende a nombre de la tienda—, no para quitárselo
    // a quien vive de eso.
    "orders.create",
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
    // Compatibilidad sin migracion: una concesion historica sigue habilitando
    // la bandeja hasta que Equipo escriba el permiso nuevo. Una revocacion del
    // permiso historico NO puede retirar `payments.validate`: aquel permiso era
    // exclusivo de Shalom y no representa una decision sobre la nueva bandeja
    // transversal. Una fila nueva siempre gana y evita dos fuentes de verdad.
    if (g.permission === "shalom.validate_payment" && !hasNewPaymentGrant) {
      if (g.granted !== false) out.add("payments.validate");
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
