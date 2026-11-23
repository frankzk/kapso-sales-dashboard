import { gfBlockedByOtherCourierText, otherCourierLabel } from "@/lib/gf-other-courier";
import { ADELANTO_MINIMO_LABEL } from "@/lib/adelanto-minimo";
import type { OperationKind } from "@/lib/order-macro-stage";
import { sameDayCutoffLabel, sameDayCutoffMinute, type GroupGfCourierRouteCheck } from "@/lib/grupo-gf-courier";
import { shipmentIsReturning, terminalOrderBlocker } from "@/lib/order-status";
import {
  MAX_OUTPUTS_PER_ORDER,
  canRepeatCourier,
  isFillableRouteOutput,
  pickFillableRouteOutput,
  salidaActiva,
} from "@/lib/shipment-output";

export type RouteKey =
  | "aliclik"
  | "swayp"
  | "shalom"
  | "olva"
  | "tanders"
  | "axel"
  | "urpi"
  | "propio"
  | "gf_courier";

export type RouteAction = "aliclik" | "swayp" | "shalom" | "tanders" | "gf_courier" | "manual";
export type RouteAvailability = "available" | "warning" | "blocked";

export interface RouteOutputSnapshot {
  id: string;
  courier: string;
  deliveryStatus: string;
  custodyState?: string | null;
  attempts?: number | null;
  /** Nº con el que el courier conoce la salida. En Shalom, su «Nº de Orden». */
  guideCode?: string | null;
  /** Código corto que Shalom imprime junto al número, del estilo `MCMH`. */
  shortCode?: string | null;
  /** El rastreo confirmó que Shalom no conoce la guía (6 rechazos y 24 h). */
  shalomUnrecognized?: boolean;
  /** Estado del flujo de agencia, que es lo que el courier reporta. */
  pickupState?: string | null;
  /** Lo que el courier dice HOY: decide si el paquete vuelve (`shipmentIsReturning`). */
  swaypState?: number | null;
  reportedStatus?: string | null;
  /**
   * Los tres campos que faltaban para saber si la salida es RELLENABLE.
   *
   * Sin ellos la mesa avisaba «una salida adicional exige motivo» sobre una
   * salida «por definir» a la que crear la guía no le añade nada: se la escribe
   * encima. El aviso describía el comportamiento anterior al relleno y asustaba
   * justo en el caso que ya no tiene problema.
   */
  createdVia?: string | null;
  custodyTransferredAt?: string | null;
  /** `KP128892-S01`, para poder NOMBRAR la salida que se va a rellenar. */
  outputCode?: string | null;
  /** Decide cuál se rellena cuando hay varias por definir: la más reciente. */
  outputNumber?: number | null;
  /** El envío que cotizó el courier; la tarjeta de GF Courier lo dice junto a su guía. */
  quotedCost?: number | null;
  /** Para «salida activa» de otro courier (owner, 23-11-2026, `salidaActiva`). */
  returnedAt?: string | null;
  nextFollowupAt?: string | null;
  dispatchedAt?: string | null;
  lastCourierChangeAt?: string | null;
}

/**
 * La salida viva que impide volver a usar ese courier.
 *
 * Decir «no disponible» sin nombrarla obliga a bajar hasta «Salidas y guías»
 * para averiguar de cuál se habla, y en el panel del courier hay que buscar por
 * su número: por eso viaja con la identidad completa, no solo con un booleano.
 */
export interface RouteBlockingOutput {
  id: string;
  guideCode: string | null;
  shortCode: string | null;
  deliveryStatus: string;
  pickupState: string | null;
  /** Para decir «en devolución» y no «en ruta» cuando el paquete vuelve. */
  custodyState: string | null;
  courier: string;
  swaypState: number | null;
  reportedStatus: string | null;
  quotedCost?: number | null;
}

export interface SwaypRouteCheck {
  known: boolean;
  city?: string | null;
  covered?: boolean;
  stockOk?: boolean;
  uncovered?: string[];
  /**
   * Productos que Swayp no tiene en su catálogo (`swayp_sku_map`).
   *
   * Separado de `uncovered` porque son hechos distintos que se arreglan en
   * pantallas distintas, y porque en Lima es el único que dice algo: la ciudad
   * no lleva control de cantidad, así que `stockOk` sale siempre en cierto.
   */
  unlinked?: string[];
}

