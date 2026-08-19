// Modelo de estado del Master de Pedidos. Puro + testeado — el equivalente de
// lib/shipments.ts, pero un nivel más arriba: shipments razona sobre UNA guía,
// esto razona sobre EL PEDIDO, que puede tener varias.
//
// Dos niveles, como pide la especificación (§2):
//   * estado GENERAL   — uno solo y vigente: pendiente | en_proceso | entregado
//                        | anulado | devuelto.
//   * estado OPERATIVO — el detalle de qué está ocurriendo dentro de ese estado
//                        general (en ruta, disponible para recojo, pendiente de
//                        reprogramación, …).
//
// Jerarquía de prioridad (§4), de mayor a menor:
//   0. Override manual auditado  — un humano decidió; nada automático lo pisa.
//   1. Entregado                 — pegajoso: ningún reporte posterior lo retrocede.
//   2. Devuelto confirmado       — exige evidencia física (despacho + guía + retorno).
//   3. Anulado                   — principalmente desde Shopify.
//   4. En proceso                — hay gestión logística iniciada sin resultado.
//   5. Pendiente                 — todavía no arrancó bien el proceso logístico.

import { hasConfirmationSignal } from "@/lib/order-confirmation";
import { cancelledAsRecordCorrection, correctedShipmentIds } from "@/lib/shipment-output";

export type GeneralStatus =
  | "pendiente"
  | "en_proceso"
  | "entregado"
  | "anulado"
  | "devuelto";

export interface GeneralStatusDef {
  code: GeneralStatus;
  label: string;
  /** Un pedido en estado terminal ya no cambia solo; solo por acción manual. */
  terminal: boolean;
}

export const GENERAL_STATUSES: GeneralStatusDef[] = [
  { code: "pendiente", label: "Pendiente", terminal: false },
  { code: "en_proceso", label: "En proceso", terminal: false },
  { code: "entregado", label: "Entregado", terminal: true },
  { code: "anulado", label: "Anulado", terminal: true },
  { code: "devuelto", label: "Devuelto", terminal: true },
];

/** Orden de prioridad para resolver conflictos entre fuentes (§4). Mayor gana. */
const GENERAL_PRIORITY: Record<GeneralStatus, number> = {
  entregado: 5,
  devuelto: 4,
  anulado: 3,
  en_proceso: 2,
  pendiente: 1,
};

export interface OperationalStatusDef {
  code: string;
  label: string;
  /** A qué estado general pertenece este estado operativo. */
  general: GeneralStatus;
}

/**
 * Catálogo de estados operativos. Cubre los tres bloques de la especificación:
 * los sub-estados de Pendiente (§3.1), los de En proceso (§3.2) y los del flujo
 * de agencia Shalom/Olva (§10), más los terminales.
 */
export const OPERATIONAL_STATUSES: OperationalStatusDef[] = [
  // ── Pendiente (§3.1)
  { code: "sin_confirmar", label: "Sin confirmar", general: "pendiente" },
  { code: "confirmado_sin_preparar", label: "Confirmado, sin preparar", general: "pendiente" },
  { code: "preparado_sin_despachar", label: "Preparado, sin despachar", general: "pendiente" },
  { code: "sin_asignar_courier", label: "Pendiente de asignación", general: "pendiente" },
  { code: "nunca_salio_a_reparto", label: "Nunca salió a reparto", general: "pendiente" },
  { code: "detenido_sin_informacion", label: "Detenido por falta de información", general: "pendiente" },
  // ── En proceso (§3.2)
  { code: "asignado_a_courier", label: "Asignado a courier", general: "en_proceso" },
  { code: "despachado", label: "Despachado", general: "en_proceso" },
  { code: "en_ruta", label: "En ruta", general: "en_proceso" },
  { code: "en_reparto", label: "En reparto", general: "en_proceso" },
  { code: "intento_de_entrega", label: "Con intento de entrega", general: "en_proceso" },
  { code: "pendiente_de_reprogramacion", label: "Pendiente de reprogramación", general: "en_proceso" },
  { code: "reprogramado", label: "Reprogramado", general: "en_proceso" },
  { code: "pendiente_nuevo_courier", label: "Pendiente de nuevo courier", general: "en_proceso" },
  { code: "espera_respuesta_cliente", label: "En espera de respuesta del cliente", general: "en_proceso" },
  { code: "en_seguimiento", label: "En seguimiento", general: "en_proceso" },
  { code: "en_traslado", label: "En traslado", general: "en_proceso" },
  { code: "en_proceso_de_retorno", label: "En proceso de retorno", general: "en_proceso" },
  // ── Agencia: Shalom / Olva (§10)
  { code: "pendiente_de_envio", label: "Pendiente de envío", general: "pendiente" },
  { code: "enviado_a_agencia", label: "Enviado a agencia", general: "en_proceso" },
  { code: "registrado_en_agencia", label: "Registrado en agencia", general: "en_proceso" },
  { code: "en_transito", label: "En tránsito", general: "en_proceso" },
  { code: "disponible_para_recojo", label: "Disponible para recojo", general: "en_proceso" },
  { code: "cliente_notificado", label: "Cliente notificado", general: "en_proceso" },
  { code: "pendiente_de_recojo", label: "Pendiente de recojo", general: "en_proceso" },
  { code: "proximo_a_vencer", label: "Próximo a vencer", general: "en_proceso" },
  { code: "retorno_iniciado", label: "Retorno iniciado", general: "en_proceso" },
  // ── Terminales
  { code: "entregado", label: "Entregado", general: "entregado" },
  { code: "recogido", label: "Recogido por el cliente", general: "entregado" },
  { code: "anulado", label: "Anulado", general: "anulado" },
  { code: "devuelto_al_origen", label: "Devuelto al origen", general: "devuelto" },
];

