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
  // Comprobantes electrónicos por RUC (MOM §35.7, 14-10-2026): dar de alta un
  // RUC con su token de SimpleFact, cambiar su modo, su «Emitir desde» y su
  // tope, asignarle cuentas de cobro, registrar un comprobante emitido fuera de
  // Kapta, pedir un reintento y liberar un `en_duda`. Es dinero y es fiscal:
  // pasar un RUC a «Real» o darle una cuenta decide qué empresa paga el
  // impuesto de qué venta, y una boleta que llegó a SUNAT no se borra. Por eso
  // no cae bajo `stores.manage` —que Ajustes pide además— y se concede persona
  // por persona: solo el dueño. Emitir no es parte del permiso: lo hace solo el
  // barrido, y no hay botón para forzarlo.
  "invoices.manage",
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
  // Liquidaciones 2 (0176, MOM §30). `sheets.edit` escribe celdas manuales y
  // abre/resuelve observaciones de cuadre; `sheets.manage` configura dominios,
  // hojas, columnas y equivalencias de estado. Configurar cambia lo que ven y
  // calculan todas las hojas, por eso queda en admin/owner.
  "sheets.edit",
  "sheets.manage",
  // Rutas de reparto
  "routes.manage", // armar la ruta del día y asignarla
  "routes.deliver", // reportar SUS propias paradas desde /reparto
  "routes.report_others", // reportar por un motorizado, con actor y motivo propios
  // Recibir la alerta urgente de «comprobante repetido» (0226): el mismo pago
  // en más de un pedido. Se concede persona por persona desde Equipo, porque es
  // a quién se le avisa — no una facultad del rol.
  "alerts.repeated_voucher",
  // Recuperación del pedido devuelto (0112): escribirle a la clienta cuya guía
  // volvió, proponiéndole el reenvío por agencia con adelanto. Permiso propio y
  // no `master.edit` por el mismo motivo que las guías: es una escritura hacia
  // AFUERA e irreversible —el mensaje sale del WhatsApp de la tienda y pide
  // plata por adelantado—, y un envío desafortunado no se retira: se reporta, y
  // los reportes le cuestan la plantilla a toda la tienda.
  "recovery.contact",
  // «Repro Lima» (MOM §9.5, 13-10-2026): llamar al cliente de Lima con entrega
  // fallida y dejar el acuerdo, que Kapta programa en Grupo GF. Es de quien
  // llama —la Asesora— y de quien despacha: permiso propio para que el rol
  // «Asesora» lo traiga sin traer Despacho del día (`dispatch.manage`).
  "repro_lima.manage",
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
  // Descargar en Excel/CSV el Master de Pedidos, los pedidos o el resumen
  // diario (08-10-2026). Una descarga es la base de clientes entera —nombre,
  // teléfono, distrito y monto de ~28.000 pedidos— en un clic, y ninguna
  // vendedora la necesita para trabajar: ve en pantalla lo que gestiona. Viene
  // con owner y admin; a una vendedora de confianza se le concede en Equipo.
  "data.export",
  // Lo que hasta el 12-10-2026 se preguntaba como «¿es owner o admin?» en el
  // código, en vez de pedir un permiso (MOM §16). Vienen con owner y admin, así
  // que para ellos nada cambia; existen para que el rol «Administración» o
  // «Supervisión» los dé sin hacer admin a nadie.
  "team.manage", // Equipo: invitar y quitar vendedoras y solo lectura, tiendas por persona, horarios, motorizados
  "stores.manage", // Tiendas: conectar, ajustes, ciclo de confirmación y procesos masivos de la tienda
  "stock.manage", // Stock Swayp y Fénix: cargar, mover e importar inventario
  "reports.view", // Consolidado, panel de cada tienda y productividad de todo el equipo
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Glosario de Equipo (13-10-2026, MOM §16). Cada permiso con el nombre que se
// lee en pantalla, lo que deja hacer en una línea y el área donde vive. Los
// nombres los aprobó el dueño: «Registrar comprobantes» no decía que era subir
// el Yape, y tres permisos se llamaban «liquidaciones» sin decir cuál era cuál.
// Un nombre por permiso y sin repetir (lo fija una prueba).
// ---------------------------------------------------------------------------