export interface RouteCandidate {
  key: RouteKey;
  label: string;
  action: RouteAction;
  recommended: boolean;
  availability: RouteAvailability;
  timing: string;
  reason: string;
  requiresAdvance: boolean;
  relatedShipmentId?: string | null;
  /**
   * La salida viva que bloquea crear otra con este courier, presente SOLO en ese
   * caso. Sustituye al `activeGuideCode` que traía únicamente el código: hacían
   * falta también el código corto de Shalom y el estado que el courier reporta,
   * y dos campos para el mismo hecho terminan discrepando.
   */
  blockingOutput?: RouteBlockingOutput | null;
  /** Solo el reemplazo de guías Shalom confirmadas como no reconocidas. */
  canRegisterShalomReplacement?: boolean;
  /**
   * Casi no se usa (09-10-2026): la mesa la pliega en «Otros couriers» y nunca
   * la sugiere. En Lima, en 60 días: Grupo GF 1.864 salidas, Tanders 881,
   * Swayp 138, Axel 1 y Urpi 0. Sigue disponible: la decisión es de
   * Seguimiento Lima (MOM §9.2).
   */
  rarelyUsed?: boolean;
}

export interface OrderRoutePlan {
  operation: OperationKind;
  operationLabel: string;
  outputCount: number;
  activeOutputCount: number;
  maxOutputs: number;
  warnings: string[];
  candidates: RouteCandidate[];
}

/**
 * GF Courier por API en la tienda del pedido (MOM §29.17).
 *
 * `enabled` es el interruptor de la tienda: con él encendido, GF Courier
 * REEMPLAZA al reparto propio de Grupo GF —«Tomar» lo rechaza—, así que la mesa
 * deja de ofrecer Grupo GF y sugiere GF Courier. `blockedReason` dice por qué
 * todavía no se puede crear la guía aunque esté encendido (servidor apagado,
 * sin token).
 */
export interface GfCourierRouteCheck {
  enabled: boolean;
  blockedReason?: string | null;
}

export interface OrderRoutePlanInput {
  operation: OperationKind;
  outputs: readonly RouteOutputSnapshot[];
  paymentState?: string | null;
  swayp?: SwaypRouteCheck | null;
  grupoGfCourier?: GroupGfCourierRouteCheck | null;
  gfCourier?: GfCourierRouteCheck | null;
  now?: Date;
}

export interface RouteDeskBlocker {
  text: string;
  /**
   * Adónde lleva el atajo. Nombrar el panel no bastó: los dos viven al fondo de
   * la pestaña Operar, detrás de «Salidas y guías», y quien lee el aviso está
   * arriba del todo. #AUR176830 se quedó dos rondas sin encontrarlo aun con la
   * instrucción delante, que es la señal de que faltaba el atajo y no la frase.
   */
  target: "cierre" | "acciones" | "guias";
  cta: string;
}

export interface RouteDeskGate {
  /** Lo que hay que contar arriba, con el sitio donde se arregla. */
  blockers: RouteDeskBlocker[];
  /** Las modalidades que además NO van a poder ejecutarse. */
  blockedActions: RouteAction[];
}

/**
 * Qué impide crear una salida, y a CUÁLES de las modalidades.
 *
 * Existe porque la mesa y los modales medían «cerrado» con reglas distintas. La
 * mesa solo se apagaba con la macroetapa en `finalizado`; los modales de Tanders
 * y Shalom rechazan además cualquier estado general terminal. Con el expediente
 * reabierto y el pedido todavía `anulado` —#AUR176830— la mesa pintaba «Crear en
 * Tanders» en negro, recomendado, y la negativa aparecía recién dentro del
 * modal, después de cargar el borrador entero.
 *
 * NO ES UN INTERRUPTOR ÚNICO, y esa fue la primera versión equivocada de este
 * arreglo. Cada modalidad tiene su propio guarda en el servidor y no dicen lo
 * mismo:
 *
 *   - Tanders y Shalom rechazan cualquier estado terminal, sin excepción.
 *   - La salida manual lo rechaza SALVO cuando el pedido se cerró porque la
 *     entrega falló: el MOM §11 nombra «guía cancelada por courier y devolución»
 *     como entrada elegible a Reproprovincia, y son 844 guías sobre 842 pedidos.
 *     Apagarle el botón a ese caso sería romper el flujo que lo justifica.
 *   - Aliclik y Swayp no miran el estado general del pedido.
 *
 * Apagarlas todas por igual mentiría en tres de las cinco. Apagar solo la
 * macroetapa mentía en dos. Así que se pregunta por modalidad, y el aviso de
 * arriba cuenta el hecho aunque algún botón siga encendido.
 */
