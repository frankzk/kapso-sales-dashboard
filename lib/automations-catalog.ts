// Catálogo del panel «Automatizaciones» (MOM §40, pedido del owner del
// 04-11-2026).
//
// POR QUÉ. Las automatizaciones de Kapta se encendían en seis sitios distintos
// —ajustes de cada tienda, dos páginas de Swayp, la base de datos a mano y
// variables del servidor— y el owner no sabía cuáles estaban creando guías,
// llamando o escribiendo a clientas. Este catálogo es la lista ÚNICA de lo que
// existe hoy, con lo que hace dicho en llano y cómo se enciende. El panel la
// dibuja y las acciones solo escriben lo que esta lista declara (la lista
// blanca de abajo): una tabla o columna que no está aquí no se toca desde el
// panel, aunque el cliente la mande.
//
// No inventa automatizaciones ni estados: cada entrada sale del mapa de
// automatizaciones existentes. Las que no tienen interruptor propio se
// listan igual, en solo lectura, con la forma de cambiarlas.
//
// Puro: sin base ni red.

import { RETRY_DAILY_CAP_MAX, RETRY_DAILY_CAP_MIN, RETRY_MODE_LABEL, isRetryMode, isRetryVariant, retryVariantLabel } from "@/lib/lima-retry-auto";

/** Los grupos del panel, en su orden. */
export const AUTOMATION_GROUPS = [
  {
    key: "logistica_provincia",
    title: "Logística Provincia",
    description: "Guías que Kapta saca sola por Swayp cuando Aliclik no entregó o la clienta no confirma.",
  },
  {
    key: "confirmacion",
    title: "Confirmación",
    description: "Pedidos que Kapta confirma sin que una asesora llame.",
  },
  {
    key: "llamadas",
    title: "Llamadas de voz",
    description: "El agente de voz llama solo, en su horario y con su tope, tienda por tienda.",
  },
  {
    key: "whatsapp",
    title: "Mensajes de WhatsApp",
    description: "Plantillas que salen solas a clientas y leads, tienda por tienda.",
  },
  {
    key: "sin_interruptor",
    title: "Sin interruptor en este panel",
    description: "Corren solas pero se cambian en otro sitio. Aquí está su estado y dónde se cambian.",
  },
] as const;

export type AutomationGroup = (typeof AUTOMATION_GROUPS)[number]["key"];

/**
 * Lo que la automatización hace en el mundo. Los cuatro primeros son efectos
 * externos que no se deshacen (guía, mensaje, llamada, pedido confirmado): por
 * eso encenderlos pide confirmación. Los demás solo los tienen las entradas de
 * solo lectura.
 */
export const AUTOMATION_EFFECTS = [
  "Crea guías",
  "Envía WhatsApp",
  "Llama a clientas",
  "Confirma pedidos",
  "Solo informa",
  "Crea pedidos",
  "Valida pagos",
  "Emite comprobantes",
  "Registra despachos",
  "Cancela en la tienda",
  "Ordena el trabajo",
] as const;
export type AutomationEffect = (typeof AUTOMATION_EFFECTS)[number];

/** Efectos que salen de Kapta y no se deshacen: encender pide confirmación. */
export const EXTERNAL_EFFECTS: readonly AutomationEffect[] = ["Crea guías", "Envía WhatsApp", "Llama a clientas", "Confirma pedidos"];

export type AutomationScope = "org" | "store" | "none";

/** Tablas de configuración por organización que el panel puede escribir. */
export const ORG_AUTOMATION_TABLES = ["swayp_auto_settings", "swayp_pc_auto_settings", "chatby_auto_settings"] as const;
export type OrgAutomationTable = (typeof ORG_AUTOMATION_TABLES)[number];

/**
 * Las columnas de cada tabla que el panel lee, y si la tabla guarda quién la
 * cambió. `swayp_auto_settings` no tiene `updated_by` (0209): quién lo cambió
 * queda solo en el historial del panel.
 */
export const ORG_TABLE_SHAPE: Record<OrgAutomationTable, { columns: readonly string[]; updatedBy: boolean }> = {
  swayp_auto_settings: { columns: ["enabled", "pilot_enabled"], updatedBy: false },
  swayp_pc_auto_settings: { columns: ["enabled", "paused_reason"], updatedBy: true },
  chatby_auto_settings: { columns: ["enabled", "guide_enabled"], updatedBy: true },
};

