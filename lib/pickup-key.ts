// Condiciones para mostrar la clave de recojo de un envío por Shalom, y los
// indicadores de pago/clave que el Master enseña en la fila. Puro + testeado.
//
// La clave es la llave del paquete: quien la tiene lo recoge. Entregarla antes
// de cobrar la diferencia es perder el dinero, así que las condiciones no son
// una recomendación de interfaz — se comprueban en el servidor antes de
// descifrarla, y cada visualización queda registrada de forma imborrable.

import type { GeneralStatus } from "@/lib/order-status";
import { isWebPrepaid, type OrderPaymentFacts } from "@/lib/order-paid";

export type PaymentKind = "adelanto" | "diferencia" | "total";
export const SHALOM_MINIMUM_ADVANCE = 30;

function isLive(payment: PaymentSnapshot): boolean {
  return payment.validation_status !== "rechazado";
}

function inCents(value: number | null | undefined): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
}

export interface PaymentProgress {
  orderTotal: number | null;
  registeredTotal: number;
  validatedTotal: number;
  registeredRemaining: number | null;
  validatedRemaining: number | null;
  advanceRegistered: boolean;
  advanceValidated: boolean;
  completeRegistered: boolean;
  completeValidated: boolean;
}

/** Resumen monetario único para el drawer, el Master y las reglas de clave. */
export function paymentProgress(
  payments: readonly PaymentSnapshot[],
  orderTotal: number | null,
): PaymentProgress {
  const live = payments.filter(isLive);
  const registeredCents = live.reduce((sum, payment) => sum + (inCents(payment.amount) ?? 0), 0);
  const validatedCents = live
    .filter((payment) => payment.validation_status === "validado")
    .reduce((sum, payment) => sum + (inCents(payment.amount) ?? 0), 0);
  const advanceRegisteredCents = live
    .filter((payment) => payment.kind === "adelanto" || payment.kind === "total")
    .reduce((sum, payment) => sum + (inCents(payment.amount) ?? 0), 0);
  const advanceValidatedCents = live
    .filter(
      (payment) =>
        payment.validation_status === "validado" &&
        (payment.kind === "adelanto" || payment.kind === "total"),
    )
    .reduce((sum, payment) => sum + (inCents(payment.amount) ?? 0), 0);
  const hasTotalRegistered = live.some((payment) => payment.kind === "total");
  const hasTotalValidated = live.some(
    (payment) => payment.kind === "total" && payment.validation_status === "validado",
  );
  const totalCents = inCents(orderTotal);
  const validOrderTotal = totalCents !== null && totalCents > 0 ? totalCents : null;

  return {
    orderTotal: validOrderTotal === null ? null : validOrderTotal / 100,
    registeredTotal: registeredCents / 100,
    validatedTotal: validatedCents / 100,
    registeredRemaining:
      validOrderTotal === null ? null : Math.max(0, validOrderTotal - registeredCents) / 100,
    validatedRemaining:
      validOrderTotal === null ? null : Math.max(0, validOrderTotal - validatedCents) / 100,
    advanceRegistered:
      hasTotalRegistered || advanceRegisteredCents >= SHALOM_MINIMUM_ADVANCE * 100,
    advanceValidated:
      hasTotalValidated || advanceValidatedCents >= SHALOM_MINIMUM_ADVANCE * 100,
    completeRegistered: validOrderTotal !== null && registeredCents >= validOrderTotal,
    completeValidated: validOrderTotal !== null && validatedCents >= validOrderTotal,
  };
}

/** Tipos que corresponden al siguiente comprobante, no una lista fija de tres. */
export function nextPaymentKinds(
  payments: readonly PaymentSnapshot[],
  orderTotal: number | null,
): PaymentKind[] {
  const live = payments.filter(isLive);
  const kinds = new Set(live.map((payment) => payment.kind));
  if (kinds.has("total") || paymentProgress(live, orderTotal).completeRegistered) return [];
  if (kinds.has("adelanto") || kinds.has("diferencia")) return ["diferencia"];
  return ["adelanto", "total"];
}