export function routeDeskGate(order: {
  macroStage?: string | null;
  generalStatus?: string | null;
  /**
   * ¿Se cerró porque la entrega falló? Lo dice la etiqueta que el courier puso
   * en la guía, no el estado del pedido: `anulado` cubre tanto «lo canceló el
   * courier» como «lo cancelamos nosotros». Misma pregunta que hace
   * `createManualRouteOutput` antes de dejar crear la salida.
   */
  closedByFailedDelivery?: boolean;
  /**
   * El pedido viaja en la caja de otro (pedido acompañante, MOM §32). Sus
   * productos ya tienen caja y guía: una salida propia sería un segundo paquete
   * para la misma clienta. Para dársela, primero se desvincula.
   */
  companionOf?: { hostOrderName: string | null; guideCode: string | null } | null;
}): RouteDeskGate {
  const blockers: RouteDeskBlocker[] = [];
  const blockedActions = new Set<RouteAction>();

  if (order.companionOf) {
    const host = order.companionOf.hostOrderName ?? "otro pedido";
    const guide = order.companionOf.guideCode ? ` (guía ${order.companionOf.guideCode})` : "";
    blockers.push({
      text:
        `Viaja en la caja de ${host}${guide}: no necesita salida propia. ` +
        "Si va a salir por separado, desvincúlalo primero en «Salidas y guías».",
      target: "guias",
      cta: "Ir a Salidas y guías ↓",
    });
    for (const action of ALL_ROUTE_ACTIONS) blockedActions.add(action);
  }

  if (order.macroStage === "finalizado") {
    blockers.push({
      text: "El expediente está finalizado. Reábrelo en la Mesa de cierre antes de crear una salida.",
      target: "cierre",
      cta: "Ir a la Mesa de cierre ↓",
    });
    // El cierre exige que no queden salidas activas: mientras esté finalizado no
    // entra ninguna, venga por donde venga.
    for (const action of ALL_ROUTE_ACTIONS) blockedActions.add(action);
  }

  const terminal = terminalOrderBlocker(order.generalStatus ?? "");
  if (terminal) {
    blockers.push({ text: terminal, target: "acciones", cta: "Ir a Gestión manual ↓" });
    blockedActions.add("tanders");
    blockedActions.add("shalom");
    if (!order.closedByFailedDelivery) blockedActions.add("manual");
  }

  return { blockers, blockedActions: [...blockedActions] };
}

const ALL_ROUTE_ACTIONS: readonly RouteAction[] = [
  "aliclik",
  "swayp",
  "shalom",
  "tanders",
  "gf_courier",
  "manual",
];

const LABELS: Record<RouteKey, string> = {
  aliclik: "Aliclik",
  swayp: "Swayp (antes Fénix)",
  shalom: "Shalom",
  olva: "Olva",
  tanders: "Tanders",
  axel: "Axel Courier",
  urpi: "Urpi",
  // `propio` se conserva como token interno hasta migrar las rutas históricas.
  // En producto ya es un operador, no una excepción de cada tienda.
  propio: "Grupo GF Courier",
  gf_courier: "GF Courier",
};

const ACTIONS: Record<RouteKey, RouteAction> = {
  aliclik: "aliclik",
  swayp: "swayp",
  shalom: "shalom",
  olva: "manual",
  tanders: "tanders",
  axel: "manual",
  urpi: "manual",
  propio: "manual",
  gf_courier: "gf_courier",
};

const OPERATION_LABEL: Record<OperationKind, string> = {
  lima: "Lima COD",
  provincia_cod: "Provincia COD",
  agencia: "Agencia",
  desconocida: "Ruta por definir",
};

function courierKey(value: string): RouteKey | null {
  const courier = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
  if (courier === "fenix" || courier === "swayp") return "swayp";
  if (courier === "axel" || courier === "axel courier") return "axel";
  if (courier === "motorizado propio" || courier === "propio") return "propio";
  if (courier === "aliclik") return "aliclik";
  if (courier === "shalom") return "shalom";
  if (courier === "olva") return "olva";
  if (courier === "tanders") return "tanders";
  if (courier === "urpi") return "urpi";
  if (courier === "gf_courier" || courier === "gf courier") return "gf_courier";
  return null;
}

function isActive(output: RouteOutputSnapshot): boolean {
  if (output.custodyState === "devuelto") return false;
  return ["pendiente", "en_ruta", "por_preparar"].includes(output.deliveryStatus);
}

/**
 * ¿Activa para OTRO courier? (owner, 23-11-2026). La definición única de `salidaActiva`: en preparación, en ruta o
 * reprogramada; no si su courier ya reportó que no la entregó ni si sigue en ruta sin reporte pasado el día de su
 * ruta. `isActive` sigue decidiendo si se repite el MISMO courier.
 */