const GENERAL_BY_CODE = new Map(GENERAL_STATUSES.map((s) => [s.code, s]));
const OPERATIONAL_BY_CODE = new Map(OPERATIONAL_STATUSES.map((s) => [s.code, s]));

export function generalLabel(code: string): string {
  return GENERAL_BY_CODE.get(code as GeneralStatus)?.label ?? code;
}
export function operationalLabel(code: string): string {
  return OPERATIONAL_BY_CODE.get(code)?.label ?? code;
}
export function isGeneralStatus(code: string | null | undefined): code is GeneralStatus {
  return !!code && GENERAL_BY_CODE.has(code as GeneralStatus);
}
export function isOperationalStatus(code: string | null | undefined): boolean {
  return !!code && OPERATIONAL_BY_CODE.has(code);
}
export function isTerminalGeneral(code: string): boolean {
  return GENERAL_BY_CODE.get(code as GeneralStatus)?.terminal ?? false;
}
/** Estados operativos válidos para un estado general dado (para los selectores). */
export function operationalStatusesFor(general: GeneralStatus): OperationalStatusDef[] {
  return OPERATIONAL_STATUSES.filter((s) => s.general === general);
}

// ---------------------------------------------------------------------------
// Entradas
// ---------------------------------------------------------------------------

/** Lo que el Master necesita del pedido de Shopify. */
export interface OrderSnapshot {
  created_at: string | null;
  cancelled_at: string | null;
  financial_status: string | null;
  shipping_mode: string | null; // cod | agency
}

/**
 * Una gestión logística: en la práctica, una guía de courier. Se proyecta desde
 * `shipments` — el Master NO duplica esa tabla, la lee (ver 0045).
 */
