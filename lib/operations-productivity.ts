import type { DateRange } from "./access";

export const PRODUCTIVITY_SECTIONS = [
  ["resumen", "Resumen"],
  ["leads", "Leads"],
  ["master", "Master de Pedidos"],
  ["repro_provincia", "Repro Provincia"],
  ["repro_lima", "Repro Lima"],
  ["diferencia", "Pago de diferencia"],
  ["pagos", "Validación de pagos"],
  ["almacen", "Almacén"],
  ["despacho", "Despacho y liquidación"],
] as const;
export type ProductivitySection = (typeof PRODUCTIVITY_SECTIONS)[number][0];
export function productivitySection(value: unknown): ProductivitySection {
  return PRODUCTIVITY_SECTIONS.some(([key]) => key === value)
    ? (value as ProductivitySection)
    : "resumen";
}
export const SECTION_DESCRIPTIONS: Record<ProductivitySection, string> = {
  resumen:
    "El trabajo registrado de cada persona, de la venta al cierre operativo.",
  leads: "Llamadas, gestión de leads y ventas atribuidas.",
  master:
    "Contactos de confirmación, pedidos confirmados y actividad general del pedido.",
  repro_provincia: "Gestiones y nuevas fechas registradas en Repro Provincia.",
  repro_lima: "Llamadas, fechas acordadas y resultados de Repro Lima.",
  diferencia:
    "Gestión de cobranza, diferencias registradas y claves compartidas.",
  pagos:
    "Comprobantes registrados y pagos validados por una persona, incluidos adelantos y diferencias.",
  almacen: "Armado, recepción de retornos y retiro de paquetes.",
  despacho:
    "Asignación, cotejo, entrega de custodia, reportes y cierre de liquidaciones.",
};
export interface ActivityDetail {
  id: string;
  at: string;
  area: string;
  action: string;
  orderId: string | null;
  orderName: string | null;
  leadId: string | null;
  amount: number;
  outcome: string | null;
}
export interface ActivityCell {
  count: number;
  orders: number;
  amount?: number;
}
export interface OperationsPerson {
  userId: string;
  name: string;
  actions: number;
  objects: number;
  orders: number;
  leads: number;
  hours: number;
  lastAt: string;
  unclassifiedContacts: number;
  counts: Record<string, ActivityCell>;
  areas: Record<string, ActivityCell>;
  heat: Record<string, number>;
  recent: ActivityDetail[];
}
export interface OperationsData {
  people: OperationsPerson[];
  totals: {
    actions: number;
    orders: number;
    leads: number;
    people: number;
    unclassifiedContacts: number;
  };
  asOf: string;
}
export const ACTIVITY_LABELS: Record<string, string> = {
  confirmation_contact: "Contacto de confirmación",
  confirmed: "Confirmación registrada",
  comment: "Comentario",
  chatby_message: "WhatsApp por Chatby",
  kapso_message: "WhatsApp por Kapso",
  browser_call: "Llamada desde Kapta",
  anura_call: "Llamada con Anura",
  status_override: "Estado registrado a mano",
  dispatch_date_set: "Fecha de despacho acordada",
  guide_created: "Guía creada",
  guide_registered: "Guía registrada",
  cancelled_woocommerce: "Pedido anulado",
  legacy_shopify_sale_cancelled: "Venta histórica anulada",
  woo_sale_ended_pending_return: "Venta terminada, retorno pendiente",
  customer_name_updated: "Nombre corregido",
  coverage_changed: "Cobertura corregida",
  key_shared: "Clave compartida",
  key_registered: "Clave registrada",
  package_ready: "Paquete armado",
  package_removed: "Paquete retirado",
  return_received: "Devolución recibida",
  returned_to_office: "Retorno recibido en oficina",
  office_checked: "Cotejo de oficina",
  pickup_checked: "Cotejo de recojo",
  custody_transferred: "Custodia entregada",
  dispatch_route_assigned: "Asignado a ruta",
  dispatch_route_reassigned: "Reasignado de ruta",
  stop_reported: "Parada reportada",
  liquidation_closed: "Liquidación cerrada",
  province_rescheduled: "Entrega reprogramada",
  province_call: "Gestión de llamada",
  province_management: "Gestión de envío",
  lima_scheduled: "Fecha de entrega acordada",
  lima_management: "Gestión de Repro Lima",
  payment_registered: "Comprobante registrado",
  payment_validated: "Pago validado",
  lead_call: "Llamada de lead",
  lead_management: "Gestión de lead",
  sale_closed: "Venta registrada",
};
export const OUTCOME_LABELS: Record<string, string> = {
  confirma: "Confirma fecha",
  confirmado: "Confirmado",
  no_contesta: "No contesta",
  no_quiere: "Ya no lo quiere",
  llamar_despues: "Llamar después",
  en_ruta: "En ruta",
  pendiente: "Pendiente",
  anulado: "Anulado",
  adelanto: "Adelanto",
  diferencia: "Diferencia",
  total: "Pago total",
  sin_respuesta: "Sin respuesta",
  se_deja_mensaje: "Se dejó mensaje",
  volver_a_contactar: "Volver a contactar",
  pendiente_de_abono: "Pendiente de abono",
};
export function productivityHref(
  section: ProductivitySection,
  range: DateRange,
  store: string | null = null,
  month: string | null = null,
  source: string | null = null,
) {
  const query = new URLSearchParams({
    area: section,
    ...(month ? { mes: month } : range),
  });
  if (store) query.set("store", store);
  if (section === "leads" && source) query.set("src", source);
  return `/dashboard/productividad?${query}`;
}
export interface ActivityMetric {
  key: string;
  label: string;
  actions: string[];
  amount?: boolean;
  distinctOrders?: boolean;
}
export const SECTION_METRICS: Record<
  Exclude<ProductivitySection, "leads">,
  ActivityMetric[]
