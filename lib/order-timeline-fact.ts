// Qué hecho es cada movimiento de la Actividad de la ficha, para darle icono y
// tono (pedido del owner, 13-10-2026: «que los importantes tipo entregado o
// reprogramado o pedido generado tengan su icono, para que sean más
// digeribles»).
//
// DOS NIVELES. Los HITOS cambian el rumbo del pedido (se generó, se confirmó,
// salió, se reprogramó, se entregó, volvió, se anuló, se cobró) y llevan el
// tono de la parte del recorrido a la que pertenecen: los matices de
// macroetapa del MOM §25 (ámbar confirmación y pagos, celeste preparación,
// índigo despacho, cian seguimiento, naranja cierre, verde completado). El
// resto —llamadas, mensajes, notas, claves, barridos del courier— lleva su
// icono en gris de consulta, para que los hitos se lean primero.
//
// EL ESTADO NUEVO MANDA SOBRE EL TIPO. Un `courier_status`, un cambio manual o
// una gestión de Repro que dejan el pedido en «Entregado» son la entrega,
// aunque su tipo no lo diga: antes el punto miraba solo `kind` y la entrega de
// Swayp salía gris (#KP140633).
//
// El texto del movimiento dice lo mismo, así que ni el icono ni el color son
// nunca la única señal. Puro: lo prueba `test/order-timeline-fact.test.ts`.

import type { TimelineEntry } from "@/lib/orders-master-access";

/** El dibujo del marcador; la ficha lo traduce a un icono de `components/icons`. */
export type TimelineIcon =
  | "pedido"
  | "confirmado"
  | "llamada"
  | "agente"
  | "mensaje"
  | "nota"
  | "pago"
  | "guia"
  | "paquete"
  | "programado"
  | "despacho"
  | "motorizado"
  | "entregado"
  | "reprogramado"
  | "fallo"
  | "devuelto"
  | "anulado"
  | "expediente"
  | "clave"
  | "automatico"
  | "ubicacion"
  | "estado";

/** Las macroetapas del MOM cuyo matiz toma un hito. */
export type TimelineStage = "por_confirmar" | "preparacion" | "por_despachar" | "en_curso" | "por_cerrar" | "finalizado";

export interface TimelineFact {
  /** null: un movimiento sin dibujo propio; la ficha pinta un punto. */
  icon: TimelineIcon | null;
  /** null: no es hito y va en gris de consulta. */
  stage: TimelineStage | null;
}

export type TimelineFactInput = Pick<TimelineEntry, "kind" | "newStatus" | "origin"> & {
  leadStatus?: string | null;
};

const hito = (icon: TimelineIcon, stage: TimelineStage): TimelineFact => ({ icon, stage });
const consulta = (icon: TimelineIcon | null): TimelineFact => ({ icon, stage: null });

/** Tipos cuyo estado nuevo es el de la salida o del pedido (no el de un pago). */
const PAGO_KINDS = new Set(["payment", "payment_recipient_exception"]);