function isActiveForOther(output: RouteOutputSnapshot): boolean {
  return salidaActiva({
    courier: output.courier, delivery_status: output.deliveryStatus, guide_code: output.guideCode ?? null,
    custody_state: output.custodyState ?? null, reported_status: output.reportedStatus ?? null, swayp_state: output.swaypState ?? null,
    created_via: output.createdVia ?? null, custody_transferred_at: output.custodyTransferredAt ?? null,
    returned_at: output.returnedAt ?? null, next_followup_at: output.nextFollowupAt ?? null,
    dispatched_at: output.dispatchedAt ?? null, last_courier_change_at: output.lastCourierChangeAt ?? null,
  });
}

/**
 * ¿Esta salida se rellenará al crear la guía?
 *
 * Traduce el snapshot en camelCase a la fila que esperan los predicados, y
 * DELEGA. Reescribir aquí las condiciones sería tener dos definiciones de
 * «rellenable»: el día que una cambie, la mesa avisaría de una cosa y el
 * servidor haría otra — y quien arma la caja se fía del aviso.
 */
function asOutputRow(output: RouteOutputSnapshot) {
  return {
    courier: output.courier,
    created_via: output.createdVia ?? null,
    delivery_status: output.deliveryStatus,
    custody_state: output.custodyState ?? null,
    custody_transferred_at: output.custodyTransferredAt ?? null,
    output_number: output.outputNumber ?? null,
    snapshot: output,
  };
}

function isFillableSnapshot(output: RouteOutputSnapshot): boolean {
  return isFillableRouteOutput(asOutputRow(output));
}

function pickFillableSnapshot(outputs: RouteOutputSnapshot[]): RouteOutputSnapshot | null {
  return pickFillableRouteOutput(outputs.map(asOutputRow))?.snapshot ?? null;
}

function limaMinute(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const number = (type: "hour" | "minute") =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return number("hour") * 60 + number("minute");
}

function groupGfCandidate(input: OrderRoutePlanInput, minute: number): RouteCandidate {
  const check = input.grupoGfCourier;
  const cutoff = sameDayCutoffLabel(check?.sameDayCutoff);
  const timing = minute <= sameDayCutoffMinute(cutoff)
    ? `Puede salir hoy · corte ${cutoff}`
    : `Programar para el día siguiente · corte ${cutoff}`;
  if (!check) {
    return candidate(
      "propio",
      timing,
      "No se pudo validar la configuración de Grupo GF Courier.",
      { availability: "blocked" },
    );
  }
  if (!check.eligible) {
    return candidate("propio", timing, check.reason, { availability: "blocked" });
  }
  return candidate("propio", timing, check.reason);
}

/**
 * GF Courier por API (MOM §29.17). Con una guía GF viva no se pre-bloquea: la
 * política de salidas la bloquea NOMBRANDO esa guía, que es lo que la tarjeta
 * necesita para ofrecer «Anular guía».
 */
function gfCourierCandidate(input: OrderRoutePlanInput): RouteCandidate {
  // Con una salida activa de otro courier no se crea la de GF (owner, 23-11-2026, #KP207468): misma regla que el
  // servidor (`otherCourierBlocksGf`). No se nombra como `blockingOutput`: su «Anular guía» es solo para la de GF.
  const other = hasActiveWith(input, "gf_courier") ? null : input.outputs.find(
    (output) => otherCourierLabel(output.courier) !== null && isActiveForOther(output),
  );
  const blockedReason = hasActiveWith(input, "gf_courier") ? null
    : other ? gfBlockedByOtherCourierText(otherCourierLabel(other.courier)!, other.guideCode ?? null)
    : input.gfCourier?.blockedReason ?? null;
  return candidate(
    "gf_courier",
    "Según la programación de GF",
    blockedReason ?? "Guía por API: GF prepara, asigna motorizado, entrega y liquida.",
    blockedReason ? { availability: "blocked" } : {},
  );
}

function hasActiveWith(input: OrderRoutePlanInput, key: RouteKey): boolean {
  return input.outputs.some((output) => courierKey(output.courier) === key && isActive(output));
}

/**
 * La tarjeta de Aliclik con una guía GF viva (owner, 15-11-2026). Mientras GF
 * no la asignó a un motorizado, crear la de Aliclik la anula sola. Asignada ya
 * no: no se crea la de Aliclik. Misma regla que `aliclikOutputPolicy`, que es la
 * que manda en el servidor.
 */