/**
 * Protege la exclusión entre los dos planes de cobro y, para pago total,
 * comprueba que el comprobante realmente cancele el pedido completo.
 */
export function paymentPlanProblem(input: {
  kind: PaymentKind;
  existingKinds: readonly string[];
  existingAmount?: number;
  amount: number | null;
  orderTotal: number | null;
}): string | null {
  const existing = new Set(input.existingKinds);
  if (input.kind === "total" && existing.size > 0) {
    return (
      "Este pedido ya tiene pagos registrados. " +
      "Completa el saldo con Diferencia en vez de cargar un Pago total."
    );
  }
  if (input.kind !== "total" && existing.has("total")) {
    return "Este pedido ya tiene un pago total registrado.";
  }
  if (input.kind === "adelanto" && existing.size > 0) {
    return "El adelanto solo puede ser el primer pago del pedido.";
  }
  if (input.kind === "diferencia" && !existing.has("adelanto")) {
    return "El primer pago debe registrarse como Adelanto o Pago total.";
  }
  const orderTotal = Number(input.orderTotal);
  const existingAmount = Number(input.existingAmount ?? 0);
  if (
    input.kind === "diferencia" &&
    Number.isFinite(orderTotal) &&
    orderTotal > 0 &&
    Number.isFinite(existingAmount) &&
    existingAmount >= orderTotal
  ) {
    return "El monto cargado ya cubre el total del pedido.";
  }
  if (input.kind !== "total") return null;

  if (!Number.isFinite(orderTotal) || orderTotal <= 0) {
    return "El pedido no tiene un total válido contra el cual verificar el pago.";
  }
  if (input.amount === null || !Number.isFinite(input.amount)) {
    return `Indica el monto del pago total. El pedido suma S/ ${orderTotal.toFixed(2)}.`;
  }
  if (Math.round(input.amount * 100) !== Math.round(orderTotal * 100)) {
    return (
      `El comprobante es por S/ ${input.amount.toFixed(2)}, pero el pedido suma ` +
      `S/ ${orderTotal.toFixed(2)}. Usa Adelanto/Diferencia o corrige el monto.`
    );
  }
  return null;
}

export interface PaymentSnapshot {
  kind: string;
  validation_status: string;
  order_id: string;
  amount: number | null;
}

export interface PickupKeyContext {
  orderId: string;
  /** Estado general del pedido: no se entrega la clave de un pedido cerrado. */
  generalStatus: string;
  /** Sub-estado de agencia, cuando se conoce (§10). */
  pickupState: string | null;
  payments: readonly PaymentSnapshot[];
  /** Total que debe quedar cubierto antes de entregar la clave. */
  orderTotal: number | null;
  /** ¿Existe una clave registrada para este pedido? */
  hasKey: boolean;
  /**
   * Cómo se cobró el pedido, para el caso en que el dinero NO entró por
   * comprobantes: pagado en el checkout de Shopify.
   *
   * Sin esto, un pedido por Agencia pagado con tarjeta no podía recibir NUNCA su
   * clave de recojo: no tiene ni una fila en `order_payments`, así que faltaban
   * el adelanto y la diferencia para siempre. El cliente pagaba, el paquete
   * llegaba a la agencia, y nadie podía darle la clave para recogerlo.
   */
  paymentFacts?: OrderPaymentFacts;
}

/** Motivos por los que la clave sigue bloqueada, en el orden en que se explican. */
export type PickupBlocker =
  | "sin_clave"
  | "adelanto_no_registrado"
  | "diferencia_no_registrada"
  | "monto_no_informado"
  | "monto_insuficiente"
  | "pago_observado"
  | "pago_de_otro_pedido"
  | "pedido_cerrado"
  | "paquete_no_disponible";