export type AutomationControl =
  | { kind: "org_table"; table: OrgAutomationTable; column: string; requires?: string }
  | { kind: "store_column"; column: string; requires?: string }
  /**
   * Apagado / Simulación / Activo de una columna de texto de la organización
   * (0316). No es un interruptor: no entra en la lista blanca de `on/off` y
   * tiene su propia acción (`setChatbyApproxMode`, `setChatbyAskMode`,
   * `setChatbyHistoryMode`), que
   * solo escribe esta columna con uno de los tres valores.
   */
  | { kind: "org_mode"; table: OrgAutomationTable; column: string; requires?: never }
  | { kind: "readonly"; how: string };

/**
 * Dónde se ve el detalle: una página del panel o una sección de los ajustes
 * de cada tienda (el ancla de `components/store-settings.tsx`).
 */
export type AutomationLink = { kind: "page"; href: string; label: string } | { kind: "store_settings"; section: string; label: string };

export interface AutomationEntry {
  key: string;
  group: AutomationGroup;
  name: string;
  /** Una o dos frases en llano, para el owner. */
  what: string;
  effect: AutomationEffect;
  scope: AutomationScope;
  control: AutomationControl;
  /** Por qué el interruptor está apagado y bloqueado cuando falta su requisito. */
  requiresReason?: string;
  link?: AutomationLink;
}

/** «Aceptar ubicación aproximada en la calle correcta» (0316): su clave en el catálogo y en el historial. */
export const CHATBY_APPROX_KEY = "chatby_auto_approx";
/** «Pedir sola la dirección o la ubicación» (0318): su clave en el catálogo y en el historial. */
export const CHATBY_ASK_KEY = "chatby_auto_ask";
/** «Guía automática para clientas con entregas» (0317): su clave en el catálogo y en el historial. */
export const CHATBY_HISTORY_KEY = "chatby_auto_history";

const STORE_SETTINGS = (section: string, label = "Ajustes de la tienda"): AutomationLink => ({ kind: "store_settings", section, label });