/** Cómo se llama cada permiso en Equipo: verbo y objeto, sin jerga interna. */
export const PERMISSION_LABEL: Record<Permission, string> = {
  "master.edit": "Gestionar pedidos",
  "master.override_status": "Corregir pedidos cerrados",
  "master.import_report": "Subir reportes de couriers",
  "warehouse.prepare": "Preparar paquetes",
  "dispatch.manage": "Despachar",
  "dispatch.pickup": "Entregar la caja al motorizado",
  "closure.return": "Recibir devoluciones",
  "closure.inventory": "Reingresar al inventario",
  "closure.finance": "Conciliar el dinero del pedido",
  "closure.finalize": "Cerrar o reabrir pedidos",
  "closure.refund": "Confirmar reembolsos",
  "shalom.register_payment": "Subir comprobantes",
  "payments.validate": "Validar pagos",
  "shalom.validate_payment": "Validar pagos (permiso antiguo)",
  "shalom.reveal_pickup_key": "Ver la clave de recojo",
  "shalom.view_pickup_key": "Registrar claves de recojo",
  "shalom.override_payment_validation": "Corregir pagos",
  "invoices.manage": "Boletas y facturas",
  "costs.manage": "Editar costos",
  "logistics.manage": "Administrar Grupo GF",
  "aliclik.create_guide": "Crear guías de Aliclik",
  "aliclik.cancel_guide": "Anular guías de Aliclik",
  "aliclik.manage_catalog": "Editar el catálogo de Aliclik",
  "tanders.create_guide": "Crear guías de Tanders",
  "shalom.create_guide": "Crear guías de Shalom",
  "swayp.solve_novelty": "Responder novedades de Swayp",
  "tanders.review_payment": "Aprobar cobros de Tanders rechazados",
  "settlements.manage": "Subir liquidaciones de motorizados",
  "settlements.close": "Cerrar liquidaciones de motorizados",
  "sheets.edit": "Cuadrar hojas de couriers",
  "sheets.manage": "Configurar hojas de couriers",
  "routes.manage": "Armar rutas",
  "routes.deliver": "Reportar su propia ruta",
  "routes.report_others": "Reportar entregas por un motorizado",
  "alerts.repeated_voucher": "Alerta de comprobante repetido",
  "recovery.contact": "Escribir a clientas con devolución",
  "repro_lima.manage": "Reprogramar entregas en Lima",
  "riders.manage": "Dar de alta motorizados",
  "leads.map_ads": "Asignar producto a anuncios",
  "orders.create": "Crear pedidos en Shopify",
  "data.export": "Descargar la base de pedidos",
  "team.manage": "Gestionar el equipo",
  "stores.manage": "Administrar tiendas",
  "stock.manage": "Manejar stock de Swayp y Fénix",
  "reports.view": "Ver reportes del negocio",
};