export const BLOCKER_LABEL: Record<PickupBlocker, string> = {
  sin_clave: "Todavía no se ha registrado la clave de recojo.",
  adelanto_no_registrado: "Falta cargar el Yape de adelanto.",
  diferencia_no_registrada: "Falta cargar el Yape de la diferencia.",
  monto_no_informado: "Falta informar el monto de uno de los pagos o el total del pedido.",
  monto_insuficiente: "La suma de los pagos todavía no cubre el total del pedido.",
  pago_observado: "Uno de los comprobantes está rechazado o marcado como posible duplicado.",
  pago_de_otro_pedido: "Uno de los comprobantes está asociado a otro pedido.",
  pedido_cerrado: "El pedido está anulado, entregado o devuelto.",
  paquete_no_disponible: "El paquete todavía no está disponible para recojo.",
};

export interface PickupKeyVerdict {
  allowed: boolean;
  blockers: PickupBlocker[];
}

const CLOSED_STATUSES: readonly string[] = ["anulado", "entregado", "devuelto"];

/** Sub-estados de agencia en los que el paquete YA se puede recoger. */
const AVAILABLE_PICKUP_STATES: readonly string[] = [
  "disponible_para_recojo",
  "cliente_notificado",
  "pendiente_de_recojo",
  "proximo_a_vencer",
];

function find(payments: readonly PaymentSnapshot[], kind: PaymentKind): PaymentSnapshot | undefined {
  return payments.find((p) => p.kind === kind && isLive(p));
}

function findAll(payments: readonly PaymentSnapshot[], kind: PaymentKind): PaymentSnapshot[] {
  return payments.filter((payment) => payment.kind === kind && isLive(payment));
}

/**
 * ¿Se puede mostrar la clave? Devuelve TODOS los motivos que faltan, no solo el
 * primero, para que el operador sepa de una vez qué le falta en lugar de
 * descubrirlo de uno en uno.
 *
 * Condiciones (de la especificación):
 *   - el adelanto y la diferencia cargados (no hace falta revisión admin);
 *   - o un pago total cargado;
 *   - la suma registrada alcanza o supera el total del pedido;
 *   - ambos pagos del mismo pedido;
 *   - ningún comprobante asociado a otro pedido;
 *   - el pedido no anulado, entregado ni devuelto;
 *   - el paquete disponible para recojo, cuando esa información existe.
 */
