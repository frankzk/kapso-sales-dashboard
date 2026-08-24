import type { OperationKind } from "@/lib/order-macro-stage";
import type { PaymentRequirement } from "@/lib/order-confirmation-brief";
import { usesPickupKeyFlow } from "@/lib/pickup-key";
import { isWebPrepaid, type OrderPaymentFacts } from "@/lib/order-paid";

/**
 * `prepaid` = el dinero ya entró por el checkout, así que no hay nada que
 * cobrar ni comprobante que pedir. El panel colapsa a una constancia.
 *
 * Es un modo y no un `show: false` porque el panel sigue teniendo trabajo en
 * Agencia: el DNI del destinatario y la agencia de Shalom no son cobro — son
 * datos de entrega, y sin ellos no se emite la guía.
 */
export type OrderPaymentPanelMode = "required" | "optional" | "prepaid";

export interface OrderPaymentPanelPresentation {
  show: boolean;
  mode: OrderPaymentPanelMode;
}

interface OrderPaymentPanelInput {
  operation: OperationKind;
  currentCourier: string | null;
  shippingMode: string | null;
  macroSubstage: string | null | undefined;
  /** Motivos abiertos de la macroetapa; `pago_requerido_pendiente` vive aquí. */
  macroReasons?: readonly string[] | null;
  paymentState: string | null | undefined;
  hasAgencyCandidate: boolean;
  /**
   * Lo que la tabla de riesgo del §8 exige por los antecedentes del cliente.
   * Es el «o una regla de riesgo lo exige» que este archivo nombraba desde el
   * principio sin tener de dónde leerlo.
   */
  riskRequirement?: PaymentRequirement | null;
  /** Cómo se cobró: si lo cobró el checkout, no hay cobro que gestionar. */
  paymentFacts?: OrderPaymentFacts;
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
  // PAGADO EN EL CHECKOUT: manda sobre todo lo demás. Pedirle un comprobante de
  // Yape a un pedido ya cobrado es pedirle al cliente que pague dos veces, y
  // enseñarle «Saldo por cargar: S/ 456.30» al asesor es mentirle sobre el
  // dinero que ya entró. Se decide antes que los requisitos porque ninguno de
  // ellos —Agencia, abono exigido, regla de riesgo— habla de otra cosa que de
  // cobrar, y acá ya está cobrado.
  if (isWebPrepaid(input.paymentFacts ?? {})) {
    return { show: true, mode: "prepaid" };
  }

  const pickupKeyFlow = usesPickupKeyFlow(input.currentCourier, input.shippingMode);
  const paymentRequired =
    pickupKeyFlow ||
    input.operation === "agencia" ||
    // El pago exigido en confirmación es un motivo, no una subetapa: buscarlo
    // en `macro_substage` dejaría de encontrarlo y el panel bajaría a opcional
    // justo en el pedido que está frenado por el abono.
    (input.macroReasons ?? []).includes("pago_requerido_pendiente") ||
    input.macroSubstage === "pendiente_pago_diferencia" ||
    // «Sugerir» no manda: es una recomendación para la llamada y forzar el panel
    // por ella pondría el cobro por encima de la ruta en un COD normal. Exigir
    // adelanto y pago completo sí, porque sin eso el pedido no debe despacharse.
    input.riskRequirement === "exigir_adelanto" ||
    input.riskRequirement === "pago_completo";
  const hasPaymentActivity = Boolean(
    input.paymentState && input.paymentState !== "sin_pago",
  );

  return {
    show: paymentRequired || hasPaymentActivity || input.hasAgencyCandidate,
    mode: paymentRequired ? "required" : "optional",
  };
}