function withGfHandover(route: RouteCandidate, input: OrderRoutePlanInput): RouteCandidate {
  if (route.key !== "aliclik" || route.availability === "blocked") return route;
  const liveGf = input.outputs.filter(
    (output) => courierKey(output.courier) === "gf_courier" && isActiveForOther(output) && output.deliveryStatus !== "entregado",
  );
  if (liveGf.length === 0) return route;
  const code = liveGf.map((output) => output.guideCode).filter(Boolean).join(", ");
  if (liveGf.some((output) => output.deliveryStatus !== "pendiente")) {
    return {
      ...route,
      recommended: false,
      availability: "blocked",
      reason: `GF Courier ya asignó el pedido a un motorizado${code ? ` (guía ${code})` : ""}: no se crea la guía de Aliclik.`,
    };
  }
  return {
    ...route,
    reason: `Al crearla, Kapta anula la guía de GF Courier${code ? ` ${code}` : ""}: GF todavía no la asignó a un motorizado.`,
  };
}

function paymentAllowsAgency(paymentState: string | null | undefined): boolean {
  return ["adelanto_validado", "diferencia_cargada", "pago_completo"].includes(
    paymentState ?? "",
  );
}

function candidate(
  key: RouteKey,
  timing: string,
  reason: string,
  overrides: Partial<RouteCandidate> = {},
): RouteCandidate {
  return {
    key,
    label: LABELS[key],
    action: ACTIONS[key],
    recommended: false,
    availability: "available",
    timing,
    reason,
    requiresAdvance: key === "shalom" || key === "olva",
    ...overrides,
  };
}

function withAgencyPaymentGate(
  route: RouteCandidate,
  paymentState: string | null | undefined,
): RouteCandidate {
  if (paymentAllowsAgency(paymentState)) return route;
  return {
    ...route,
    availability: "warning",
    reason: `Primero valida un adelanto acumulado mínimo de ${ADELANTO_MINIMO_LABEL}.`,
  };
}