export const AUTOMATIONS: readonly AutomationEntry[] = [
  // ── Logística Provincia ────────────────────────────────────────────────
  {
    key: "swayp_auto",
    group: "logistica_provincia",
    name: "Aliclik a Swayp automático",
    what:
      "Cuando Aliclik anula una guía de provincia y la clienta ya recibió antes en esa dirección, saca una guía nueva por Swayp sin llamarla. Mientras está encendido, el agente de voz no llama a esos pedidos.",
    effect: "Crea guías",
    scope: "org",
    control: { kind: "org_table", table: "swayp_auto_settings", column: "enabled" },
    link: { kind: "page", href: "/dashboard/envios/automatico", label: "Ver lo que hizo" },
  },
  {
    key: "swayp_auto_pilot",
    group: "logistica_provincia",
    name: "Piloto sin entrega previa",
    what:
      "Amplía el anterior a clientas sin entrega previa que Aliclik sí visitó, hasta S/ 500 y con su propio tope del día. Ese tope también decide a quién llama el agente de voz.",
    effect: "Crea guías",
    scope: "org",
    control: { kind: "org_table", table: "swayp_auto_settings", column: "pilot_enabled", requires: "enabled" },
    requiresReason: "Enciende antes «Aliclik a Swayp automático».",
    link: { kind: "page", href: "/dashboard/envios/automatico", label: "Ver lo que hizo" },
  },
  {
    key: "swayp_pc_auto",
    group: "logistica_provincia",
    name: "Swayp desde Por confirmar",
    what:
      // El freno se mira al empezar CADA pasada (`frenoActivado`,
      // lib/swayp-por-confirmar-auto-server.ts): encender a mano borra el
      // motivo, pero si la tasa sigue baja se vuelve a apagar en la siguiente.
      "Una vez al día envía por Swayp, sin confirmar con la clienta, una parte de los pedidos de provincia que no contestan. Se apaga solo si las entregas caen; encenderlo a mano lo reanuda, pero si siguen bajas se vuelve a apagar en la pasada siguiente.",
    effect: "Crea guías",
    scope: "org",
    control: { kind: "org_table", table: "swayp_pc_auto_settings", column: "enabled" },
    link: { kind: "page", href: "/dashboard/pedidos/swayp-desde-confirmar", label: "Ver resultados y simular" },
  },

  // ── Confirmación ───────────────────────────────────────────────────────
  {
    key: "chatby_auto",
    group: "confirmacion",
    name: "Confirmación por Chatby",
    what:
      "Lee en Chatby la conversación de los pedidos de provincia por confirmar. Si la clienta confirmó con el pedido, el monto y la dirección correctos, crea la guía de Aliclik y confirma el pedido.",
    effect: "Confirma pedidos",
    scope: "org",
    // Sin la guía, la pasada no confirma nada (lib/chatby-autoconfirm-server.ts:
    // «sin guía no se confirma nada», owner 02-11-2026). Modelado como
    // requisito para que el panel no diga «Encendido» mientras no confirma.
    control: { kind: "org_table", table: "chatby_auto_settings", column: "enabled", requires: "guide_enabled" },
    requiresReason: "Enciende antes «Guía Aliclik de la confirmación por Chatby»: sin ella Chatby no confirma ningún pedido.",
  },
  {
    key: "chatby_auto_guide",
    group: "confirmacion",
    name: "Guía Aliclik de la confirmación por Chatby",
    // El mapa lo corrige: con `guide_enabled` apagado la pasada entera no
    // confirma nada («confirmar y crear la guía son un paso», decisión del
    // owner del 02-11-2026). Se dice tal cual para que nadie lo apague
    // creyendo que solo quita la guía.
    what: "Confirmar y crear la guía van juntos: apagar esto también detiene las confirmaciones por Chatby, aunque el interruptor de arriba siga encendido.",
    effect: "Crea guías",
    scope: "org",
    control: { kind: "org_table", table: "chatby_auto_settings", column: "guide_enabled" },
  },
  {
    key: CHATBY_APPROX_KEY,
    group: "confirmacion",
    name: "Aceptar ubicación aproximada en la calle correcta",
    // 0316, owner 08-11-2026. La reja de la calle y las tres posiciones están
    // en lib/geocode-approx.ts; la prueba se ve debajo, en el mismo grupo.
    what:
      "Cuando Google da el número de la cuadra y no la casa, pero es la misma calle, número y provincia del pedido. En Simulación guarda ese punto y el pedido sigue para la asesora como hoy; en Activo la guía de Chatby lo usa.",
    effect: "Crea guías",
    scope: "org",
    control: { kind: "org_mode", table: "chatby_auto_settings", column: "approx_mode" },
  },
  {
    key: CHATBY_ASK_KEY,
    group: "confirmacion",
    name: "Pedir sola la dirección o la ubicación",
    // 0318, owner 08-11-2026. La máquina está en lib/chatby-auto-ask.ts.
    what:
      "Si la clienta confirmó por Chatby y la guía no sale por la dirección, Kapta le pide por WhatsApp la dirección completa o su ubicación (una vez cada una) y vuelve a intentar la guía. En Simulación solo dice qué habría pedido.",
    effect: "Envía WhatsApp",
    scope: "org",
    control: { kind: "org_mode", table: "chatby_auto_settings", column: "ask_mode" },
  },
  {
    key: CHATBY_HISTORY_KEY,
    group: "confirmacion",
    name: "Guía automática para clientas con entregas",
    // 0317, owner 08-11-2026. La regla está en lib/history-guide-auto.ts; va
    // antes de «Pedir sola la dirección o la ubicación».
    what:
      "Si la clienta confirmó por Chatby y la guía no sale por la dirección, pero ya recibió en esa misma dirección sin ningún fallido, crea la guía con el GPS de esa entrega y confirma, sin escribirle. En Simulación solo dice con qué entrega la habría creado.",
    effect: "Crea guías",
    scope: "org",
    control: { kind: "org_mode", table: "chatby_auto_settings", column: "history_guide_mode" },
  },

  // ── Llamadas de voz ────────────────────────────────────────────────────
  {
    key: "voice_recovery_auto",
    group: "llamadas",
    name: "Agente de voz de Repro Provincia",
    what: "Llama solo a las clientas de pedidos devueltos o anulados de la cola, en su horario y con su tope. Si la clienta confirma, crea la salida por Swayp.",
    effect: "Llama a clientas",
    scope: "store",
    control: { kind: "store_column", column: "voice_recovery_auto", requires: "voice_recovery_enabled" },
    requiresReason: "Primero activa el agente en los ajustes de la tienda.",
    link: STORE_SETTINGS("agente-voz"),
  },
  {
    key: "voice_lead_auto",
    group: "llamadas",
    name: "Agente de voz de Leads",
    what: "Llama solo a los leads de las campañas elegidas, en su horario y con su tope, y deja un grupo sin llamar para comparar.",
    effect: "Llama a clientas",
    scope: "store",
    control: { kind: "store_column", column: "voice_lead_auto", requires: "voice_lead_enabled" },
    requiresReason: "Primero activa el agente de leads en los ajustes de la tienda.",
    link: STORE_SETTINGS("agente-voz-leads"),
  },

  // ── Mensajes de WhatsApp ───────────────────────────────────────────────
  {
    key: "return_recovery_auto",
    group: "whatsapp",
    name: "Recuperar pedidos devueltos",
    what: "Escribe a la clienta cuya guía de provincia volvió al almacén y le propone reenviarla por agencia con adelanto.",
    effect: "Envía WhatsApp",
    scope: "store",
    control: { kind: "store_column", column: "return_recovery_auto", requires: "return_recovery_enabled" },
    requiresReason: "Primero activa la recuperación de devueltos en los ajustes de la tienda.",
    link: STORE_SETTINGS("devueltos"),
  },
  {
    key: "drip_template",
    group: "whatsapp",
    name: "Seguimiento a leads sin respuesta",
    what: "Manda hasta dos plantillas a los leads que no contestaron la llamada, en horario laboral.",
    effect: "Envía WhatsApp",
    scope: "store",
    control: { kind: "store_column", column: "drip_template_enabled" },
    link: STORE_SETTINGS("drip"),
  },
  {
    key: "cart_sequence",
    group: "whatsapp",
    name: "Carritos abandonados",
    what: "Manda dos plantillas a quien dejó el carrito sin comprar, a las horas configuradas.",
    effect: "Envía WhatsApp",
    scope: "store",
    control: { kind: "store_column", column: "cart_seq_enabled" },
    link: STORE_SETTINGS("carritos"),
  },
  {
    key: "delivered_thanks",
    group: "whatsapp",
    name: "Agradecer al entregar",
    what: "Manda un agradecimiento con el catálogo a la clienta cuyo pedido se entregó.",
    effect: "Envía WhatsApp",
    scope: "store",
    control: { kind: "store_column", column: "delivered_thanks_enabled" },
    link: STORE_SETTINGS("agradecer"),
  },
  {
    key: "restock",
    group: "whatsapp",
    name: "Recordatorio de reposición",
    what: "Avisa a la clienta cuando se le está por acabar lo que compró; a un grupo de control no le escribe, para medir.",
    effect: "Envía WhatsApp",
    scope: "store",
    control: { kind: "store_column", column: "restock_enabled" },
    link: STORE_SETTINGS("reposicion"),
  },
  {
    key: "browse_template",
    group: "whatsapp",
    name: "Búsqueda abandonada",
    what: "Manda una plantilla a quien miró productos y no compró.",
    effect: "Envía WhatsApp",
    scope: "store",
    control: { kind: "store_column", column: "browse_template_enabled" },
    link: STORE_SETTINGS("busqueda"),
  },
  {
    key: "winback_template",
    group: "whatsapp",
    name: "Clientes sin comprar",
    what: "Escribe a la clienta que no compra desde hace 60 días.",
    effect: "Envía WhatsApp",
    scope: "store",
    control: { kind: "store_column", column: "winback_template_enabled" },
    link: STORE_SETTINGS("recuperacion"),
  },
  {
    key: "shalom_transit",
    group: "whatsapp",
    name: "Shalom: pedido en camino",
    what: "Avisa a la clienta cuando su paquete de Shalom sale hacia la agencia.",
    effect: "Envía WhatsApp",
    scope: "store",
    control: { kind: "store_column", column: "shalom_transit_template_enabled" },
    link: STORE_SETTINGS("avisos-shalom"),
  },
  {
    key: "shalom_arrival",
    group: "whatsapp",
    name: "Shalom: ya llegó a la agencia",
    what: "Avisa a la clienta cuando su paquete ya se puede recoger en la agencia.",
    effect: "Envía WhatsApp",
    scope: "store",
    control: { kind: "store_column", column: "shalom_arrival_template_enabled" },
    link: STORE_SETTINGS("avisos-shalom"),
  },
  {
    key: "shalom_reminder",
    group: "whatsapp",
    name: "Shalom: recordatorio de recojo",
    what: "Recuerda a la clienta, a los 3 y a los 7 días, que su paquete la espera en la agencia.",
    effect: "Envía WhatsApp",
    scope: "store",
    control: { kind: "store_column", column: "shalom_reminder_template_enabled" },
    link: STORE_SETTINGS("avisos-shalom"),
  },
  {
    key: "shalom_pickup_key",
    group: "whatsapp",
    name: "Shalom: clave de recojo al validar el pago",
    what: "Cuando el pago del pedido queda validado, manda sola la clave de recojo por WhatsApp.",
    effect: "Envía WhatsApp",
    scope: "store",
    control: { kind: "store_column", column: "shalom_pickup_key_autosend_enabled" },
    link: STORE_SETTINGS("avisos-shalom"),
  },
  {
    key: "olva_transit",
    group: "whatsapp",
    name: "Olva: pedido en camino",
    what: "Avisa a la clienta cuando su paquete de Olva está en camino.",
    effect: "Envía WhatsApp",
    scope: "store",
    control: { kind: "store_column", column: "olva_transit_template_enabled" },
    link: STORE_SETTINGS("avisos-olva"),
  },
  {
    key: "olva_arrival",
    group: "whatsapp",
    name: "Olva: ya llegó a la agencia",
    what: "Avisa a la clienta cuando su paquete ya se puede recoger en la agencia de Olva.",
    effect: "Envía WhatsApp",
    scope: "store",
    control: { kind: "store_column", column: "olva_arrival_template_enabled" },
    link: STORE_SETTINGS("avisos-olva"),
  },
  {
    key: "olva_paid_arrival",
    group: "whatsapp",
    name: "Olva: llegó un pedido ya pagado",
    what: "Avisa a la clienta que ya pagó que su paquete llegó a la agencia, sin pedirle saldo.",
    effect: "Envía WhatsApp",
    scope: "store",
    control: { kind: "store_column", column: "olva_paid_arrival_template_enabled" },
    link: STORE_SETTINGS("avisos-olva"),
  },
  {
    key: "olva_reminder",
    group: "whatsapp",
    name: "Olva: recordatorio de recojo",
    what: "Recuerda a la clienta, al tercer día, que su paquete la espera en la agencia.",
    effect: "Envía WhatsApp",
    scope: "store",
    control: { kind: "store_column", column: "olva_reminder_template_enabled" },
    link: STORE_SETTINGS("avisos-olva"),
  },

  // ── Sin interruptor en este panel ──────────────────────────────────────
  {
    key: "aliclik_scheduled",
    group: "sin_interruptor",
    name: "Guía Aliclik del día programado",
    what:
      "Entre 8:00 a. m. y 1:00 p. m. crea la guía de Aliclik de los pedidos de provincia con fecha de despacho de hoy. Si una falla, avisa por Telegram.",
    effect: "Crea guías",
    scope: "store",
    control: {
      kind: "readonly",
      how: "No tiene interruptor propio: depende de «Crear guías en Aliclik» de cada tienda, que también apaga las guías que se crean a mano.",
    },
    link: STORE_SETTINGS("aliclik"),
  },
  {
    key: "invoices",
    group: "sin_interruptor",
    name: "Comprobantes electrónicos",
    what: "Cada 10 minutos simula o emite en SimpleFact las boletas de los pedidos pagados.",
    effect: "Emite comprobantes",
    scope: "org",
    control: {
      kind: "readonly",
      how: "Se cambia por RUC en «Boletas y facturas», en los ajustes de la tienda. Pide además el permiso de boletas.",
    },
    link: STORE_SETTINGS("boletas"),
  },
  {
    key: "auto_orders",
    group: "sin_interruptor",
    name: "Pedidos de recompra automáticos",
    what: "Completa en Shopify, sin llamar, una parte de los carritos de recompra, como prueba frente a un grupo al que sí se llama.",
    effect: "Crea pedidos",
    scope: "none",
    control: { kind: "readonly", how: "Se enciende por fechas desde la base de datos. Pídeselo a quien mantiene Kapta." },
  },
  {
    key: "lead_routing",
    group: "sin_interruptor",
    name: "Reparto de leads por bloques",
    what: "Cada asesora solo ve y toma los leads de los bloques que tiene asignados.",
    effect: "Ordena el trabajo",
    scope: "org",
    control: { kind: "readonly", how: "Se enciende en Equipo, donde se comprueba que cada bloque tenga quien lo atienda." },
    link: { kind: "page", href: "/dashboard/team", label: "Ir a Equipo" },
  },
  {
    key: "telegram_reports",
    group: "sin_interruptor",
    name: "Resumen diario y empujón de leads por Telegram",
    what: "A las 8:00 a. m. manda el resumen del día y, cinco veces al día, la lista de leads por llamar del experimento.",
    effect: "Solo informa",
    scope: "store",
    control: {
      kind: "readonly",
      how: "Va a toda tienda con Telegram configurado. Se corta quitando el Telegram de la tienda, lo que apaga también las demás alertas.",
    },
    link: STORE_SETTINGS("telegram"),
  },
  {
    key: "woo_sale_returns",
    group: "sin_interruptor",
    name: "Cierre WooCommerce de venta terminada",
    what: "Cuando el almacén confirma que recibió la devolución, cancela el pedido en WooCommerce para que la tienda reponga el stock.",
    effect: "Cancela en la tienda",
    scope: "none",
    control: { kind: "readonly", how: "Siempre encendido: solo ejecuta lo que una persona ya decidió al recibir la devolución." },
  },
  {
    key: "tanders_payments",
    group: "sin_interruptor",
    name: "Validación de cobros Tanders",
    what:
      "Cada 2 horas lee las constancias de pago de las guías de Tanders. Las que da por buenas pasan a entregadas y su cobro va a la cola de validación.",
    effect: "Valida pagos",
    scope: "store",
    control: { kind: "readonly", how: "Siempre encendido en las tiendas con cuenta de Tanders. La revisión en seco está en Cobros Tanders." },
    link: { kind: "page", href: "/dashboard/pedidos/cobros-tanders", label: "Ir a Cobros Tanders" },
  },
  {
    key: "urpi_programming",
    group: "sin_interruptor",
    name: "Programación de Urpi",
    what: "Cada 15 minutos lee la hoja de Urpi y registra los despachos programados.",
    effect: "Registra despachos",
    scope: "none",
    control: { kind: "readonly", how: "Se apaga en la configuración del servidor. Pídeselo a quien mantiene Kapta." },
    link: { kind: "page", href: "/dashboard/urpi", label: "Ir a Programaciones Urpi" },
  },
  {
    key: "kapso_bot_orders",
    group: "sin_interruptor",
    name: "Bot de Kapso a pedidos",
    what: "Cuando el bot de Kapso cierra una venta en una tienda de WooCommerce, Kapta crea el pedido en la tienda.",
    effect: "Crea pedidos",
    scope: "store",
    control: { kind: "readonly", how: "Se desactiva en los ajustes de la tienda, en «Bot de Kapso → pedidos»." },
    link: STORE_SETTINGS("bot-pedidos"),
  },
  {
    key: "yape_statement",
    group: "sin_interruptor",
    name: "Validación de pagos por Yape",
    what:
      "Con cada reporte de movimientos de Yape Empresa valida solos los comprobantes que cuadran al céntimo y, si eso completa un pedido de agencia, manda la clave de recojo.",
    effect: "Valida pagos",
    scope: "none",
    control: { kind: "readonly", how: "Se pausa en el escenario de Make que reenvía el reporte. No tiene interruptor en Kapta." },
  },
];