export function canRevealPickupKey(ctx: PickupKeyContext): PickupKeyVerdict {
  const blockers: PickupBlocker[] = [];

  if (!ctx.hasKey) blockers.push("sin_clave");

  // EL DINERO PUEDE HABER ENTRADO POR OTRA PUERTA. Si el pedido se pagó en el
  // checkout, exigirle comprobantes es pedirle que pague otra vez para poder
  // recoger lo que ya pagó: no tiene NI UNA fila en `order_payments`, así que
  // «falta el adelanto» y «falta la diferencia» serían ciertos para siempre.
  //
  // Lo que NO se salta: que la clave exista, que el pedido no esté cerrado y que
  // el paquete esté disponible en la agencia. Esos no hablan de dinero.
  // La compuerta no se fía de `payment_state` del read-model: tiene delante la
  // lista real de comprobantes, que es el dato del que aquel se deriva y que no
  // puede llegar desfasado. Con un solo comprobante vivo, el dinero entró por
  // Yape y manda su regla de montos, no `financial_status`.
  const sinComprobantes = !ctx.payments.some(isLive);
  if (sinComprobantes && isWebPrepaid(ctx.paymentFacts ?? {})) {
    if (CLOSED_STATUSES.includes(ctx.generalStatus)) blockers.push("pedido_cerrado");
    if (ctx.pickupState && !AVAILABLE_PICKUP_STATES.includes(ctx.pickupState)) {
      blockers.push("paquete_no_disponible");
    }
    return { allowed: blockers.length === 0, blockers };
  }

  const adelanto = find(ctx.payments, "adelanto");
  const diferencias = findAll(ctx.payments, "diferencia");
  const total = find(ctx.payments, "total");

  // ¿EL DINERO CARGADO YA CUBRE EL PEDIDO? Se pregunta antes que la forma, y por
  // una razón concreta: la forma es una convención del flujo COD —adelanto para
  // despachar, diferencia antes de soltar la clave— y el dinero es el hecho.
  //
  // #KP128018 lo enseñó: un adelanto de S/ 200.00 validado sobre un pedido de
  // S/ 198.00. El panel decía «S/ 200.00 validados de S/ 198.00 · Saldo por
  // cargar: S/ 0.00» con la barra llena, y tres centímetros más arriba
  // «Completar el pago antes de liberar la clave». La pantalla se contradecía a
  // sí misma porque esta función miraba si existía una fila `diferencia`, no si
  // alcanzaba la plata. El cliente pagó todo de una y la asesora lo registró
  // como «Adelanto», que es lo natural cuando es el primer pago.
  //
  // El listón NO baja: se suman los comprobantes VIVOS (no rechazados) igual que
  // hacía la comprobación de monto de abajo, así que un pedido a medio pagar
  // sigue bloqueado. Lo único que deja de exigirse es que el dinero venga
  // repartido en dos filas con los nombres correctos.
  const live = ctx.payments.filter(isLive);
  const orderTotalCents =
    Number.isFinite(Number(ctx.orderTotal)) && Number(ctx.orderTotal) > 0
      ? Math.round(Number(ctx.orderTotal) * 100)
      : null;
  // Un comprobante sin monto suma CERO, no invalida la cuenta: `inCents` mapea
  // el nulo a cero. O sea que no puede inflar el total, solo dejarlo corto — que
  // es el lado correcto del error. No hace falta descartarlo aparte.
  const liveCents = live.map((payment) => inCents(payment.amount) ?? 0);
  const covered =
    orderTotalCents !== null &&
    liveCents.length > 0 &&
    liveCents.reduce<number>((sum, c) => sum + c, 0) >= orderTotalCents;

  if (total) {
    if (total.validation_status === "posible_duplicado") blockers.push("pago_observado");
  } else {
    // Con el total cubierto, faltar el «adelanto» o la «diferencia» deja de ser
    // un impedimento: es una etiqueta, no una deuda.
    if (!adelanto && !covered) blockers.push("adelanto_no_registrado");
    if (!diferencias.length && !covered) blockers.push("diferencia_no_registrada");
    // Un comprobante observado sí sigue bloqueando, cubra o no: un posible
    // duplicado no es dinero nuevo, y contarlo dos veces es justo lo que la
    // deduplicación persigue. Se miran TODOS los vivos y no solo los dos
    // esperados, porque ahora el monto puede venir de cualquiera de ellos.
    if (live.some((p) => p.validation_status === "posible_duplicado")) {
      blockers.push("pago_observado");
    }
  }

  const hasRequiredPayments = Boolean(total || (adelanto && diferencias.length));
  if (hasRequiredPayments) {
    const orderTotal = Number(ctx.orderTotal);
    const requiredCents = Number.isFinite(orderTotal) && orderTotal > 0
      ? Math.round(orderTotal * 100)
      : null;
    const selectedPayments = total ? [total] : [adelanto, ...diferencias];
    const amounts = selectedPayments.map((payment) => inCents(payment?.amount));
    if (requiredCents === null || amounts.some((amount) => amount === null)) {
      blockers.push("monto_no_informado");
    } else if (amounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0) < requiredCents) {
      blockers.push("monto_insuficiente");
    }
  }

  // Los índices únicos de 0049 impiden que un comprobante se asocie a dos
  // pedidos, pero la comprobación se repite aquí: es barata y protege del caso
  // en que los pagos lleguen ya cargados desde otra ruta.
  if ([adelanto, ...diferencias, total].some((p) => p && p.order_id !== ctx.orderId)) {
    blockers.push("pago_de_otro_pedido");
  }

  if (CLOSED_STATUSES.includes(ctx.generalStatus)) blockers.push("pedido_cerrado");

  // "cuando esa información esté disponible": si no sabemos dónde está el
  // paquete no se bloquea por ello — se bloquearía todo pedido cuyo courier no
  // reporte sub-estado.
  if (ctx.pickupState && !AVAILABLE_PICKUP_STATES.includes(ctx.pickupState)) {
    blockers.push("paquete_no_disponible");
  }

  return { allowed: blockers.length === 0, blockers };
}