function applyOutputPolicy(
  route: RouteCandidate,
  input: OrderRoutePlanInput,
  operation: OperationKind,
): RouteCandidate {
  if (route.availability === "blocked") return route;

  // Con una salida VIVA de ese mismo courier, la mesa no debe seguir ofreciéndolo
  // como siguiente paso —menos aún marcarlo "Sugerido"—. La regla ya existía en
  // el sistema, pero solo al final del todo: el modal de Shalom contesta "el
  // pedido ya tiene una guía activa: …, anúlala antes de crear otra". Enseñar el
  // botón hasta ese momento manda a la operadora a un callejón, y en un pedido ya
  // entregado en agencia lo pinta encima como la acción recomendada.
  //
  // Se mira ACTIVA, no "ya se usó": una guía anulada o entregada no puede
  // condenar al pedido a no tener nunca otra salida con ese courier. Esa
  // distinción es justo la que `isActive` ya sabe hacer.
  const activeWithCourier = input.outputs.filter(
    (output) => courierKey(output.courier) === route.key && isActive(output),
  );
  if (activeWithCourier.length > 0) {
    // Si hubiera varias, la reciente es la relevante. Se prefiere la última que
    // TENGA número: una salida sin código no sirve para ir a buscarla al panel
    // del courier, que es para lo que se enseña.
    const reversed = [...activeWithCourier].reverse();
    const blocking = reversed.find((output) => output.guideCode) ?? reversed[0]!;
    // Registrar otra guía solo tiene sentido si TODAS las salidas que la
    // bloquearían son guías Shalom no reconocidas. El servidor lo revalida.
    const canRegisterShalomReplacement =
      route.key === "shalom" && !isFillableSnapshot(blocking) && blocking.shalomUnrecognized === true &&
      input.outputs
        .filter((output) => isActive(output) && !isFillableSnapshot(output))
        .every((output) => courierKey(output.courier) === "shalom" && output.shalomUnrecognized === true);
    // Una guía que el courier ya está devolviendo no se «anula»: no entregó y
    // el paquete viene de regreso. Decirle a la operadora que la anule la manda
    // a cancelar en el panel del courier una devolución en curso.
    const vuelve = shipmentIsReturning(blocking);
    return {
      ...route,
      recommended: false,
      availability: "blocked",
      reason: vuelve
        ? route.key === "swayp" && operation !== "lima"
          // En provincia Swayp se repite (08-10-2026): la guía en devolución
          // queda como madre del reenvío, que se hace desde su ficha en Envíos.
          ? `${route.label} no entregó: su guía está en devolución y el paquete vuelve a su bodega. Para reenviarlo con ${route.label}, usa «Reenviar por Swayp» en la ficha de esa guía en Envíos: queda como madre y sale una guía nueva.`
          : `${route.label} no entregó: su guía está en devolución y el paquete vuelve al origen. Mientras esa guía siga abierta no se crea otra con ${route.label}.`
        // La salida propia que no se entregó se reprograma con ELLA MISMA desde
        // Despacho del día (06-10-2026, MOM §29.13): anularla gastaba el
        // consecutivo y obligaba a armar otra caja para el mismo paquete.
        : route.key === "propio"
        ? `${route.label} ya tiene una salida activa en este pedido${blocking.outputCode ? ` (${blocking.outputCode})` : ""}. Si no se entregó, se reprograma con esa misma salida desde Despacho del día («Desde la lista»).`
        : route.key === "gf_courier"
        ? "GF Courier ya tiene la guía de este pedido. GF solo la anula antes de prepararla; después sigue su estado en «Salidas y guías»."
        : route.key === "shalom"
        ? canRegisterShalomReplacement
          ? "Shalom no reconoce la guía activa. Si la caja salió con otra guía, usa «Ya la creé en Shalom Pro» para registrar la que la reemplaza."
          : "Shalom ya tiene una salida activa en este pedido. Continúa su seguimiento en «Salidas y guías»."
        : `${route.label} ya tiene una salida activa en este pedido. Anúlala o ciérrala antes de crear otra.`,
      blockingOutput: {
        id: blocking.id,
        guideCode: blocking.guideCode ?? null,
        shortCode: blocking.shortCode ?? null,
        deliveryStatus: blocking.deliveryStatus,
        pickupState: blocking.pickupState ?? null,
        custodyState: blocking.custodyState ?? null,
        courier: blocking.courier,
        swaypState: blocking.swaypState ?? null,
        reportedStatus: blocking.reportedStatus ?? null,
        ...(blocking.quotedCost != null ? { quotedCost: blocking.quotedCost } : {}),
      },
      canRegisterShalomReplacement,
    };
  }

  const prior = input.outputs.filter((output) => courierKey(output.courier) === route.key).length;
  const policy = canRepeatCourier({
    courier: route.key === "swayp" ? "swayp" : LABELS[route.key],
    operation,
    priorOutputsWithCourier: prior,
    totalOutputs: input.outputs.length,
  });
  if (policy.allowed) return route;
  return {
    ...route,
    recommended: false,
    availability: "blocked",
    reason:
      policy.reason === "max_outputs"
        ? `El pedido ya alcanzó el máximo de ${MAX_OUTPUTS_PER_ORDER} salidas.`
        : `${route.label} ya fue usado en este pedido y no admite otra salida en esta modalidad.`,
  };
}

function swaypCandidate(input: OrderRoutePlanInput, recommended: boolean): RouteCandidate {
  const check = input.swayp;
  const related = [...input.outputs]
    .reverse()
    .find((output) => courierKey(output.courier) === "swayp") ??
    [...input.outputs].reverse().find((output) => courierKey(output.courier) === "aliclik");
  const base = candidate(
    "swayp",
    "Programación de lunes a sábado",
    "Ruta con stock local; requiere validar ciudad, producto y autorización.",
    { recommended, relatedShipmentId: related?.id ?? null },
  );
  if (!check?.known) {
    return {
      ...base,
      recommended: false,
      availability: "warning",
      reason: "La disponibilidad se validará con el stock Swayp antes de crear la salida.",
    };
  }
  if (!check.covered) {
    return {
      ...base,
      recommended: false,
      availability: "blocked",
      reason: "Swayp no tiene cobertura local en este destino.",
    };
  }
  // El vínculo ANTES que el stock: en Lima el stock nunca dice que no —la ciudad
  // no lleva control de cantidad— y la tarjeta prometía «hay cobertura y stock»
  // sobre un producto que Swayp no conoce (#KP134541).
  const sinVinculo = check.unlinked?.filter(Boolean) ?? [];
  if (sinVinculo.length) {
    return {
      ...base,
      recommended: false,
      availability: "blocked",
      reason:
        `Swayp no tiene en su catálogo: ${sinVinculo.join(", ")}. ` +
        `${sinVinculo.length === 1 ? "Vincúlalo" : "Vincúlalos"} en Catálogo de productos.`,
    };
  }
  if (!check.stockOk) {
    const products = check.uncovered?.filter(Boolean).join(", ");
    return {
      ...base,
      recommended: false,
      availability: "blocked",
      reason: products
        ? `No hay stock Swayp para: ${products}.`
        : "No hay stock Swayp suficiente para completar este pedido.",
    };
  }
  return {
    ...base,
    availability: recommended ? "available" : "warning",
    reason: recommended
      ? `Hay cobertura y stock en ${check.city || "la ciudad de destino"}.`
      : `Hay cobertura y stock en ${check.city || "la ciudad de destino"}; requiere autorización manual como primera salida.`,
  };
}

