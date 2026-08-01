import type { OperationKind } from "@/lib/order-macro-stage";
import { usesPickupKeyFlow } from "@/lib/pickup-key";

export type OrderPaymentPanelMode = "required" | "optional";

export interface OrderPaymentPanelPresentation {
  show: boolean;
  mode: OrderPaymentPanelMode;
  showPickupKey: boolean;
}

interface OrderPaymentPanelInput {
  operation: OperationKind;
  currentCourier: string | null;
  shippingMode: string | null;
  macroSubstage: string | null | undefined;
  paymentState: string | null | undefined;
  hasAgencyCandidate: boolean;
}

/**
 * Decide la jerarquía del cobro dentro del drawer.
 *
 * Provincia COD puede salir contra entrega por Aliclik o Swayp. Que Shalom u
 * Olva existan como alternativas no convierte el adelanto en requisito ni debe
 * poner Pagos por encima de la elección de ruta. El cobro pasa a ser dominante
 * solo cuando la operación ya es Agencia o el MOM exige expresamente un pago.
 */
export function orderPaymentPanelPresentation(
  input: OrderPaymentPanelInput,
): OrderPaymentPanelPresentation {
  const pickupKeyFlow = usesPickupKeyFlow(input.currentCourier, input.shippingMode);
  const paymentRequired =
    pickupKeyFlow ||
    input.operation === "agencia" ||
    input.macroSubstage === "pago_requerido_pendiente" ||
    input.macroSubstage === "pendiente_pago_diferencia";
  const hasPaymentActivity = Boolean(
    input.paymentState && input.paymentState !== "sin_pago",
  );

  return {
    show: paymentRequired || hasPaymentActivity || input.hasAgencyCandidate,
    mode: paymentRequired ? "required" : "optional",
    showPickupKey: pickupKeyFlow || input.operation === "agencia",
  };
}
