// Condiciones para mostrar la clave de recojo de un envío por Shalom, y los
// indicadores de pago/clave que el Master enseña en la fila. Puro + testeado.
//
// La clave es la llave del paquete: quien la tiene lo recoge. Entregarla antes
// de cobrar la diferencia es perder el dinero, así que las condiciones no son
// una recomendación de interfaz — se comprueban en el servidor antes de
// descifrarla, y cada visualización queda registrada de forma imborrable.

import type { GeneralStatus } from "@/lib/order-status";

export type PaymentKind = "adelanto" | "diferencia" | "total";

/**
 * Protege la exclusión entre los dos planes de cobro y, para pago total,
 * comprueba que el comprobante realmente cancele el pedido completo.
 */
export function paymentPlanProblem(input: {
  kind: PaymentKind;
  existingKinds: readonly string[];
  amount: number | null;
  orderTotal: number | null;
}): string | null {
  const existing = new Set(input.existingKinds);
  if (input.kind === "total" && (existing.has("adelanto") || existing.has("diferencia"))) {
    return (
      "Este pedido ya tiene un adelanto o una diferencia registrados. " +
      "Completa el flujo existente en vez de cargar un pago total."
    );
  }
  if (input.kind !== "total" && existing.has("total")) {
    return "Este pedido ya tiene un pago total registrado.";
  }
  if (input.kind !== "total") return null;

  const orderTotal = Number(input.orderTotal);
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
  return payments.find((p) => p.kind === kind && p.validation_status !== "rechazado");
}

function amountInCents(payment: PaymentSnapshot | undefined): number | null {
  const amount = Number(payment?.amount);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
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

  const adelanto = find(ctx.payments, "adelanto");
  const diferencia = find(ctx.payments, "diferencia");
  const total = find(ctx.payments, "total");

  if (total) {
    if (total.validation_status === "posible_duplicado") blockers.push("pago_observado");
  } else {
    if (!adelanto) blockers.push("adelanto_no_registrado");
    if (!diferencia) blockers.push("diferencia_no_registrada");
    if ([adelanto, diferencia].some((p) => p?.validation_status === "posible_duplicado")) {
      blockers.push("pago_observado");
    }
  }

  const hasRequiredPayments = Boolean(total || (adelanto && diferencia));
  if (hasRequiredPayments) {
    const orderTotal = Number(ctx.orderTotal);
    const requiredCents = Number.isFinite(orderTotal) && orderTotal > 0
      ? Math.round(orderTotal * 100)
      : null;
    const selectedPayments = total ? [total] : [adelanto, diferencia];
    const amounts = selectedPayments.map(amountInCents);
    if (requiredCents === null || amounts.some((amount) => amount === null)) {
      blockers.push("monto_no_informado");
    } else if (amounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0) < requiredCents) {
      blockers.push("monto_insuficiente");
    }
  }

  // Los índices únicos de 0049 impiden que un comprobante se asocie a dos
  // pedidos, pero la comprobación se repite aquí: es barata y protege del caso
  // en que los pagos lleguen ya cargados desde otra ruta.
  if ([adelanto, diferencia, total].some((p) => p && p.order_id !== ctx.orderId)) {
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
export function paymentState(payments: readonly PaymentSnapshot[]): PaymentState {
  if (payments.some((p) => p.validation_status === "posible_duplicado")) return "posible_duplicado";

  const adelanto = find(payments, "adelanto");
  const diferencia = find(payments, "diferencia");
  const total = find(payments, "total");

  if (total) {
    return total.validation_status === "validado" ? "pago_completo" : "pago_total_cargado";
  }
  if (!adelanto) return "sin_pago";
  if (adelanto.validation_status !== "validado") return "adelanto_cargado";
  if (!diferencia) return "adelanto_validado";
  if (diferencia.validation_status !== "validado") return "diferencia_cargada";
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