export type SwitchableEntry = AutomationEntry & { control: Extract<AutomationControl, { kind: "org_table" | "store_column" }> };

/** Un interruptor de encendido/apagado (no las tres posiciones de `org_mode`, ni lo de solo lectura). */
export function isSwitchable(entry: AutomationEntry): entry is SwitchableEntry {
  return entry.control.kind === "org_table" || entry.control.kind === "store_column";
}

export function automationEntry(key: unknown): AutomationEntry | null {
  if (typeof key !== "string") return null;
  return AUTOMATIONS.find((entry) => entry.key === key) ?? null;
}

/**
 * LA LISTA BLANCA. Los únicos pares tabla/columna que el panel puede escribir.
 * Sale del catálogo, no se escribe aparte: si una entrada deja de ser un
 * interruptor, deja de poder escribirse.
 */
export const AUTOMATION_WRITE_WHITELIST: readonly { key: string; table: OrgAutomationTable | "stores"; column: string }[] = AUTOMATIONS.filter(isSwitchable).map(
  (entry) => ({
    key: entry.key,
    table: entry.control.kind === "org_table" ? entry.control.table : "stores",
    column: entry.control.column,
  }),
);

export function isWhitelisted(table: string, column: string): boolean {
  return AUTOMATION_WRITE_WHITELIST.some((w) => w.table === table && w.column === column);
}