/**
 * Decisión operativa de Fase 3. No crea guías: ordena y explica las opciones
 * que luego ejecutan los paneles especializados o la salida manual con QR.
 */
export function buildOrderRoutePlan(input: OrderRoutePlanInput): OrderRoutePlan {
  const operation = input.operation;
  const active = input.outputs.filter(isActive);
  // Una salida «por definir» no cuenta como salida que estorba: crear la guía
  // del courier la RELLENA en vez de abrir otra (lib/route-output-fill.ts), así
  // que ni exige motivo ni gasta una del presupuesto de cinco. Separarlas es lo
  // que evita advertir de un problema que ya no existe.
  const fillable = active.filter(isFillableSnapshot);
  const blocking = active.filter((o) => !isFillableSnapshot(o));
  const warnings: string[] = [];
  if (blocking.length > 0) {
    warnings.push(
      `${blocking.length} salida${blocking.length === 1 ? "" : "s"} sigue${blocking.length === 1 ? "" : "n"} activa${blocking.length === 1 ? "" : "s"}. Una salida adicional exige motivo y seguimiento independiente.`,
    );
  }
  if (fillable.length > 0) {
    // Se nombra la que de verdad se va a rellenar —la de consecutivo más alto,
    // misma regla que `pickFillableRouteOutput`— porque decir «hay una salida
    // por definir» con tres en pantalla no dice a cuál le va a caer la guía.
    const target = pickFillableSnapshot(fillable);
    const name = target?.outputCode ? `La salida ${target.outputCode}` : "La salida";
    warnings.push(
      fillable.length === 1
        ? `${name} está por definir: al crear la guía se le escribe el courier encima, sin abrir otra.`
        : `Hay ${fillable.length} salidas por definir. Al crear la guía se escribe sobre ${target?.outputCode ?? "la más reciente"}, sin abrir otra.`,
    );
  }
  if (input.outputs.length >= MAX_OUTPUTS_PER_ORDER) {
    warnings.push(
      input.gfCourier?.enabled
        ? `Se alcanzó el límite de ${MAX_OUTPUTS_PER_ORDER} salidas por pedido; solo GF Courier admite otra.`
        : `Se alcanzó el límite máximo de ${MAX_OUTPUTS_PER_ORDER} salidas por pedido.`,
    );
  }

  const hasFailedAliclik = input.outputs.some(
    (output) =>
      courierKey(output.courier) === "aliclik" &&
      (["anulado", "transferido"].includes(output.deliveryStatus) || (output.attempts ?? 0) > 0),
  );
  let routes: RouteCandidate[];

  if (operation === "lima") {
    const minute = limaMinute(input.now ?? new Date());
    const groupGf = groupGfCandidate(input, minute);
    const groupCutoff = sameDayCutoffMinute(input.grupoGfCourier?.sameDayCutoff);
    // Axel ya no se sugiere (09-10-2026): casi no se usa, y sugerirlo antes
    // del mediodía lo ponía con el anillo azul por delante de Tanders.
    // Tanders deja de crear guías y Aliclik entra a Lima, solo con AUTOECOM
    // (26-10-2026, decisión del owner, MOM §9 «Aliclik en Lima»): ocupa el
    // lugar de Tanders detrás de Grupo GF.
    const aliclik = (recommended: boolean) =>
      candidate(
        "aliclik",
        "Según la cotización de Aliclik",
        "Aliclik con AUTOECOM: guía y rótulo de Aliclik.",
        { recommended },
      );
    let lead: RouteCandidate[];
    if (input.gfCourier?.enabled) {
      // GF Courier por API reemplaza al reparto propio en esta tienda (MOM
      // §29.17, owner 15-11-2026: «debería estar ahí, junto a todas las opciones
      // logísticas»). Va primero y sugerido; Grupo GF ya no toma sus pedidos, así
      // que solo aparece si el pedido conserva una salida suya viva, para
      // nombrarla.
      const gf = gfCourierCandidate(input);
      lead = [
        { ...gf, recommended: gf.availability !== "blocked" },
        aliclik(gf.availability === "blocked"),
        swaypCandidate(input, false),
        ...(hasActiveWith(input, "propio") ? [candidate("propio", groupGf.timing, groupGf.reason)] : []),
      ];
    } else {
      const first = input.grupoGfCourier?.eligible && minute <= groupCutoff ? "propio" : "aliclik";
      lead = [
        { ...groupGf, recommended: first === "propio" && groupGf.availability !== "blocked" },
        aliclik(first === "aliclik"),
        swaypCandidate(input, false),
        // Una guía GF viva de cuando la tienda tenía la API encendida: su
        // tarjeta la nombra y deja anularla.
        ...(hasActiveWith(input, "gf_courier") ? [gfCourierCandidate(input)] : []),
      ];
    }
    routes = [
      ...lead,
      // Plegados en «Otros couriers»: siguen disponibles, no se sugieren.
      candidate(
        "axel",
        minute <= 12 * 60 ? "Puede entrar al corte de hoy" : "Programar para el día siguiente",
        "Axel Courier puede repetirse cuando sea necesario.",
        { rarelyUsed: true },
      ),
      candidate("urpi", "Según recojo coordinado", "Salida manual con rótulo interno de Kapta.", { rarelyUsed: true }),
    ];
  } else if (operation === "agencia") {
    routes = [
      withAgencyPaymentGate(
        candidate("shalom", "Despacho a agencia", "Primera sugerencia para recojo en agencia.", {
          recommended: true,
        }),
        input.paymentState,
      ),
      withAgencyPaymentGate(
        candidate("olva", "Despacho a agencia", "Alternativa elegida por el cliente."),
        input.paymentState,
      ),
    ];
  } else {
    const swayp = swaypCandidate(input, hasFailedAliclik);
    routes = [
      candidate(
        "aliclik",
        "Ruta interprovincial",
        hasFailedAliclik
          ? "Ya existe una salida Aliclik fallida; prioriza Reproprovincia si hay stock."
          : "Primera ruta sugerida para Provincia COD.",
        { recommended: !hasFailedAliclik },
      ),
      swayp,
      withAgencyPaymentGate(
        candidate("shalom", "Recojo en agencia", "Tercera ruta: requiere adelanto validado."),
        input.paymentState,
      ),
      withAgencyPaymentGate(
        candidate("olva", "Recojo en agencia", "Alternativa de agencia elegida por el cliente."),
        input.paymentState,
      ),
    ];
  }

  if (operation !== "lima" && hasActiveWith(input, "gf_courier")) {
    // GF Courier atiende Lima, pero una guía suya viva se nombra donde sea.
    routes = [...routes, gfCourierCandidate(input)];
  }

  routes = routes.map((route) => withGfHandover(route, input));
  routes = routes.map((route) => applyOutputPolicy(route, input, operation));
  if (!routes.some((route) => route.recommended && route.availability !== "blocked")) {
    // Nunca se sugiere un courier que casi no se usa: si solo queda ese, no
    // hay sugerencia y la mesa lo deja a criterio de Seguimiento Lima.
    const firstAvailable = routes.find((route) => route.availability !== "blocked" && !route.rarelyUsed);
    if (firstAvailable) {
      routes = routes.map((route) => ({ ...route, recommended: route.key === firstAvailable.key }));
    }
  }

  return {
    operation,
    operationLabel: OPERATION_LABEL[operation],
    outputCount: input.outputs.length,
    activeOutputCount: active.length,
    maxOutputs: MAX_OUTPUTS_PER_ORDER,
    warnings,
    candidates: routes,
  };
}

/**
 * ¿Se ofrece CREAR la guía de Aliclik a este pedido? Lo decide el plan de
 * rutas, no una regla aparte: una segunda regla equivalente es una regla que
 * tarde o temprano deja de coincidir con la primera. `blocked` también cuenta:
 * si la ruta está frenada (por ejemplo, tope de salidas), crear la guía por el
 * panel sería saltarse el mismo límite por la puerta de atrás. Y no a un pedido
 * acompañante (MOM §32): ya viaja en la guía de otro.
 *
 * La usan la ficha del pedido y el paso de después de «Generar pedido» en Leads
 * (MOM §25.2), para que los dos ofrezcan Aliclik en los mismos pedidos.
 */
export function aliclikGuideOffered(input: {
  travelsInCompanion: boolean;
  candidates: readonly Pick<RouteCandidate, "action" | "availability">[];
}): boolean {
  return (
    !input.travelsInCompanion &&
    input.candidates.some((candidate) => candidate.action === "aliclik" && candidate.availability !== "blocked")
  );
}
