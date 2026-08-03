import type { OperationKind } from "@/lib/order-macro-stage";
import { MAX_OUTPUTS_PER_ORDER, canRepeatCourier } from "@/lib/shipment-output";

export type RouteKey =
  | "aliclik"
  | "swayp"
  | "shalom"
  | "olva"
  | "tanders"
  | "axel"
  | "urpi"
  | "propio";

export type RouteAction = "aliclik" | "swayp" | "shalom" | "tanders" | "manual";
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
  /** Estado del flujo de agencia, que es lo que el courier reporta. */
  pickupState?: string | null;
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
}

export interface SwaypRouteCheck {
  known: boolean;
  city?: string | null;
  covered?: boolean;
  stockOk?: boolean;
  uncovered?: string[];
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

export interface OrderRoutePlanInput {
  operation: OperationKind;
  outputs: readonly RouteOutputSnapshot[];
  paymentState?: string | null;
  swayp?: SwaypRouteCheck | null;
  now?: Date;
}

const LABELS: Record<RouteKey, string> = {
  aliclik: "Aliclik",
  swayp: "Swayp (antes Fénix)",
  shalom: "Shalom",
  olva: "Olva",
  tanders: "Tanders",
  axel: "Axel Courier",
  urpi: "Urpi",
  propio: "Motorizado propio",
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
  return null;
}

function isActive(output: RouteOutputSnapshot): boolean {
  if (output.custodyState === "devuelto") return false;
  return ["pendiente", "en_ruta", "por_preparar"].includes(output.deliveryStatus);
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
    reason: "Primero valida un adelanto acumulado mínimo de S/ 30.",
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
    return {
      ...route,
      recommended: false,
      availability: "blocked",
      reason: `${route.label} ya tiene una salida activa en este pedido. Anúlala o ciérrala antes de crear otra.`,
      blockingOutput: {
        id: blocking.id,
        guideCode: blocking.guideCode ?? null,
        shortCode: blocking.shortCode ?? null,
        deliveryStatus: blocking.deliveryStatus,
        pickupState: blocking.pickupState ?? null,
      },
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
  const warnings: string[] = [];
  if (active.length > 0) {
    warnings.push(
      `${active.length} salida${active.length === 1 ? "" : "s"} sigue${active.length === 1 ? "" : "n"} activa${active.length === 1 ? "" : "s"}. Una salida adicional exige motivo y seguimiento independiente.`,
    );
  }
  if (input.outputs.length >= MAX_OUTPUTS_PER_ORDER) {
    warnings.push(`Se alcanzó el límite máximo de ${MAX_OUTPUTS_PER_ORDER} salidas por pedido.`);
  }

  const hasFailedAliclik = input.outputs.some(
    (output) =>
      courierKey(output.courier) === "aliclik" &&
      (["anulado", "transferido"].includes(output.deliveryStatus) || (output.attempts ?? 0) > 0),
  );
  let routes: RouteCandidate[];

  if (operation === "lima") {
    const minute = limaMinute(input.now ?? new Date());
    const first = minute <= 10 * 60 + 30 ? "propio" : minute <= 12 * 60 ? "axel" : "tanders";
    routes = [
      candidate(
        "propio",
        minute <= 10 * 60 + 30 ? "Puede salir hoy" : "Siguiente turno disponible",
        "Entrega con motorizado de la empresa; puede repetirse.",
        { recommended: first === "propio" },
      ),
      candidate(
        "axel",
        minute <= 12 * 60 ? "Puede entrar al corte de hoy" : "Programar para el día siguiente",
        "Axel Courier puede repetirse cuando sea necesario.",
        { recommended: first === "axel" },
      ),
      candidate(
        "tanders",
        minute <= 16 * 60 ? "Ruta del día siguiente" : "Siguiente programación",
        "Integración directa con Tanders y rótulo del courier.",
        { recommended: first === "tanders" },
      ),
      candidate("urpi", "Según recojo coordinado", "Salida manual con rótulo interno de Kapta."),
      swaypCandidate(input, false),
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

  routes = routes.map((route) => applyOutputPolicy(route, input, operation));
  if (!routes.some((route) => route.recommended && route.availability !== "blocked")) {
    const firstAvailable = routes.find((route) => route.availability !== "blocked");
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