/** La entrada que se puede encender, del alcance pedido; null si no es un interruptor de ese tipo. */
export function switchableEntry(key: unknown, kind: "org_table"): (SwitchableEntry & { control: { kind: "org_table" } }) | null;
export function switchableEntry(key: unknown, kind: "store_column"): (SwitchableEntry & { control: { kind: "store_column" } }) | null;
export function switchableEntry(key: unknown, kind: "org_table" | "store_column"): SwitchableEntry | null {
  const entry = automationEntry(key);
  if (!entry || !isSwitchable(entry) || entry.control.kind !== kind) return null;
  const table = entry.control.kind === "org_table" ? entry.control.table : "stores";
  // Doble llave: el catálogo y la lista blanca tienen que coincidir.
  return isWhitelisted(table, entry.control.column) ? entry : null;
}

/** Las columnas de `stores` que el panel lee: los interruptores y sus requisitos. */
export const STORE_AUTOMATION_COLUMNS: readonly string[] = [
  ...new Set(
    AUTOMATIONS.flatMap((entry) =>
      entry.control.kind === "store_column" ? [entry.control.column, ...(entry.control.requires ? [entry.control.requires] : [])] : [],
    ),
  ),
];

/** ¿Encenderla tiene un efecto fuera de Kapta que no se deshace? */
export function needsConfirmation(entry: Pick<AutomationEntry, "effect">): boolean {
  return EXTERNAL_EFFECTS.includes(entry.effect);
}

