// MOM v1 — macroetapas calculadas del Master de Pedidos.
//
// Es la navegación operativa principal del Master de Pedidos. Los estados
// `general_status` / `operational_status` se conservan como compatibilidad y
// evidencia histórica, pero las colas del equipo se organizan con el MOM.

export const MOM_RESOLUTION_VERSION = "mom-v1" as const;

export type OrderMacroStage =
  | "por_confirmar"
  | "preparacion"
  | "por_despachar"
  | "en_curso"
  | "por_cerrar"
  | "finalizado";

export interface MacroStageDef {
  code: OrderMacroStage;
  label: string;
  order: number;
}

export const ORDER_MACRO_STAGES: readonly MacroStageDef[] = [
  { code: "por_confirmar", label: "Por confirmar", order: 1 },
  { code: "preparacion", label: "Preparación", order: 2 },
  { code: "por_despachar", label: "Por despachar", order: 3 },
  { code: "en_curso", label: "En curso", order: 4 },
  { code: "por_cerrar", label: "Por cerrar", order: 5 },
  { code: "finalizado", label: "Finalizado", order: 6 },
] as const;

export type MacroSubstage =
  // Por confirmar
  | "sin_llamar"
  | "por_confirmar"
  | "volver_a_contactar"
  | "ultimo_intento"
  | "pago_requerido_pendiente"
  // Preparación
  | "por_generar_rotulo"
  | "por_armar"
  | "incidencia_preparacion"
  // Por despachar
  | "listo_para_asignar"
  | "asignado_a_ruta"
  | "en_cotejo"
  | "cotejo_incompleto"
  | "listo_para_recojo"
  | "retirado_del_manifiesto"
  // En curso
  | "recibido_por_courier"
  | "en_transito"
  | "en_destino"
  | "en_reparto"
  | "disponible_para_recojo"
  | "pendiente_pago_diferencia"
  | "por_reprogramar_lima"
  | "gestion_reproprovincia"
  | "salida_swayp_programada"
  | "retorno_solicitado"
  | "en_retorno"
  // Por cerrar
  | "pendiente_liquidacion"
  | "liquidacion_observada"
  | "salida_adicional_activa"
  | "devolucion_fisica_pendiente"
  | "devolucion_pendiente_inventario"
  | "recogido_sin_pago_completo"
  | "indemnizacion_pendiente"
  | "merma_pendiente"
  | "reembolso_pendiente"
  | "devolucion_cliente"
  | "validacion_cierre_pendiente"
  // Finalizado
  | "entregado_cerrado"
  | "recogido_cerrado"
  | "anulado_cerrado"
  | "devuelto_cerrado"
  | "incidencia_cerrada"
  | "merma_cerrada";

/** Orden canónico de subetapas dentro de cada macroetapa del MOM. */
export const MACRO_SUBSTAGES_BY_STAGE: Record<
  OrderMacroStage,
  readonly MacroSubstage[]
> = {
  por_confirmar: [
    "sin_llamar",
    "por_confirmar",
    "volver_a_contactar",
    "ultimo_intento",
    "pago_requerido_pendiente",
  ],
  preparacion: ["por_generar_rotulo", "por_armar", "incidencia_preparacion"],
  por_despachar: [
    "listo_para_asignar",
    "asignado_a_ruta",
    "en_cotejo",
    "cotejo_incompleto",
    "listo_para_recojo",
    "retirado_del_manifiesto",
  ],
  en_curso: [
    "recibido_por_courier",
    "en_transito",
    "en_destino",
    "en_reparto",
    "disponible_para_recojo",
    "pendiente_pago_diferencia",
    "por_reprogramar_lima",
    "gestion_reproprovincia",
    "salida_swayp_programada",
    "retorno_solicitado",
    "en_retorno",
  ],
  por_cerrar: [
    "pendiente_liquidacion",
    "liquidacion_observada",
    "salida_adicional_activa",
    "devolucion_fisica_pendiente",
    "devolucion_pendiente_inventario",
    "recogido_sin_pago_completo",
    "indemnizacion_pendiente",
    "merma_pendiente",
    "reembolso_pendiente",
    "devolucion_cliente",
    "validacion_cierre_pendiente",
  ],
  finalizado: [
    "entregado_cerrado",
    "recogido_cerrado",
    "anulado_cerrado",
    "devuelto_cerrado",
    "incidencia_cerrada",
    "merma_cerrada",
  ],
};