/** Lo que deja hacer cada permiso, en una línea que se lee sin pasar el ratón. */
export const PERMISSION_HELP: Record<Permission, string> = {
  "master.edit": "Confirmar, cambiar el estado, comentar, crear salidas y corregir vínculos, en el Master y en Repro Provincia.",
  "master.override_status": "Cambiar un pedido que ya está entregado, anulado o devuelto. Pide un motivo.",
  "master.import_report": "Subir el archivo del courier que actualiza el estado de las guías.",
  "warehouse.prepare": "Escanear el paquete y dejarlo listo para despacho.",
  "dispatch.manage": "El Despacho del día: armar cajas, verificarlas en oficina, asignar motorizado y sacar paquetes.",
  "dispatch.pickup": "Escanear la caja cuando el motorizado se la lleva.",
  "closure.return": "Registrar que el paquete volvió a la oficina.",
  "closure.inventory": "Devolver el producto al inventario o darlo por perdido (merma).",
  "closure.finance": "Marcar que el cobro y el costo del courier cuadran, observar diferencias y pedir indemnizaciones a Aliclik.",
  "closure.finalize": "Dar un pedido por terminado o reabrirlo.",
  "closure.refund": "Confirmar que el reembolso a la clienta ya se hizo.",
  "shalom.register_payment": "Adjuntar el Yape o la transferencia al pedido. No lo da por bueno: eso es validar.",
  "payments.validate": "Confirmar que el dinero llegó a la cuenta.",
  "shalom.validate_payment": "Nombre anterior de «Validar pagos». Ya no se concede.",
  "shalom.reveal_pickup_key": "Ver la clave de Shalom cuando el pedido está pagado completo. Queda registrado quién la vio.",
  "shalom.view_pickup_key": "Guardar o reemplazar la clave de recojo de Shalom y verla siempre.",
  "shalom.override_payment_validation": "Pasar un pago a otro pedido o forzar su estado.",
  "invoices.manage": "Configurar cada RUC de SimpleFact con su token y su modo, asignarle cuentas de cobro y registrar boletas emitidas fuera de Kapta.",
  "costs.manage": "Costos de producto, tarifas y gastos adicionales.",
  "logistics.manage": "Tarifas, clientes, pago de motorizados y exceso de efectivo del Grupo GF.",
  "aliclik.create_guide": "Crear la guía en Aliclik. Sale de verdad hacia el courier.",
  "aliclik.cancel_guide": "Anular una guía de Aliclik dentro del plazo que da el courier.",
  "aliclik.manage_catalog": "Vincular cada producto de la tienda con el suyo en Aliclik. Sin eso no se crean guías.",
  "tanders.create_guide": "Crear la guía en Tanders. Sale de verdad hacia el courier.",
  "shalom.create_guide": "Crear la guía en Shalom. No da acceso a la clave de recojo.",
  "swayp.solve_novelty": "Decirle al mensajero de Swayp si reintenta, reprograma o devuelve el paquete.",
  "tanders.review_payment": "Destrabar un comprobante de Tanders que el lector marcó como sospechoso, por ejemplo un Yape a otra cuenta.",
  "settlements.manage": "Cargar la liquidación de un motorizado y corregir sus vínculos.",
  "settlements.close": "Congelar lo que se le paga al motorizado. No se deshace.",
  "sheets.edit": "En Liquidaciones 2, llenar celdas y resolver las observaciones del cuadre.",
  "sheets.manage": "Las hojas, columnas y equivalencias de estado de Liquidaciones 2.",
  "routes.manage": "Armar la ruta del día de cada motorizado y asignársela.",
  "routes.deliver": "Reportar sus propias paradas desde el celular. Es del motorizado.",
  "routes.report_others": "Marcar entregado o no entregado en nombre del motorizado, con evidencia y motivo.",
  "alerts.repeated_voucher": "Recibir el aviso urgente cuando el mismo comprobante aparece en dos pedidos.",
  "recovery.contact": "Enviar el WhatsApp que ofrece reenviar un pedido devuelto con adelanto.",
  "repro_lima.manage": "Llamar al cliente de Lima cuya entrega falló y dejar el acuerdo. Kapta lo programa en Grupo GF.",
  "riders.manage": "Crear la ficha del motorizado y darle acceso a su ruta en el celular.",
  "leads.map_ads": "Decir qué producto vende cada anuncio de Meta, para ordenar la cola de leads.",
  "orders.create": "Crear un pedido desde Kapta. Se crea de verdad en la tienda de Shopify.",
  "data.export": "Descargar en Excel o CSV el Master de Pedidos, con nombres y teléfonos de las clientas.",
  "team.manage": "Invitar y quitar vendedoras, darles tiendas y fijar sus horarios.",
  "stores.manage": "Conectar Shopify, los ajustes de cada tienda y su ciclo de confirmación.",
  "stock.manage": "Cargar, mover e importar el inventario de los almacenes de Swayp y Fénix.",
  "reports.view": "Consolidado, panel de cada tienda y productividad de todo el equipo.",
};

/**
 * Dónde vive cada permiso, en el orden en que se leen en Equipo. Cada permiso
 * está en un área y solo en una (lo fija una prueba).
 */