const CONSEQUENCE: Partial<Record<AutomationEffect, string>> = {
  "Crea guías": "Kapta creará guías de verdad sin que nadie las apruebe.",
  "Envía WhatsApp": "Kapta enviará mensajes de WhatsApp a clientas sin que nadie los revise.",
  "Llama a clientas": "El agente llamará a clientas sin que nadie lo dispare.",
  "Confirma pedidos": "Kapta confirmará pedidos y creará sus guías sin que una asesora los revise.",
};

/** El texto de `window.confirm` al encender. Puro. */
export function confirmationText(entry: Pick<AutomationEntry, "name" | "effect">, storeName?: string | null): string {
  const where = storeName ? ` en ${storeName}` : "";
  return `¿Encender «${entry.name}»${where}? ${CONSEQUENCE[entry.effect] ?? ""}`.trim();
}

/**
 * Por qué no se puede cambiar el interruptor, o null si se puede. Encender
 * algo cuyo requisito está apagado se rechaza: el automático no haría nada y
 * el panel diría «Encendido». Apagar siempre se puede. Pura.
 */
export function switchRefusal(entry: AutomationEntry, opts: { on: boolean; rowExists: boolean; requiresOn: boolean }): string | null {
  if (!opts.rowExists) return "Esta automatización no está configurada en tu organización.";
  if (opts.on && entry.control.kind !== "readonly" && entry.control.requires && !opts.requiresOn) {
    return entry.requiresReason ?? "Falta encender antes lo que esta automatización necesita.";
  }
  return null;
}