export const MACRO_SUBSTAGE_LABEL: Record<MacroSubstage, string> = {
  sin_llamar: "Sin llamar",
  por_confirmar: "Por confirmar",
  volver_a_contactar: "Volver a contactar",
  ultimo_intento: "Último intento",
  pago_requerido_pendiente: "Pago requerido pendiente",
  por_generar_rotulo: "Por generar rótulo",
  por_armar: "Por armar",
  incidencia_preparacion: "Incidencia de preparación",
  listo_para_asignar: "Listo para asignar",
  asignado_a_ruta: "Asignado a ruta",
  en_cotejo: "En cotejo",
  cotejo_incompleto: "Cotejo incompleto",
  listo_para_recojo: "Listo para recojo",
  retirado_del_manifiesto: "Retirado del manifiesto",
  recibido_por_courier: "Recibido por courier",
  en_transito: "En tránsito",
  en_destino: "En destino",
  en_reparto: "En reparto",
  disponible_para_recojo: "Disponible para recojo",
  pendiente_pago_diferencia: "Pendiente de pago de diferencia",
  por_reprogramar_lima: "Por reprogramar Lima",
  gestion_reproprovincia: "En gestión Reproprovincia",
  salida_swayp_programada: "Salida Swayp programada",
  retorno_solicitado: "Retorno solicitado",
  en_retorno: "En retorno",
  pendiente_liquidacion: "Pendiente de liquidación",
  liquidacion_observada: "Liquidación observada",
  salida_adicional_activa: "Salida adicional activa",
  devolucion_fisica_pendiente: "Devolución física pendiente",
  devolucion_pendiente_inventario: "Devolución pendiente de inventario",
  recogido_sin_pago_completo: "Recogido sin pago completo",
  indemnizacion_pendiente: "Indemnización pendiente",
  merma_pendiente: "Merma pendiente",
  reembolso_pendiente: "Reembolso pendiente",
  devolucion_cliente: "Devolución del cliente",
  validacion_cierre_pendiente: "Validación de cierre pendiente",
  entregado_cerrado: "Entregado y cerrado",
  recogido_cerrado: "Recogido y cerrado",
  anulado_cerrado: "Anulado y cerrado",
  devuelto_cerrado: "Devuelto y conciliado",
  incidencia_cerrada: "Incidencia cerrada",
  merma_cerrada: "Merma cerrada",
};

const MACRO_STAGE_LABEL = new Map(ORDER_MACRO_STAGES.map((stage) => [stage.code, stage.label]));

export function macroStageLabel(code: string | null | undefined): string {
  return MACRO_STAGE_LABEL.get(code as OrderMacroStage) ?? code ?? "—";
}

export function macroSubstageLabel(code: string | null | undefined): string {
  return code && code in MACRO_SUBSTAGE_LABEL
    ? MACRO_SUBSTAGE_LABEL[code as MacroSubstage]
    : code ?? "—";
}

export type OperationKind = "lima" | "provincia_cod" | "agencia" | "desconocida";

export interface MacroOrderSnapshot {
  created_at: string | null;
  cancelled_at: string | null;
  financial_status: string | null;
  shipping_mode: string | null;
  region: string | null;
  province: string | null;
  district: string | null;
}

export interface MacroGuideSnapshot {
  id: string;
  courier: string;
  delivery_status: string;
  attempts: number;
  assigned_at: string | null;
  dispatched_at: string | null;
  out_for_delivery_at: string | null;
  rescheduled_at: string | null;
  returned_at: string | null;
  pickup_state: string | null;
  /** no_iniciado | rotulo_generado | en_armado | listo_despacho | incidencia */
  preparation_state?: string | null;
  /** empresa | courier | retorno | devuelto */
  custody_state?: string | null;
}

