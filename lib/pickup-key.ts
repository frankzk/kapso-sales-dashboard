// Condiciones para mostrar la clave de recojo de un envío por Shalom, y los
// indicadores de pago/clave que el Master enseña en la fila. Puro + testeado.
//
// La clave es la llave del paquete: quien la tiene lo recoge. Entregarla antes
// de cobrar la diferencia es perder el dinero, así que las condiciones no son
// una recomendación de interfaz — se comprueban en el servidor antes de
// descifrarla, y cada visualización queda registrada de forma imborrable.

import type { GeneralStatus } from "@/lib/order-status";

export type PaymentKind = "adelanto" | "diferencia";

export interface PaymentSnapshot {
  kind: string;
  validation_status: string;
  order_id: string;
}

export interface PickupKeyContext {
  orderId: string;
  /** Estado general del pedido: no se entrega la clave de un pedido cerrado. */
  generalStatus: string;
  /** Sub-estado de agencia, cuando se conoce (§10). */
  pickupState: string | null;
  payments: readonly PaymentSnapshot[];
  /** ¿Existe una clave registrada para este pedido? */
  hasKey: boolean;
}

/** Motivos por los que la clave sigue bloqueada, en el orden en que se explican. */
export type PickupBlocker =
  | "sin_clave"
  | "adelanto_no_registrado"
  | "adelanto_no_validado"
  | "diferencia_no_registrada"
  | "diferencia_no_validada"
  | "pago_de_otro_pedido"
  | "pedido_cerrado"
  | "paquete_no_disponible";

export const BLOCKER_LABEL: Record<PickupBlocker, string> = {
  sin_clave: "Todavía no se ha registrado la clave de recojo.",
  adelanto_no_registrado: "Falta cargar el Yape de adelanto.",
  adelanto_no_validado: "El Yape de adelanto está cargado pero sin validar.",
  diferencia_no_registrada: "Falta cargar el Yape de la diferencia.",
  diferencia_no_validada: "El Yape de la diferencia está cargado pero sin validar.",
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
  // Un comprobante rechazado no cuenta como registrado: hay que volver a subirlo.
  return payments.find((p) => p.kind === kind && p.validation_status !== "rechazado");
}

/**
 * ¿Se puede mostrar la clave? Devuelve TODOS los motivos que faltan, no solo el
 * primero, para que el operador sepa de una vez qué le falta en lugar de
 * descubrirlo de uno en uno.
 *
 * Condiciones (de la especificación):
 *   - el adelanto registrado y validado;
 *   - la diferencia registrada y validada;
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

  if (!adelanto) blockers.push("adelanto_no_registrado");
  else if (adelanto.validation_status !== "validado") blockers.push("adelanto_no_validado");

  if (!diferencia) blockers.push("diferencia_no_registrada");
  else if (diferencia.validation_status !== "validado") blockers.push("diferencia_no_validada");

  // Los índices únicos de 0049 impiden que un comprobante se asocie a dos
  // pedidos, pero la comprobación se repite aquí: es barata y protege del caso
  // en que los pagos lleguen ya cargados desde otra ruta.
  if ([adelanto, diferencia].some((p) => p && p.order_id !== ctx.orderId)) {
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
  | "pago_completo"
  | "posible_duplicado";

export const PAYMENT_STATE_LABEL: Record<PaymentState, string> = {
  sin_pago: "Adelanto pendiente",
  adelanto_cargado: "Adelanto cargado",
  adelanto_validado: "Diferencia pendiente",
  diferencia_cargada: "Diferencia cargada",
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