/**
 * Lo que se escribe en la fila de configuración de la organización. Encender
 * a mano el Swayp de Por confirmar borra el motivo de su freno automático,
 * igual que `cambiarAutomaticoPc`: alguien decidió seguir. Pura.
 */
export function orgSwitchPatch(
  table: OrgAutomationTable,
  column: string,
  on: boolean,
  actor: string | null,
  nowIso: string,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { [column]: on, updated_at: nowIso };
  if (ORG_TABLE_SHAPE[table].updatedBy) patch.updated_by = actor;
  if (table === "swayp_pc_auto_settings" && column === "enabled") {
    patch.paused_reason = null;
    patch.paused_at = on ? null : nowIso;
  }
  return patch;
}

/** El tope del día de los reintentos, o null si no es un entero dentro del rango. Pura. */
export function parseRetryDailyCap(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < RETRY_DAILY_CAP_MIN || n > RETRY_DAILY_CAP_MAX) return null;
  return n;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

// ── El historial del panel (`automation_switch_events`) ─────────────────────

/** Los valores que se guardan en el historial para un interruptor. */
export const SWITCH_ON = "encendido";
export const SWITCH_OFF = "apagado";
export function switchValue(on: boolean): string {
  return on ? SWITCH_ON : SWITCH_OFF;
}