export const PERMISSION_AREAS = [
  {
    key: "pedidos",
    label: "Pedidos",
    permissions: ["master.edit", "master.override_status", "orders.create", "master.import_report", "data.export"],
  },
  {
    key: "pagos",
    label: "Pagos y claves de recojo",
    permissions: [
      "shalom.register_payment",
      "payments.validate",
      "shalom.validate_payment",
      "shalom.override_payment_validation",
      "tanders.review_payment",
      "alerts.repeated_voucher",
      // Una boleta sale de un pago validado y de la cuenta que lo recibió (§35.2).
      "invoices.manage",
      "shalom.reveal_pickup_key",
      "shalom.view_pickup_key",
    ],
  },
  {
    key: "guias",
    label: "Guías y couriers",
    permissions: [
      "aliclik.create_guide",
      "tanders.create_guide",
      "shalom.create_guide",
      "aliclik.cancel_guide",
      "swayp.solve_novelty",
      "recovery.contact",
      "repro_lima.manage",
      "aliclik.manage_catalog",
    ],
  },
  {
    key: "despacho",
    label: "Almacén y despacho",
    permissions: ["warehouse.prepare", "dispatch.manage", "dispatch.pickup", "stock.manage", "logistics.manage"],
  },
  {
    key: "rutas",
    label: "Rutas y motorizados",
    permissions: ["routes.manage", "routes.report_others", "routes.deliver", "riders.manage"],
  },
  {
    key: "cierre",
    label: "Devoluciones y cierre del pedido",
    permissions: ["closure.return", "closure.inventory", "closure.finance", "closure.finalize", "closure.refund"],
  },
  {
    key: "liquidaciones",
    label: "Liquidaciones",
    permissions: ["settlements.manage", "settlements.close", "sheets.edit", "sheets.manage"],
  },
  {
    key: "administracion",
    label: "Administración",
    permissions: ["team.manage", "stores.manage", "costs.manage", "leads.map_ads", "reports.view"],
  },
] as const satisfies readonly { key: string; label: string; permissions: readonly Permission[] }[];

/**
 * Los permisos de una lista, repartidos por área y en su orden. Las áreas sin
 * ninguno no salen.
 */
export function groupByArea<T extends { permission: Permission }>(
  items: readonly T[],
): { key: string; label: string; items: T[] }[] {
  const byPermission = new Map(items.map((item) => [item.permission, item]));
  return PERMISSION_AREAS.map((area) => ({
    key: area.key,
    label: area.label,
    items: area.permissions.flatMap((permission) => {
      const item = byPermission.get(permission);
      return item ? [item] : [];
    }),
  })).filter((area) => area.items.length > 0);
}

/** El acceso de cada persona (`memberships.role`), dicho como se lee en Equipo. */
export const ACCESS_LABEL: Record<string, string> = {
  owner: "Dueño",
  admin: "Admin",
  vendedora: "Vendedora",
  viewer: "Solo lectura",
  motorizado: "Motorizado",
};