/** Explicación lista para mostrar, sin construirla en la interfaz. */
export function describeBlockers(verdict: PickupKeyVerdict): string {
  return verdict.blockers.map((b) => BLOCKER_LABEL[b]).join(" ");
}

// ---------------------------------------------------------------------------
// Indicadores del Master (§"Información visible en el Master")
// ---------------------------------------------------------------------------

export type PaymentState =
  | "sin_pago"
  | "adelanto_cargado"
  | "adelanto_validado"
  | "diferencia_cargada"
  | "pago_total_cargado"
  | "pago_completo"
  | "posible_duplicado";

export const PAYMENT_STATE_LABEL: Record<PaymentState, string> = {
  sin_pago: "Adelanto pendiente",
  adelanto_cargado: "Adelanto cargado",
  adelanto_validado: "Diferencia pendiente",
  diferencia_cargada: "Diferencia cargada",
  pago_total_cargado: "Pago total cargado",
  pago_completo: "Pago completo",
  posible_duplicado: "Posible Yape duplicado",
};

/**
 * Estado de cobro del pedido, resumido en un solo indicador. El orden importa:
 * una posible duplicidad se anuncia por encima de todo lo demás, porque es lo
 * único que exige que alguien intervenga.
 */
export function paymentState(
  payments: readonly PaymentSnapshot[],
  orderTotal: number | null = null,
): PaymentState {
  if (payments.some((p) => p.validation_status === "posible_duplicado")) return "posible_duplicado";

  const adelanto = find(payments, "adelanto");
  const diferencias = findAll(payments, "diferencia");
  const total = find(payments, "total");

  if (total) {
    return total.validation_status === "validado" ? "pago_completo" : "pago_total_cargado";
  }
  if (!adelanto) return "sin_pago";
  if (adelanto.validation_status !== "validado") return "adelanto_cargado";
  if (!paymentProgress([adelanto], orderTotal).advanceValidated) return "adelanto_cargado";
  // Si lo VALIDADO ya cubre el pedido, está pagado — venga en una fila o en
  // tres. Sin esto, un adelanto de S/ 200 sobre un pedido de S/ 198 se anunciaba
  // como «Diferencia pendiente» mientras el mismo panel mostraba «Saldo por
  // cargar: S/ 0.00». La contradicción no era cosmética: de este estado cuelgan
  // la subetapa `pendiente_pago_diferencia` y el monto que se manda al courier.
  if (paymentProgress(payments, orderTotal).completeValidated) return "pago_completo";
  if (!diferencias.length) return "adelanto_validado";
  if (diferencias.some((payment) => payment.validation_status !== "validado")) {
    return "diferencia_cargada";
  }
  const progress = paymentProgress([adelanto, ...diferencias], orderTotal);
  if (progress.orderTotal !== null && !progress.completeValidated) return "adelanto_validado";
  return "pago_completo";
}

export type KeyState = "sin_clave" | "clave_bloqueada" | "clave_disponible" | "clave_enviada";

export const KEY_STATE_LABEL: Record<KeyState, string> = {
  sin_clave: "Sin clave",
  clave_bloqueada: "Clave bloqueada",
  clave_disponible: "Clave disponible",
  clave_enviada: "Clave enviada al cliente",
};

/** Estado de la clave para la fila del Master. La clave EN SÍ nunca sale aquí. */
export function keyState(ctx: PickupKeyContext & { shared: boolean }): KeyState {
  if (!ctx.hasKey) return "sin_clave";
  if (ctx.shared) return "clave_enviada";
  return canRevealPickupKey(ctx).allowed ? "clave_disponible" : "clave_bloqueada";
}

/** ¿Este pedido participa del flujo de pagos Yape + clave? */
export function usesPickupKeyFlow(courier: string | null, shippingMode: string | null): boolean {
  return courier === "shalom" || shippingMode === "agency";
}

export type { GeneralStatus };