/** La clave del historial de una variante de los reintentos de Lima. */
export const RETRY_EVENT_PREFIX = "lima_retry:";
export const RETRY_CAP_EVENT = "lima_retry_cap";
/** «Usar la ubicación por dirección (Google)» de los reintentos de Lima (0308). */
export const RETRY_GEOCODE_EVENT = "lima_retry_geocode";
export function retryVariantEventKey(variant: string): string {
  return `${RETRY_EVENT_PREFIX}${variant}`;
}

/** La regla automática de la «Lista de pago adelantado» (0309, MOM §41). */
export const PREPAY_MODE_EVENT = "prepay_list_auto";

/** Los interruptores y topes del agente de IA (Conector de IA, 0323, MOM §42.9). */
export const AGENT_WHATSAPP_MODE_EVENT = "agent_whatsapp_mode";
export const AGENT_GUIDE_MODE_EVENT = "agent_guide_mode";
export const AGENT_WHATSAPP_CAP_EVENT = "agent_whatsapp_cap";
export const AGENT_GUIDE_CAP_EVENT = "agent_guide_cap";

/** El nombre de lo que cambió, para «Últimos cambios». Pura. */
export function automationEventLabel(key: string): string {
  if (key === AGENT_WHATSAPP_MODE_EVENT) return "Agente de IA · WhatsApp a la clienta";
  if (key === AGENT_GUIDE_MODE_EVENT) return "Agente de IA · guías de Aliclik";
  if (key === AGENT_WHATSAPP_CAP_EVENT) return "Agente de IA · tope de WhatsApp del día";
  if (key === AGENT_GUIDE_CAP_EVENT) return "Agente de IA · tope de guías del día";
  if (key === PREPAY_MODE_EVENT) return "Lista de pago adelantado · regla automática";
  if (key === RETRY_CAP_EVENT) return "Reintentos Aliclik · tope del día";
  if (key === RETRY_GEOCODE_EVENT) return "Reintentos Aliclik · ubicación por dirección (Google)";
  if (key.startsWith(RETRY_EVENT_PREFIX)) {
    const variant = key.slice(RETRY_EVENT_PREFIX.length);
    return isRetryVariant(variant) ? `Reintentos Aliclik · ${retryVariantLabel(variant)}` : "Reintentos Aliclik";
  }
  return automationEntry(key)?.name ?? key;
}

/** Un valor del historial en palabras. Pura. */
export function automationValueLabel(key: string, value: string | null): string {
  if (value == null || value === "") return "Sin configurar";
  if (value === SWITCH_ON) return "Encendido";
  if (value === SWITCH_OFF) return "Apagado";
  if (isRetryMode(value)) return RETRY_MODE_LABEL[value];
  if (key === RETRY_CAP_EVENT && /^\d+$/.test(value)) return `${value} ${value === "1" ? "guía" : "guías"} al día`;
  if (key === AGENT_GUIDE_CAP_EVENT && /^\d+$/.test(value)) return `${value} ${value === "1" ? "guía" : "guías"} al día`;
  if (key === AGENT_WHATSAPP_CAP_EVENT && /^\d+$/.test(value)) return `${value} ${value === "1" ? "mensaje" : "mensajes"} al día`;
  return value;
}

// ── Enlaces y fechas ────────────────────────────────────────────────────────

export function storeSettingsHref(storeId: string, section: string): string {
  return `/dashboard/${storeId}/settings#${section}`;
}

/** Las páginas del panel que muestran lo que cambia una entrada: se revalidan al cambiarla. */
export function detailPaths(entry: AutomationEntry, storeId?: string | null): string[] {
  if (!entry.link) return [];
  if (entry.link.kind === "page") return [entry.link.href];
  return storeId ? [`/dashboard/${storeId}/settings`] : [];
}

/** «04/11 · 9:41 a. m.» en hora de Lima. Se formatea en el servidor para que no cambie al hidratar. */
export function formatLimaDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  return `${day} · ${time}`;
}

/** «Kenku Peru», «Kenku Peru y Aurela», «Kenku Peru, Aurela y Biru». Pura. */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}