/** Qué significa cada acceso, para la guía de Equipo. */
export const ACCESS_HELP: Record<string, string> = {
  owner: "Todo, también confirmar reembolsos. Es quien reparte roles y los permisos de dinero y datos.",
  admin: "Todo menos confirmar reembolsos y los permisos que se dan uno por uno.",
  vendedora: "Sin roles, el paquete de siempre de la vendedora. Con roles, solo lo de sus roles.",
  viewer: "Mira pedidos, filtros e historial. No cambia nada.",
  motorizado: "Solo su ruta, desde el celular.",
};

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
    permission: "routes.report_others",
    label: PERMISSION_LABEL["routes.report_others"],
    description: `${PERMISSION_HELP["routes.report_others"]} No cierra liquidaciones.`,
    lastOneMatters: false,
    // Operativo: un admin lo puede conceder.
    ownerOnly: false,
  },
  {
    permission: "payments.validate",
    label: PERMISSION_LABEL["payments.validate"],
    /** Lo que se le dice a quien concede, no el nombre técnico. */
    description: PERMISSION_HELP["payments.validate"],
    /** Sin nadie con este permiso, la cola de validación se queda parada. */
    lastOneMatters: true,
    /** Dinero: solo el dueño lo da o lo quita (lib/team.ts, MOM §16). */
    ownerOnly: true,
  },
  {
    permission: "shalom.override_payment_validation",
    label: PERMISSION_LABEL["shalom.override_payment_validation"],
    description: PERMISSION_HELP["shalom.override_payment_validation"],
    lastOneMatters: true,
    ownerOnly: true,
  },
  {
    permission: "alerts.repeated_voucher",
    label: PERMISSION_LABEL["alerts.repeated_voucher"],
    description: PERMISSION_HELP["alerts.repeated_voucher"],
    /** Sin nadie que la reciba, un pago cobrado dos veces vuelve a pasar en silencio. */
    lastOneMatters: true,
    ownerOnly: true,
  },
  {
    permission: "invoices.manage",
    label: PERMISSION_LABEL["invoices.manage"],
    description: PERMISSION_HELP["invoices.manage"],
    /**
     * Sin nadie con este permiso el barrido sigue emitiendo con lo configurado,
     * pero nadie puede apagar un RUC, liberar un `en_duda` ni registrar una
     * boleta hecha a mano: emisión sin nadie al volante (MOM §35.4).
     */
    lastOneMatters: true,
    // Cada boleta es impuesto de una empresa y no se borra (MOM §35.7).
    ownerOnly: true,
  },
  {
    permission: "logistics.manage",
    label: PERMISSION_LABEL["logistics.manage"],
    description: PERMISSION_HELP["logistics.manage"],
    lastOneMatters: false,
    // Tarifas, pago de motorizados y exceso de efectivo (§29.9): es dinero.
    ownerOnly: true,
  },
  {
    permission: "data.export",
    label: PERMISSION_LABEL["data.export"],
    description: `${PERMISSION_HELP["data.export"]} Viene con dueño y admin.`,
    lastOneMatters: false,
    // Owner y admin ya exportaban: quitárselo no es lo que se pidió. La casilla
    // está para concedérselo a una vendedora concreta (08-10-2026).
    withAdminRole: true,
    // La base de clientes entera: la concede el dueño.
    ownerOnly: true,
  },
] as const satisfies readonly {
  permission: Permission;
  label: string;
  description: string;
  lastOneMatters: boolean;
  /** Viene con el rol admin y además tiene casilla en Equipo para los demás roles. */
  withAdminRole?: boolean;
  /** Solo el dueño lo da o lo quita: dinero o datos (12-10-2026, MOM §16). */
  ownerOnly: boolean;
}[];

const ONE_BY_ONE: ReadonlySet<string> = new Set(
  GRANTED_ONE_BY_ONE.map((entry) => entry.permission),
);