export interface GuideSnapshot {
  id: string;
  courier: string;
  guide_code: string | null;
  /** shipments.delivery_status: pendiente | en_ruta | entregado | anulado | transferido */
  delivery_status: string;
  /** Intentos reportados por el courier (aliclik_attempts) o reprogramaciones. */
  attempts: number;
  assigned_at: string | null;
  dispatched_at: string | null;
  out_for_delivery_at: string | null;
  rescheduled_at: string | null;
  closed_at: string | null;
  returned_at: string | null;
  /** Flujo de agencia (Shalom/Olva): ver OPERATIONAL_STATUSES. */
  pickup_state: string | null;
  agency_branch: string | null;
  agency_arrived_at: string | null;
  agency_expires_at: string | null;
  /** Cuándo la caja pasó al motorizado. Nulo = nunca salió de la empresa. */
  custody_transferred_at?: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Un evento de la línea de tiempo (order_events). */
export interface OrderEventSnapshot {
  kind: string;
  /** La salida que nombra el evento, cuando la nombra. Es lo que permite saber
   *  QUÉ salida se anuló por el botón de corregir. */
  shipment_id?: string | null;
  occurred_at: string;
  courier: string | null;
  new_status: string | null;
  new_operational: string | null;
}

/** Cambio manual auditado. Congela el estado frente al recálculo automático. */
export interface StatusOverride {
  general_status: GeneralStatus;
  operational_status: string | null;
  occurred_at: string;
}

export interface ResolveInputs {
  order: OrderSnapshot;
  guides: GuideSnapshot[];
  events: OrderEventSnapshot[];
  override: StatusOverride | null;
  /** Ahora, inyectable para tests. */
  now?: string;
}

export interface ResolvedOrderState {
  general: GeneralStatus;
  operational: string;
  /** Desde cuándo el pedido está en este estado general. */
  since: string | null;
  /** Quién decidió el estado: shopify | manual | <courier> | system. */
  source: string;
  /**
   * ¿El cambio manual es el que manda? Es lo que congela el estado y dibuja el
   * candado.
   *
   * No es lo mismo que «existe un override»: uno anterior a la anulación en
   * Shopify deja de aplicarse, y entonces el candado sería una etiqueta sobre un
   * estado que ya no decidió nadie a mano.
   */
  overrideApplied: boolean;
  // Rollup logístico que alimenta las columnas del listado (§14).
  currentCourier: string | null;
  lastCourier: string | null;
  courierCount: number;
  attemptCount: number;
  guideCode: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  deliveredCourier: string | null;
  returnedAt: string | null;
  lastMovementAt: string | null;
  // Seguimiento de agencia (§10): lo que permite actuar antes de que el paquete
  // se devuelva por no recogerlo a tiempo.
  pickupState: string | null;
  agencyBranch: string | null;
  agencyArrivedAt: string | null;
  agencyExpiresAt: string | null;
}

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

/** El mayor de varios ISO (null-safe). Comparar ISO-8601 como texto es correcto. */
function maxIso(...values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (v && (!best || v > best)) best = v;
  }
  return best;
}

function minIso(...values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (v && (!best || v < best)) best = v;
  }
  return best;
}

/** Último instante en que esta guía se movió, sea por reporte o por gestión. */
function guideMovedAt(g: GuideSnapshot): string | null {
  return maxIso(
    g.closed_at,
    g.returned_at,
    g.rescheduled_at,
    g.out_for_delivery_at,
    g.dispatched_at,
    g.assigned_at,
    g.updated_at,
    g.created_at,
  );
}

/** ¿Esta guía llegó a salir físicamente? Requisito para poder hablar de devolución. */
function wasDispatched(g: GuideSnapshot): boolean {
  return Boolean(g.dispatched_at || g.out_for_delivery_at || g.pickup_state);
}

const AGENCY_COURIERS = new Set(["shalom", "olva"]);

export function isAgencyCourier(courier: string | null | undefined): boolean {
  return AGENCY_COURIERS.has((courier ?? "").toLowerCase());
}

/**
 * La guía "vigente": la que el equipo está trabajando ahora. Se descartan las
 * congeladas (transferido/anulado) mientras haya alguna activa; si no queda
 * ninguna activa, gana la que se movió más recientemente.
 */