const POR_KIND: Record<string, TimelineFact> = {
  // Confirmación (ámbar): nace el pedido y el cliente dice que sí.
  created: hito("pedido", "por_confirmar"),
  lead_sale: hito("pedido", "por_confirmar"),
  confirmed: hito("confirmado", "por_confirmar"),
  confirmation_contact: consulta("llamada"),
  browser_call: consulta("llamada"),
  confirmation_followup: consulta("programado"),
  aliclik_risk_exception: consulta("pago"),
  payment_recipient_exception: consulta("pago"),

  // Preparación (celeste): la guía o la salida existe.
  guide_created: hito("guia", "preparacion"),
  guide_registered: hito("guia", "preparacion"),
  route_output_created: hito("guia", "preparacion"),
  route_output_filled: consulta("guia"),
  guide_link_updated: consulta("guia"),
  guide_check: consulta("guia"),
  courier_assigned: consulta("guia"),
  courier_change: consulta("guia"),
  olva_tracking_linked: consulta("guia"),
  additional_output_reason: consulta("guia"),
  package_ready: consulta("paquete"),
  package_added: consulta("paquete"),
  package_removed: consulta("paquete"),
  manifest_created: consulta("paquete"),
  companion_linked: consulta("paquete"),
  companion_unlinked: consulta("paquete"),
  dispatch_programmed: consulta("programado"),
  dispatch_program_cleared: consulta("programado"),
  dispatch_program_overridden: consulta("programado"),
  dispatch_date_set: consulta("programado"),
  dispatch_date_cleared: consulta("programado"),
  aliclik_auto_guide_failed: consulta("guia"),

  // Despacho (índigo): el paquete sale de nuestras manos.
  swayp_desde_por_confirmar: hito("despacho", "por_despachar"),
  dispatched: hito("despacho", "por_despachar"),
  handed_to_courier: hito("despacho", "por_despachar"),
  custody_transferred: hito("despacho", "por_despachar"),
  pickup_checked: hito("despacho", "por_despachar"),
  logistics_request_accepted: consulta("despacho"),
  dispatch_route_assigned: consulta("despacho"),
  dispatch_route_reassigned: consulta("despacho"),
  office_checked: consulta("expediente"),

  // Seguimiento (cian): en la calle, y lo que pasa allí.
  out_for_delivery: hito("despacho", "en_curso"),
  reschedule: hito("reprogramado", "en_curso"),
  reroute: hito("reprogramado", "en_curso"),
  logistics_request_rescheduled: hito("reprogramado", "en_curso"),
  lima_repro_agreed: hito("reprogramado", "en_curso"),
  attempt_failed: hito("fallo", "en_curso"),
  pickup_declined: hito("fallo", "en_curso"),
  courier_status: consulta("despacho"),
  courier_report: consulta("fallo"),
  stop_reported: consulta("motorizado"),
  novelty_solved: consulta("estado"),
  urpi_observation_resolved: consulta("estado"),
  lima_repro_call: consulta("llamada"),
  lima_repro_closed: consulta("expediente"),
  call: consulta("llamada"),

  // Completado (verde).
  delivered: hito("entregado", "finalizado"),
  delivery_declared: hito("entregado", "finalizado"),
  delivered_unconfirmed_pickup: hito("entregado", "finalizado"),
  liquidation_closed: hito("pago", "finalizado"),
  order_finalized: hito("expediente", "finalizado"),

  // Cierre (naranja): vuelve, se anula o queda una cuenta abierta.
  cancelled_shopify: hito("anulado", "por_cerrar"),
  cancelled_woocommerce: hito("anulado", "por_cerrar"),
  return_started: hito("devuelto", "por_cerrar"),
  return_requested: hito("devuelto", "por_cerrar"),
  return_received: hito("devuelto", "por_cerrar"),
  returned: hito("devuelto", "por_cerrar"),
  returned_to_office: hito("devuelto", "por_cerrar"),
  customer_return_started: hito("devuelto", "por_cerrar"),
  customer_return_resolved: hito("devuelto", "por_cerrar"),
  refund_requested: hito("pago", "por_cerrar"),
  refund_completed: hito("pago", "por_cerrar"),
  liquidation_observed: hito("pago", "por_cerrar"),
  indemnity_requested: hito("pago", "por_cerrar"),
  indemnity_resolved: hito("pago", "por_cerrar"),
  courier_loss_declared: hito("fallo", "por_cerrar"),
  inventory_reconciled: consulta("paquete"),
  merma_closed: consulta("expediente"),
  guide_cancelled: consulta("anulado"),
  route_output_cancelled: consulta("anulado"),
  manifest_cancelled: consulta("anulado"),
  recovery_discarded: consulta("anulado"),
  confirmation_cancellation_task_created: consulta("anulado"),

  // Consulta (gris).
  order_reopened: consulta("expediente"),
  // El pedido vuelve a estar vivo en WooCommerce (MOM §38.3): su macroetapa la
  // decide el Master, no este hecho.
  reactivated_woocommerce: consulta("estado"),
  customer_name_update_requested: consulta("expediente"),
  customer_name_updated: consulta("expediente"),
  route_reopened: consulta("expediente"),
  key_registered: consulta("clave"),
  key_view: consulta("clave"),
  key_shared: consulta("clave"),
  whatsapp_template: consulta("mensaje"),
  coverage_changed: consulta("ubicacion"),
  aliclik_duplicate_resolution: consulta("estado"),
  status_override: consulta("estado"),
  state_change: consulta("estado"),
  comment: consulta("nota"),
  note: consulta("nota"),
  system: consulta("automatico"),
  lead_call: consulta("llamada"),
  lead_message: consulta("mensaje"),
  lead_note: consulta("nota"),
  lead_state_change: consulta("estado"),
  lead_system: consulta("automatico"),
  lead_voice_agent: consulta("agente"),
};

/**
 * De dónde salió un movimiento, para la línea de la fecha: «Repro Provincia»,
 * «Leads», «WooCommerce» (los hechos que escribe la entrada de WooCommerce,
 * MOM §38.3) o la fuente guardada tal cual (`shopify`, `aliclik`, `manual`…).
 */
export function timelineOriginLabel(t: Pick<TimelineEntry, "origin" | "source">): string {
  if (t.origin === "gestion") return "Repro Provincia";
  if (t.origin === "leads") return "Leads";
  if (t.source === "woocommerce") return "WooCommerce";
  return t.source;
}

export function timelineFact(t: TimelineFactInput): TimelineFact {
  // De Leads: el lead pasó a «Pedido generado». Es el nacimiento del pedido
  // aunque lo escriba el automático o una llamada.
  if (t.origin === "leads" && t.leadStatus === "pedido_generado") return hito("pedido", "por_confirmar");

  // Un pago lleva su propio estado (validado, rechazado…), no el del pedido.
  if (t.kind === "payment") {
    if (t.newStatus === "validado" || t.newStatus === "rechazado") return hito("pago", "por_confirmar");
    return consulta("pago");
  }
  if (!PAGO_KINDS.has(t.kind)) {
    if (t.newStatus === "entregado") return hito("entregado", "finalizado");
    if (t.newStatus === "devuelto") return hito("devuelto", "por_cerrar");
    if (t.newStatus === "anulado") {
      // El pedido anulado a mano es un hito; una guía que el courier da por
      // anulada (el barrido de Aliclik, una gestión de Repro) es una corrección.
      return t.kind === "status_override" ? hito("anulado", "por_cerrar") : consulta("anulado");
    }
  }
  return POR_KIND[t.kind] ?? consulta(null);
}