/** Los de concesión individual que el rol admin NO trae. */
const NOT_IN_ADMIN_ROLE: ReadonlySet<string> = new Set(
  GRANTED_ONE_BY_ONE.filter((entry) => !("withAdminRole" in entry && entry.withAdminRole)).map(
    (entry) => entry.permission,
  ),
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
      !NOT_IN_ADMIN_ROLE.has(permission),
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
    // Cargar la ruta del día en Liquidaciones 2 y anotar por qué un monto no
    // cuadra es trabajo de quien liquida. Configurar hojas y equivalencias, no.
    "sheets.edit",
    // Recuperar una devolución es gestión de venta, que es su trabajo: la misma
    // persona que llamaría a esa clienta es la que manda el mensaje.
    "recovery.contact",
    // Lo mismo con el cliente de Lima que no recibió: lo llama y deja el acuerdo.
    "repro_lima.manage",
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

/**
 * Roles que se acumulan (12-10-2026, MOM §16): cada uno es el paquete de
 * permisos de una función de la operación, y una persona puede tener varios.
 * Viven en `membership_roles`, encima del acceso de `memberships.role`.
 *
 * Reglas:
 *  - Los permisos de todos sus roles se SUMAN, más las concesiones puntuales,
 *    menos las revocaciones puntuales (que siguen ganando siempre).
 *  - Quien tiene acceso «vendedora» y al menos un rol recibe SOLO lo de sus
 *    roles: el paquete «vendedora» es el de quien aún no tiene roles. Si no,
 *    darle «Almacén» a una vendedora no le quitaría nada de lo que no usa.
 *  - Ningún rol trae los permisos de dinero o datos que da el dueño uno por
 *    uno (`GRANTED_ONE_BY_ONE[].ownerOnly`): lo fija una prueba.
 *  - Solo el dueño asigna roles (lib/team.ts).
 */
export const FUNCTIONAL_ROLES = [
  {
    role: "asesora",
    label: "Asesora",
    description: "Para quien confirma y vende: gestiona pedidos, sube comprobantes, crea guías y pedidos, recupera devoluciones y llama a los clientes de Repro Lima.",
    permissions: [
      "master.edit",
      "shalom.register_payment",
      "shalom.reveal_pickup_key",
      "aliclik.create_guide",
      "tanders.create_guide",
      "shalom.create_guide",
      "swayp.solve_novelty",
      "recovery.contact",
      "repro_lima.manage",
      "orders.create",
      "closure.return",
    ],
  },
  {
    role: "almacen",
    label: "Almacén",
    description: "Para quien arma paquetes: los deja listos, recibe devoluciones y las reingresa al inventario.",
    permissions: ["master.edit", "warehouse.prepare", "closure.return", "closure.inventory"],
  },
  {
    role: "despacho",
    label: "Despacho y Grupo GF",
    description: "Para quien despacha: cajas del día, rutas, entrega al motorizado, reportes de couriers y stock de Swayp y Fénix.",
    permissions: [
      "master.edit",
      "master.import_report",
      "warehouse.prepare",
      "dispatch.manage",
      "dispatch.pickup",
      "repro_lima.manage",
      "routes.manage",
      "routes.report_others",
      // «Motorizados» vive en Equipo, que es de Administración: sin Equipo,
      // este permiso no tendría dónde usarse.
      "stock.manage",
      "closure.return",
      "aliclik.create_guide",
      "tanders.create_guide",
      "shalom.create_guide",
    ],
  },
  {
    role: "liquidaciones",
    label: "Liquidaciones",
    description: "Para quien cuadra el dinero: liquidaciones de motorizados, hojas de couriers y conciliación de cada pedido.",
    permissions: ["master.edit", "settlements.manage", "settlements.close", "sheets.edit", "closure.finance"],
  },
  {
    role: "cobranza",
    label: "Cobranza",
    description: "Para quien cobra sin ser asesora: sube comprobantes, maneja las claves de recojo y aprueba cobros de Tanders rechazados.",
    permissions: ["master.edit", "shalom.register_payment", "shalom.reveal_pickup_key", "shalom.view_pickup_key", "tanders.review_payment"],
  },
  {
    role: "supervision",
    label: "Supervisión",
    description: "Para quien corrige y cierra: pedidos cerrados, cerrar o reabrir pedidos, anular guías de Aliclik y ver los reportes.",
    permissions: [
      "master.edit",
      "master.override_status",
      "closure.finalize",
      "closure.return",
      "closure.inventory",
      "aliclik.cancel_guide",
      "reports.view",
    ],
  },
  {
    role: "administracion",
    label: "Administración",
    description: "Para quien administra: equipo, tiendas, costos, stock, catálogo de Aliclik, anuncios, hojas y reportes.",
    permissions: [
      "master.edit",
      "master.import_report",
      "team.manage",
      "stores.manage",
      "stock.manage",
      "costs.manage",
      "aliclik.manage_catalog",
      "sheets.manage",
      "riders.manage",
      "leads.map_ads",
      "reports.view",
    ],
  },
] as const satisfies readonly {
  role: string;
  label: string;
  description: string;
  permissions: readonly Permission[];
}[];

export type FunctionalRole = (typeof FUNCTIONAL_ROLES)[number]["role"];

export function isFunctionalRole(value: string): value is FunctionalRole {
  return FUNCTIONAL_ROLES.some((entry) => entry.role === value);
}

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
  /** Roles acumulables (`membership_roles`). */
  functionalRoles: readonly string[] = [],
): Set<Permission> {
  const out = new Set<Permission>();
  const functions = FUNCTIONAL_ROLES.filter((entry) => functionalRoles.includes(entry.role));
  for (const role of roles) {
    // Con roles asignados, el paquete «vendedora» no suma: manda lo de sus roles.
    if (role === "vendedora" && functions.length) continue;
    for (const p of ROLE_PERMISSIONS[role] ?? []) out.add(p);
  }
  for (const entry of functions) {
    for (const p of entry.permissions) out.add(p);
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
  functionalRoles: readonly string[] = [],
): boolean {
  return permissionsFor(roles, grants, functionalRoles).has(permission);
}

/** De dónde le viene un permiso a una persona. */
export type PermissionSource =
  | { kind: "access"; role: string }
  | { kind: "function"; role: FunctionalRole }
  | { kind: "grant" };

/**
 * Lo que puede hacer una persona y POR QUÉ: cada permiso con sus orígenes (su
 * acceso, cada rol que lo trae, una concesión uno por uno) y aparte lo que se le
 * quitó a mano aunque un rol se lo diera. El conjunto sale de `permissionsFor`,
 * así que la explicación no puede contradecir lo que la persona puede hacer.
 */
export function explainPermissions(
  roles: readonly string[],
  grants: readonly PermissionGrant[] = [],
  functionalRoles: readonly string[] = [],
): { granted: { permission: Permission; sources: PermissionSource[] }[]; revoked: Permission[] } {
  const effective = permissionsFor(roles, grants, functionalRoles);
  const functions = FUNCTIONAL_ROLES.filter((entry) => functionalRoles.includes(entry.role));
  const accessRoles = roles.filter((role) => !(role === "vendedora" && functions.length));
  const granted = PERMISSIONS.filter((permission) => effective.has(permission)).map((permission) => {
    const sources: PermissionSource[] = [];
    for (const role of accessRoles) {
      if ((ROLE_PERMISSIONS[role] ?? []).includes(permission)) sources.push({ kind: "access", role });
    }
    for (const entry of functions) {
      if ((entry.permissions as readonly Permission[]).includes(permission)) sources.push({ kind: "function", role: entry.role });
    }
    const byGrant = grants.some(
      (grant) =>
        grant.granted !== false &&
        (grant.permission === permission ||
          // El nombre histórico sigue habilitando la bandeja (ver `permissionsFor`).
          (permission === "payments.validate" && grant.permission === "shalom.validate_payment")),
    );
    if (byGrant) sources.push({ kind: "grant" });
    return { permission, sources };
  });
  const fromBundles = permissionsFor(roles, [], functionalRoles);
  const revoked = PERMISSIONS.filter(
    (permission) =>
      fromBundles.has(permission) &&
      !effective.has(permission) &&
      grants.some((grant) => grant.permission === permission && grant.granted === false),
  );
  return { granted, revoked };
}

/**
 * ¿Opera Grupo GF Courier? Despacho del día —tomar, asignar, programar,
 * reprogramar y recibir en oficina— es de cualquiera que despache
 * (`dispatch.manage`) o administre el courier (`logistics.manage`): decisión
 * del owner del 11-10-2026, para que quien esté pueda ejecutar (MOM §29.10).
 * Tarifario, contratos, pago de motorizados y autorizar un exceso de efectivo
 * (§29.9) siguen siendo solo de `logistics.manage`.
 */
export function canOperateGroupGf(can: (permission: Permission) => boolean): boolean {
  return can("logistics.manage") || can("dispatch.manage");
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
  functionalRoles: readonly string[] = [],
): boolean {
  return !hasPermission(roles, "master.edit", grants, functionalRoles);
}

/** Etiqueta legible del rol, para la cabecera del panel. */
export function roleLabel(roles: readonly string[]): string {
  if (roles.includes("owner") || roles.includes("admin")) return "Administrador";
  if (roles.length && roles.every((r) => r === "vendedora")) return "Vendedora";
  if (roles.length && roles.every((r) => r === "motorizado")) return "Motorizado";
  if (roles.length && roles.every((r) => r === "viewer")) return "Solo lectura";
  return "Equipo";
}