export function currentGuide(guides: GuideSnapshot[]): GuideSnapshot | null {
  if (!guides.length) return null;
  const active = guides.filter(
    (g) => g.delivery_status === "pendiente" || g.delivery_status === "en_ruta",
  );
  const pool = active.length ? active : guides;
  let best = pool[0]!;
  for (const g of pool) {
    const a = guideMovedAt(g);
    const b = guideMovedAt(best);
    if (a && (!b || a > b)) best = g;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Estado operativo
// ---------------------------------------------------------------------------

/**
 * Sub-estado de un pedido que todavía no arrancó su proceso logístico (§3.1).
 * La confirmación se pregunta a `hasConfirmationSignal`, la única definición:
 * antes se resolvía aquí mirando solo el evento `confirmed` y el pago de
 * Shopify, y eso decía «sin confirmar» sobre pedidos que el MOM ya daba por
 * confirmados. En contraentrega no hay pago previo, así que la mayoría de los
 * COD se quedan en "sin confirmar" hasta que alguien lo registre.
 */
function pendingOperational(
  order: OrderSnapshot,
  guides: GuideSnapshot[],
  events: OrderEventSnapshot[],
): string {
  const confirmed = hasConfirmationSignal({
    hasGuide: guides.length > 0,
    events,
    financialStatus: order.financial_status,
  });

  if (guides.length) {
    // Hay guía pero nunca se despachó: el pedido está preparado y detenido.
    return guides.some(wasDispatched) ? "preparado_sin_despachar" : "nunca_salio_a_reparto";
  }
  if (!confirmed) return "sin_confirmar";
  if (order.shipping_mode === "agency") return "pendiente_de_envio";
  return "sin_asignar_courier";
}

/** Sub-estado de una guía de agencia (Shalom/Olva) — §10. */
function agencyOperational(g: GuideSnapshot, now: string): string {
  if (g.pickup_state && isOperationalStatus(g.pickup_state)) {
    // "Próximo a vencer" gana sobre "disponible para recojo": es lo que el
    // equipo necesita ver para actuar antes de que se dispare la devolución.
    if (
      g.pickup_state === "disponible_para_recojo" &&
      g.agency_expires_at &&
      g.agency_expires_at <= now
    ) {
      return "proximo_a_vencer";
    }
    return g.pickup_state;
  }
  if (g.dispatched_at) return "en_transito";
  return "enviado_a_agencia";
}

/** Sub-estado de un pedido con gestión logística en curso (§3.2). */
function inProgressOperational(
  guides: GuideSnapshot[],
  current: GuideSnapshot,
  now: string,
): string {
  if (isAgencyCourier(current.courier)) return agencyOperational(current, now);

  switch (current.delivery_status) {
    case "en_ruta":
      return current.out_for_delivery_at ? "en_reparto" : "en_ruta";
    case "transferido":
      // La guía madre se congeló porque nació una hija: es un cambio de courier
      // salvo que la hija todavía no exista, en cuyo caso falta asignarla.
      return guides.length > 1 ? "en_traslado" : "pendiente_nuevo_courier";
    case "pendiente":
    default:
      if (current.rescheduled_at) return "reprogramado";
      if (current.attempts > 0) return "pendiente_de_reprogramacion";
      if (current.dispatched_at) return "despachado";
      return "asignado_a_courier";
  }
}

// ---------------------------------------------------------------------------
// Resolución
// ---------------------------------------------------------------------------

/**
 * Resuelve el estado vigente de un pedido y su rollup logístico.
 *
 * Reglas duras, que son las que la especificación llama por su nombre:
 *
 *  - **Entregado es pegajoso.** Basta con que UNA fuente válida reporte la
 *    entrega para cerrar el pedido, y ningún reporte posterior lo retrocede. La
 *    entrega se atribuye al courier que la reportó primero (si dos couriers la
 *    reportan, el primero es el que realmente entregó).
 *  - **Devuelto exige evidencia.** Sin despacho previo Y guía Y retorno, un
 *    reporte que dice "devuelto" NO cierra el pedido: lo deja en proceso con
 *    estado operativo "en proceso de retorno". Así no se contabiliza como
 *    devolución algo que nunca salió físicamente.
 *  - **Un override manual gana siempre**, y queda auditado en order_events.
 *
 * Pura: no lee la base de datos ni el reloj (salvo `now`, inyectable).
 */
export function resolveOrderState(inputs: ResolveInputs): ResolvedOrderState {
  const { order, guides, events, override } = inputs;
  const now = inputs.now ?? new Date().toISOString();

  // Las salidas anuladas como CORRECCIÓN DE REGISTRO no deciden el estado: el
  // MOM las define como corregir el courier equivocado, no como un hecho
  // logístico. Siguen en `guides` —el rollup y «Salidas y guías» tienen que
  // seguir enseñando la fila con su consecutivo— pero no cuentan ni para dar el
  // pedido por perdido ni para decir que hay gestión en curso.
  const corregidas = correctedShipmentIds(events);
  const real = guides.filter((g) => !cancelledAsRecordCorrection(g, corregidas));
  const currentReal = currentGuide(real);

  // ── Rollup logístico (independiente del estado: se calcula siempre)
  const couriers = [...new Set(guides.map((g) => g.courier).filter(Boolean))];
  const current = currentGuide(guides);
  const byRecency = [...guides].sort((a, b) => {
    const av = guideMovedAt(a) ?? "";
    const bv = guideMovedAt(b) ?? "";
    return av < bv ? 1 : av > bv ? -1 : 0;
  });
  const attemptCount = guides.reduce((sum, g) => sum + Math.max(0, g.attempts), 0);
  const dispatchedAt = minIso(...guides.map((g) => g.dispatched_at));
  const lastMovementAt = maxIso(
    ...guides.map(guideMovedAt),
    ...events.map((e) => e.occurred_at),
    order.cancelled_at,
    order.created_at,
  );

  // Entrega: la primera guía que la reportó es la que entregó de verdad.
  const deliveredGuides = guides
    .filter((g) => g.delivery_status === "entregado")
    .sort((a, b) => {
      const av = a.closed_at ?? guideMovedAt(a) ?? "";
      const bv = b.closed_at ?? guideMovedAt(b) ?? "";
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
  const deliveredEvent = events
    .filter((e) => e.kind === "delivered")
    .sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1))[0];
  const deliveredGuide = deliveredGuides[0];
  const deliveredAt =
    deliveredGuide?.closed_at ??
    (deliveredGuide ? guideMovedAt(deliveredGuide) : null) ??
    deliveredEvent?.occurred_at ??
    null;
  const deliveredCourier = deliveredGuide?.courier ?? deliveredEvent?.courier ?? null;

  // Devolución. Se distinguen dos cosas a propósito:
  //   * RECLAMADA — alguien dice que el paquete vuelve (un reporte, un evento).
  //   * PROBADA   — además hay despacho previo Y guía: el paquete salió de
  //                 verdad y por tanto puede volver de verdad (§3.5).
  // Solo la probada cierra el pedido como Devuelto; la reclamada se ve como
  // "en proceso de retorno" para que el equipo la trabaje sin contabilizarla
  // todavía como devolución (que además lleva costo asociado).
  const returnedGuide = guides.find((g) => g.returned_at && wasDispatched(g) && g.guide_code);
  const returnClaimed =
    guides.some((g) => g.returned_at || g.pickup_state === "retorno_iniciado") ||
    events.some((e) => e.kind === "returned" || e.kind === "return_started");
  const returnProven = Boolean(returnedGuide);
  const returnedAt = returnedGuide?.returned_at ?? null;

  // El dato de agencia sale de la guía vigente si es de agencia; si ya no lo es
  // (el pedido salió de la agencia y se reasignó), de la última que lo fue.
  const agencyGuide = isAgencyCourier(current?.courier)
    ? current
    : byRecency.find((g) => isAgencyCourier(g.courier)) ?? null;

  const rollup = {
    currentCourier: current?.courier ?? null,
    lastCourier: byRecency[0]?.courier ?? null,
    courierCount: couriers.length,
    attemptCount,
    guideCode: current?.guide_code ?? null,
    dispatchedAt,
    deliveredAt,
    deliveredCourier,
    returnedAt,
    lastMovementAt,
    pickupState: agencyGuide?.pickup_state ?? null,
    agencyBranch: agencyGuide?.agency_branch ?? null,
    agencyArrivedAt: agencyGuide?.agency_arrived_at ?? null,
    agencyExpiresAt: agencyGuide?.agency_expires_at ?? null,
    // Falso por defecto: solo la regla 0 lo pone en cierto, y solo cuando el
    // override es de verdad el que manda. Es lo que dibuja el candado.
    overrideApplied: false,
  };

  // ── 0. Override manual: un humano decidió, nada AUTOMÁTICO lo pisa.
  //
  // Con UNA excepción, y no es un automatismo: anular el pedido en Shopify
  // también lo hace una persona. Si lo hizo DESPUÉS del cambio manual, la suya
  // es la decisión vigente — el candado existe para que un courier o un cron no
  // pisen el criterio de alguien, no para que un criterio del martes gane a otro
  // del jueves.
  //
  // Pasó en #KP126722: el 12/08 se marcó «Pendiente · no responde», luego se
  // anuló en Shopify —productos eliminados, total 0— y el Master lo siguió
  // enseñando como Pendiente · Provincia COD. O sea dentro de la cola operativa,
  // llamable y despachable, por S/ 99 que ya no existían.
  //
  // La anulación NO gana un privilegio nuevo: deja de estar tapada. Al ceder, el
  // pedido baja por la cadena normal, así que «entregado es pegajoso» y «devuelto
  // exige evidencia» siguen por delante, igual que para cualquier otro pedido
  // anulado. Se resuelve como si el override no se hubiera escrito.
  const cancelledAfterOverride = Boolean(
    override && order.cancelled_at && order.cancelled_at > override.occurred_at,
  );
  if (override && !cancelledAfterOverride) {
    return {
      ...rollup,
      general: override.general_status,
      operational:
        override.operational_status && isOperationalStatus(override.operational_status)
          ? override.operational_status
          : defaultOperationalFor(override.general_status),
      since: override.occurred_at,
      source: "manual",
      overrideApplied: true,
    };
  }

  // ── 1. Entregado (prevalece sobre todo lo demás)
  if (deliveredGuide || deliveredEvent) {
    return {
      ...rollup,
      general: "entregado",
      operational:
        deliveredGuide && isAgencyCourier(deliveredGuide.courier) ? "recogido" : "entregado",
      since: deliveredAt,
      source: deliveredCourier ?? "system",
    };
  }

  // ── 2. Devuelto confirmado (exige despacho + guía + retorno)
  if (returnProven) {
    return {
      ...rollup,
      general: "devuelto",
      operational: "devuelto_al_origen",
      since: returnedAt,
      source: returnedGuide?.courier ?? "system",
    };
  }

  // ── 3. Anulado — principalmente desde Shopify (§3.4)
  if (order.cancelled_at) {
    return {
      ...rollup,
      general: "anulado",
      operational: "anulado",
      since: order.cancelled_at,
      source: "shopify",
    };
  }
  // Todas las guías cerradas como anuladas y ninguna activa: la operación ya lo
  // dio por perdido aunque todavía no se haya anulado en Shopify (caso Lima,
  // §9). Es reversible con un override.
  //
  // Las CORRECCIONES DE REGISTRO quedan fuera del reparto (`real`): una salida
  // anulada por el botón «Anular salida», sin haber salido de la empresa, no es
  // prueba de que nadie se rindiera — el MOM la define como corregir el courier
  // equivocado. Con una sola salida, contarla cerraba la venta al corregirla y
  // encima bloqueaba la guía nueva que motivaba la corrección (#KP127639).
  if (real.length && real.every((g) => g.delivery_status === "anulado")) {
    return {
      ...rollup,
      general: "anulado",
      operational: "anulado",
      since: maxIso(...real.map((g) => g.closed_at ?? guideMovedAt(g))),
      source: currentReal?.courier ?? "system",
    };
  }

  // ── 4. En proceso — hay gestión logística iniciada
  // `currentReal` y no `current`: con la salida corregida como única guía, la
  // versión anterior daba el pedido «en proceso» por una gestión que se acababa
  // de deshacer. Sin gestión viva, el pedido vuelve a Preparación (§4).
  if (currentReal) {
    // Un retorno reclamado sin evidencia NO cierra el pedido, pero sí se ve.
    const operational = returnClaimed
      ? "en_proceso_de_retorno"
      : inProgressOperational(real, currentReal, now);
    return {
      ...rollup,
      general: "en_proceso",
      operational,
      since: maxIso(currentReal.assigned_at, currentReal.created_at) ?? lastMovementAt,
      source: currentReal.courier,
    };
  }

  // ── 5. Pendiente
  return {
    ...rollup,
    general: "pendiente",
    operational: pendingOperational(order, guides, events),
    since: order.created_at,
    source: "shopify",
  };
}

/** Estado operativo por defecto de un estado general (para overrides sin detalle). */
export function defaultOperationalFor(general: GeneralStatus): string {
  switch (general) {
    case "entregado":
      return "entregado";
    case "anulado":
      return "anulado";
    case "devuelto":
      return "devuelto_al_origen";
    case "en_proceso":
      return "en_seguimiento";
    case "pendiente":
    default:
      return "sin_confirmar";
  }
}

/**
 * ¿El estado `next` puede reemplazar automáticamente a `prev`? Solo se avanza en
 * la jerarquía; nunca se retrocede sin intervención manual. Mismo espíritu que
 * reconcileDeliveryStatus() en lib/shipments.ts, un nivel más arriba.
 */
export function canAdvanceGeneral(prev: string | null | undefined, next: GeneralStatus): boolean {
  if (!prev || !isGeneralStatus(prev)) return true;
  return GENERAL_PRIORITY[next] >= GENERAL_PRIORITY[prev];
}

/** Antigüedad en días del estado actual (§14 "antigüedad en el estado actual"). */
export function daysInStatus(since: string | null, now: string = new Date().toISOString()): number | null {
  if (!since) return null;
  const ms = Date.parse(now) - Date.parse(since);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * Días que el paquete lleva disponible en la agencia (§10). Null cuando no
 * aplica o no consta la fecha de llegada.
 */
export function daysInAgency(
  arrivedAt: string | null,
  now: string = new Date().toISOString(),
): number | null {
  return daysInStatus(arrivedAt, now);
}

/** ¿Está por vencer el plazo de recojo? `withinDays` de margen. */
export function isExpiringSoon(
  expiresAt: string | null,
  now: string = new Date().toISOString(),
  withinDays = 3,
): boolean {
  if (!expiresAt) return false;
  const left = Date.parse(expiresAt) - Date.parse(now);
  if (!Number.isFinite(left)) return false;
  return left <= withinDays * 86_400_000;
}