export interface MacroEventSnapshot {
  kind: string;
  occurred_at: string;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface LegacyOrderStateSnapshot {
  general: string;
  operational: string;
  since: string | null;
}

export interface ResolveMacroStageInput {
  order: MacroOrderSnapshot;
  guides: readonly MacroGuideSnapshot[];
  events: readonly MacroEventSnapshot[];
  legacy: LegacyOrderStateSnapshot;
  paymentState?: string | null;
}

export interface ResolvedMacroStage {
  stage: OrderMacroStage;
  substage: MacroSubstage;
  since: string | null;
  /** Motivos abiertos. Puede haber más de uno en Por cerrar. */
  reasons: MacroSubstage[];
  operation: OperationKind;
  version: typeof MOM_RESOLUTION_VERSION;
}

function normalize(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

const AGENCY_COURIERS = new Set(["shalom", "olva"]);

/** Clasificación base de modalidad. La decisión concreta del courier pertenece
 * al motor de rutas de Fase 3; aquí solo separamos Lima, Provincia COD y Agencia. */
export function classifyOperation(
  order: Pick<MacroOrderSnapshot, "shipping_mode" | "region" | "province">,
  guides: readonly Pick<MacroGuideSnapshot, "courier">[] = [],
): OperationKind {
  if (
    normalize(order.shipping_mode) === "agency" ||
    guides.some((guide) => AGENCY_COURIERS.has(normalize(guide.courier)))
  ) {
    return "agencia";
  }
  const geo = `${normalize(order.region)} ${normalize(order.province)}`;
  if (/\b(lima|callao)\b/.test(geo)) return "lima";
  if (normalize(order.shipping_mode) === "cod") return "provincia_cod";
  // Muchos pedidos históricos de Shopify no traen `shipping_mode`. Una
  // geografía no-Lima sigue siendo Provincia COD; Agencia se vuelve explícita
  // cuando el equipo elige Shalom u Olva.
  if (geo.trim()) return "provincia_cod";
  return "desconocida";
}

function latestEvent(
  events: readonly MacroEventSnapshot[],
  kinds: readonly string[],
): MacroEventSnapshot | null {
  const allowed = new Set(kinds);
  let latest: MacroEventSnapshot | null = null;
  for (const event of events) {
    if (!allowed.has(event.kind)) continue;
    if (!latest || event.occurred_at > latest.occurred_at) latest = event;
  }
  return latest;
}

function isWorkflowOpen(
  events: readonly MacroEventSnapshot[],
  starts: readonly string[],
  closes: readonly string[],
): boolean {
  const opened = latestEvent(events, starts);
  if (!opened) return false;
  const closed = latestEvent(events, closes);
  return !closed || closed.occurred_at < opened.occurred_at;
}

function maxIso(...values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (value && (!best || value > best)) best = value;
  }
  return best;
}

function hasExternalCustody(guide: MacroGuideSnapshot): boolean {
  return (
    guide.custody_state === "courier" ||
    guide.custody_state === "retorno" ||
    Boolean(guide.dispatched_at || guide.out_for_delivery_at) ||
    ["en_ruta", "entregado", "transferido"].includes(guide.delivery_status)
  );
}

function hasReturned(guide: MacroGuideSnapshot): boolean {
  return guide.custody_state === "devuelto" || Boolean(guide.returned_at);
}

function isActiveGuide(guide: MacroGuideSnapshot): boolean {
  return !hasReturned(guide) && ["pendiente", "en_ruta"].includes(guide.delivery_status);
}

function isReadyAtCompany(guide: MacroGuideSnapshot): boolean {
  return guide.preparation_state === "listo_despacho" && !hasExternalCustody(guide);
}

function hasPaymentComplete(paymentState: string | null | undefined): boolean {
  return paymentState === "pago_completo";
}

function finalResultSubstage(legacy: LegacyOrderStateSnapshot, operation: OperationKind): MacroSubstage {
  if (legacy.general === "entregado") {
    return operation === "agencia" ? "recogido_cerrado" : "entregado_cerrado";
  }
  if (legacy.general === "devuelto") return "devuelto_cerrado";
  if (legacy.general === "anulado") return "anulado_cerrado";
  return "incidencia_cerrada";
}

function result(
  stage: OrderMacroStage,
  substage: MacroSubstage,
  since: string | null,
  operation: OperationKind,
  reasons: MacroSubstage[] = [],
): ResolvedMacroStage {
  return {
    stage,
    substage,
    since,
    reasons: reasons.length ? [...new Set(reasons)] : [],
    operation,
    version: MOM_RESOLUTION_VERSION,
  };
}

function closingReasons(input: ResolveMacroStageInput): MacroSubstage[] {
  const { guides, events, legacy, paymentState } = input;
  const reasons: MacroSubstage[] = [];
  const operation = classifyOperation(input.order, guides);
  const active = guides.filter(isActiveGuide);
  const delivered = guides.some((guide) => guide.delivery_status === "entregado");
  const closedOutside = guides.filter(
    (guide) =>
      hasExternalCustody(guide) &&
      !hasReturned(guide) &&
      guide.delivery_status !== "entregado",
  );
  const returned = guides.some(hasReturned);
  const returnedAt = maxIso(...guides.map((guide) => guide.returned_at));
  const inventoryReconciled = latestEvent(events, ["inventory_reconciled", "merma_closed"]);

  if (legacy.general === "entregado" && active.length) reasons.push("salida_adicional_activa");
  if (
    legacy.general === "entregado" &&
    operation === "agencia" &&
    !hasPaymentComplete(paymentState)
  ) {
    reasons.push("recogido_sin_pago_completo");
  }
  if (
    ["anulado", "entregado", "devuelto"].includes(legacy.general) &&
    closedOutside.length
  ) {
    reasons.push("devolucion_fisica_pendiente");
  }
  if (
    returned &&
    ["anulado", "devuelto"].includes(legacy.general) &&
    (!inventoryReconciled || Boolean(returnedAt && inventoryReconciled.occurred_at < returnedAt))
  ) {
    reasons.push("devolucion_pendiente_inventario");
  }
  if (isWorkflowOpen(events, ["liquidation_observed"], ["liquidation_closed"])) {
    reasons.push("liquidacion_observada");
  }
  if (isWorkflowOpen(events, ["refund_requested"], ["refund_completed"])) {
    reasons.push("reembolso_pendiente");
  }
  if (isWorkflowOpen(events, ["indemnity_requested"], ["indemnity_resolved"])) {
    reasons.push("indemnizacion_pendiente");
  }
  if (isWorkflowOpen(events, ["merma_pending"], ["merma_closed"])) {
    reasons.push("merma_pendiente");
  }
  if (isWorkflowOpen(events, ["customer_return_started"], ["customer_return_resolved"])) {
    reasons.push("devolucion_cliente");
  }

  const liquidationClosed = latestEvent(events, ["liquidation_closed"]);
  if (
    legacy.general === "entregado" &&
    operation !== "agencia" &&
    !liquidationClosed &&
    !reasons.includes("liquidacion_observada")
  ) {
    // El repositorio auditado todavía no contiene la fuente de liquidaciones.
    // Mantenerlo Por cerrar evita declarar un cierre financiero inventado.
    reasons.push("pendiente_liquidacion");
  }

  // Un retorno reclamado después de un resultado terminal sigue abierto aunque
  // todavía no haya `returned_at` en la guía.
  if (
    ["anulado", "entregado", "devuelto"].includes(legacy.general) &&
    isWorkflowOpen(events, ["return_started"], ["returned", "return_received"])
  ) {
    reasons.push("devolucion_fisica_pendiente");
  }

  // `delivered` puede venir de order_events aun sin guía entregada; se conserva
  // para dejar explícito que el cierre depende de la fuente financiera.
  if (legacy.general === "entregado" && !delivered && !reasons.length) {
    reasons.push("validacion_cierre_pendiente");
  }
  return [...new Set(reasons)];
}

function confirmationSubstage(input: ResolveMacroStageInput): { substage: MacroSubstage; since: string | null } {
  const { events, order } = input;
  const lastAttempt = latestEvent(events, ["confirmation_last_attempt", "last_attempt"]);
  if (lastAttempt) return { substage: "ultimo_intento", since: lastAttempt.occurred_at };

  const followup = latestEvent(events, ["confirmation_followup", "followup_scheduled", "reschedule_contact"]);
  if (followup) return { substage: "volver_a_contactar", since: followup.occurred_at };

  const contact = latestEvent(events, ["confirmation_contact", "contact_attempt", "call"]);
  if (contact) {
    if (classifyOperation(order, input.guides) === "agencia" && !hasPaymentComplete(input.paymentState)) {
      return { substage: "pago_requerido_pendiente", since: contact.occurred_at };
    }
    return { substage: "por_confirmar", since: contact.occurred_at };
  }
  return { substage: "sin_llamar", since: order.created_at };
}

function dispatchSubstage(events: readonly MacroEventSnapshot[]): { substage: MacroSubstage; since: string | null } {
  const candidates: { kinds: string[]; substage: MacroSubstage }[] = [
    { kinds: ["manifest_removed"], substage: "retirado_del_manifiesto" },
    { kinds: ["manifest_mismatch"], substage: "cotejo_incompleto" },
    { kinds: ["manifest_check_started"], substage: "en_cotejo" },
    { kinds: ["office_check_completed", "ready_for_pickup"], substage: "listo_para_recojo" },
    { kinds: ["route_assigned", "manifest_added", "courier_assigned"], substage: "asignado_a_ruta" },
  ];
  let best: { event: MacroEventSnapshot; substage: MacroSubstage } | null = null;
  for (const candidate of candidates) {
    const event = latestEvent(events, candidate.kinds);
    if (event && (!best || event.occurred_at > best.event.occurred_at)) {
      best = { event, substage: candidate.substage };
    }
  }
  return best
    ? { substage: best.substage, since: best.event.occurred_at }
    : { substage: "listo_para_asignar", since: null };
}

function inCourseSubstage(
  input: ResolveMacroStageInput,
  current: MacroGuideSnapshot,
  operation: OperationKind,
): MacroSubstage {
  if (
    current.custody_state === "retorno" ||
    current.pickup_state === "retorno_iniciado" ||
    isWorkflowOpen(input.events, ["return_started", "return_requested"], ["returned", "return_received"])
  ) {
    return "en_retorno";
  }
  if (current.pickup_state === "retorno_solicitado") return "retorno_solicitado";
  if (
    ["disponible_para_recojo", "cliente_notificado", "pendiente_de_recojo", "proximo_a_vencer"].includes(
      current.pickup_state ?? "",
    )
  ) {
    return hasPaymentComplete(input.paymentState)
      ? "disponible_para_recojo"
      : "pendiente_pago_diferencia";
  }
  if (current.out_for_delivery_at) return "en_reparto";
  if (
    current.rescheduled_at ||
    current.attempts > 0 ||
    ["pendiente_de_reprogramacion", "reprogramado", "pendiente_nuevo_courier"].includes(
      input.legacy.operational,
    )
  ) {
    return operation === "lima" ? "por_reprogramar_lima" : "gestion_reproprovincia";
  }
  if (current.pickup_state === "registrado_en_agencia" || current.pickup_state === "en_destino") {
    return "en_destino";
  }
  if (current.dispatched_at || current.delivery_status === "en_ruta") return "en_transito";
  return "recibido_por_courier";
}

function currentGuide(guides: readonly MacroGuideSnapshot[]): MacroGuideSnapshot | null {
  const active = guides.filter(isActiveGuide);
  const pool = active.length ? active : guides;
  let best: MacroGuideSnapshot | null = null;
  for (const guide of pool) {
    if (!best) {
      best = guide;
      continue;
    }
    const a = maxIso(
      guide.out_for_delivery_at,
      guide.dispatched_at,
      guide.rescheduled_at,
      guide.assigned_at,
    );
    const b = maxIso(best.out_for_delivery_at, best.dispatched_at, best.rescheduled_at, best.assigned_at);
    if (a && (!b || a > b)) best = guide;
  }
  return best;
}

/** Resuelve la macroetapa MOM v1 sin leer base de datos ni reloj. */
export function resolveMacroStage(input: ResolveMacroStageInput): ResolvedMacroStage {
  const operation = classifyOperation(input.order, input.guides);
  const active = input.guides.filter(isActiveGuide);
  const closeReasons = closingReasons(input);
  const reopened = latestEvent(input.events, ["order_reopened"]);
  const finalized = latestEvent(input.events, ["order_finalized"]);
  const explicitFinal = Boolean(
    finalized && (!reopened || finalized.occurred_at > reopened.occurred_at) && !active.length,
  );

  // Las obligaciones críticas ganan incluso sobre un cierre manual anterior.
  if (closeReasons.length) {
    return result(
      "por_cerrar",
      closeReasons[0]!,
      input.legacy.since,
      operation,
      closeReasons,
    );
  }

  if (explicitFinal) {
    return result(
      "finalizado",
      finalResultSubstage(input.legacy, operation),
      finalized?.occurred_at ?? input.legacy.since,
      operation,
    );
  }

  if (["entregado", "anulado", "devuelto"].includes(input.legacy.general)) {
    // Anulado sin una salida física puede cerrarse automáticamente.
    const everDispatched = input.guides.some(hasExternalCustody);
    if (input.legacy.general === "anulado" && !everDispatched) {
      return result("finalizado", "anulado_cerrado", input.legacy.since, operation);
    }
    const returnedAt = maxIso(...input.guides.map((guide) => guide.returned_at));
    const inventoryClosed = latestEvent(input.events, ["inventory_reconciled", "merma_closed"]);
    if (
      ["anulado", "devuelto"].includes(input.legacy.general) &&
      returnedAt &&
      inventoryClosed &&
      inventoryClosed.occurred_at >= returnedAt
    ) {
      return result(
        "finalizado",
        input.legacy.general === "devuelto" ? "devuelto_cerrado" : "anulado_cerrado",
        inventoryClosed.occurred_at,
        operation,
      );
    }
    if (
      input.legacy.general === "entregado" &&
      operation === "agencia" &&
      hasPaymentComplete(input.paymentState)
    ) {
      return result("finalizado", "recogido_cerrado", input.legacy.since, operation);
    }
    const liquidationClosed = latestEvent(input.events, ["liquidation_closed"]);
    if (input.legacy.general === "entregado" && liquidationClosed) {
      return result(
        "finalizado",
        "entregado_cerrado",
        liquidationClosed.occurred_at,
        operation,
      );
    }
    // Los demás terminales necesitan una señal explícita de cierre de sus
    // dimensiones todavía no integradas (inventario/liquidación).
    return result(
      "por_cerrar",
      "validacion_cierre_pendiente",
      input.legacy.since,
      operation,
      ["validacion_cierre_pendiente"],
    );
  }

  const current = currentGuide(input.guides);
  if (current && hasExternalCustody(current)) {
    const substage = inCourseSubstage(input, current, operation);
    return result(
      "en_curso",
      substage,
      maxIso(current.out_for_delivery_at, current.dispatched_at, current.assigned_at, input.legacy.since),
      operation,
    );
  }

  const ready = input.guides.find(isReadyAtCompany);
  if (ready) {
    const dispatch = dispatchSubstage(input.events);
    return result(
      "por_despachar",
      dispatch.substage,
      dispatch.since ?? ready.assigned_at ?? input.legacy.since,
      operation,
    );
  }

  const preparationIncident = latestEvent(input.events, ["preparation_incident"]);
  if (preparationIncident || input.guides.some((guide) => guide.preparation_state === "incidencia")) {
    return result(
      "preparacion",
      "incidencia_preparacion",
      preparationIncident?.occurred_at ?? input.legacy.since,
      operation,
    );
  }

  const confirmed =
    operation === "lima" ||
    input.guides.length > 0 ||
    Boolean(latestEvent(input.events, ["confirmed", "guide_registered", "label_generated"])) ||
    normalize(input.order.financial_status) === "paid";
  const agencyPaymentReady = operation !== "agencia" || hasPaymentComplete(input.paymentState) ||
    input.paymentState === "adelanto_validado";

  if (confirmed && agencyPaymentReady) {
    const hasLabel =
      input.guides.length > 0 ||
      Boolean(latestEvent(input.events, ["guide_registered", "label_generated"]));
    return result(
      "preparacion",
      hasLabel ? "por_armar" : "por_generar_rotulo",
      input.legacy.since ?? input.order.created_at,
      operation,
    );
  }

  const confirmation = confirmationSubstage(input);
  return result(
    "por_confirmar",
    confirmation.substage,
    confirmation.since,
    operation,
  );
}