> = {
  resumen: [
    {
      key: "sales",
      label: "Ventas",
      actions: ["sale_closed"],
      distinctOrders: true,
    },
    {
      key: "confirmed",
      label: "Confirmados",
      actions: ["confirmed"],
      distinctOrders: true,
    },
    {
      key: "province",
      label: "Repro Provincia",
      actions: ["province_rescheduled"],
    },
    { key: "lima", label: "Fechas Lima", actions: ["lima_scheduled"] },
    {
      key: "validated",
      label: "Pagos validados",
      actions: ["payment_validated"],
    },
    { key: "ready", label: "Armados", actions: ["package_ready"] },
  ],
  master: [
    {
      key: "contacts",
      label: "Contactos",
      actions: ["confirmation_contact", "confirmed"],
    },
    {
      key: "confirmed",
      label: "Confirmados",
      actions: ["confirmed"],
      distinctOrders: true,
    },
    {
      key: "guides",
      label: "Guías",
      actions: ["guide_created", "guide_registered"],
    },
  ],
  repro_provincia: [
    {
      key: "calls",
      label: "Otras gestiones",
      actions: ["province_call", "province_management"],
    },
    {
      key: "rescheduled",
      label: "Reprogramaciones",
      actions: ["province_rescheduled"],
    },
  ],
  repro_lima: [
    {
      key: "scheduled",
      label: "Fechas acordadas",
      actions: ["lima_scheduled"],
    },
    { key: "other", label: "Otras gestiones", actions: ["lima_management"] },
  ],
  diferencia: [
    {
      key: "registered",
      label: "Diferencias registradas",
      actions: ["payment_registered"],
    },
    {
      key: "validated",
      label: "Diferencias validadas",
      actions: ["payment_validated"],
    },
    { key: "keys", label: "Claves compartidas", actions: ["key_shared"] },
  ],
  pagos: [
    {
      key: "registered",
      label: "Registrados",
      actions: ["payment_registered"],
    },
    { key: "validated", label: "Validados", actions: ["payment_validated"] },
    {
      key: "amount",
      label: "Monto validado",
      actions: ["payment_validated"],
      amount: true,
    },
  ],
  almacen: [
    { key: "ready", label: "Armados", actions: ["package_ready"] },
    {
      key: "returned",
      label: "Retornos recibidos",
      actions: ["return_received", "returned_to_office"],
    },
    { key: "removed", label: "Retirados", actions: ["package_removed"] },
  ],
  despacho: [
    {
      key: "assigned",
      label: "Asignaciones",
      actions: ["dispatch_route_assigned", "dispatch_route_reassigned"],
    },
    {
      key: "checked",
      label: "Cotejos",
      actions: ["office_checked", "pickup_checked"],
    },
    { key: "reported", label: "Reportes", actions: ["stop_reported"] },
    { key: "closed", label: "Cierres", actions: ["liquidation_closed"] },
  ],
};
export function activityMetric(
  person: Pick<OperationsPerson, "counts">,
  metric: ActivityMetric,
): number {
  return metric.actions.reduce(
    (n, action) =>
      n +
      (metric.amount
        ? (person.counts[action]?.amount ?? 0)
        : metric.distinctOrders
          ? (person.counts[action]?.orders ?? 0)
          : (person.counts[action]?.count ?? 0)),
    0,
  );
}
