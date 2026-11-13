import type { OperationKind } from "@/lib/order-macro-stage";
import type { PaymentRequirement } from "@/lib/order-confirmation-brief";
import { usesPickupKeyFlow } from "@/lib/pickup-key";
import { isWebPrepaid, type OrderPaymentFacts } from "@/lib/order-paid";
import { PAYMENT_GATEWAY_LABEL, type PaymentGateway } from "@/lib/payment-gateway";

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
  //
  // EL `paymentState` SE PONE ACÁ, NO SE ESPERA DEL QUE LLAMA. `isWebPrepaid`
  // tiene una guarda que es la mitad de la regla —«si hay comprobantes, mandan
  // las de Yape»— y la lee de `facts.paymentState`. Ese dato ya viene en
  // `input.paymentState`, obligatorio, pero vivía TAMBIÉN dentro de
  // `paymentFacts`, opcional: el mismo hecho en dos sitios, y el drawer llenaba
  // solo uno. Con el hueco vacío la guarda no podía disparar nunca y cualquier
  // pedido `paid` en Shopify —que en esta operación es casi todo lo cobrado por
  // Yape— se dibujaba como «Pagado por web»: 331 pedidos, 141 abiertos.
  //
  // El daño se vio en `#KP126297`: con la diferencia sin nº de operación, el
  // recuadro decía «escribe el número aquí» y el campo no salía, porque esa
  // rama pasa `canRegister={false}`. Un comprobante que no se puede completar
  // ni validar, sin nada en pantalla que lo explique.
  //
  // Se rellena desde el campo que la función YA exige para que no dependa de
  // que el siguiente que llame se acuerde de copiarlo.
  if (isWebPrepaid({ ...(input.paymentFacts ?? {}), paymentState: input.paymentState })) {
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

/**
 * ¿Lleva la tarjeta de Cobro de un pedido PAGADO POR WEB el bloque «DNI y
 * agencia Shalom»? (MOM §Pagos, decidido el 26-10-2026 con #KP200104.)
 *
 * En un pedido con saldo ese bloque es el paso 1 de «Registrar un pago». En uno
 * pagado en el checkout no hay pago que registrar y el bloque desaparecía con
 * él: el DNI y la agencia solo se podían escribir en el modal de la guía, que
 * los pide y crea la guía en el mismo acto. Prepararlos antes —sin generar guía
 * ni rótulo— es justo para lo que existe el borrador (`shalom_order_drafts`),
 * pague o no el cliente por adelantado.
 *
 * Solo se ofrece donde Shalom puede ser el destino: la salida ya es Shalom o
 * agencia, la operación es Agencia, o el plan de rutas ofrece Shalom (Provincia
 * COD también lo ofrece: #KP200104 es Provincia COD). En Lima sería ruido.
 */
export function offersShalomDestination(input: {
  operation: OperationKind;
  currentCourier: string | null;
  shippingMode: string | null;
  /** El plan de rutas ofrece Shalom (esté o no frenada ahora la ruta). */
  shalomCandidate: boolean;
}): boolean {
  return (
    usesPickupKeyFlow(input.currentCourier, input.shippingMode) ||
    input.operation === "agencia" ||
    input.shalomCandidate
  );
}

/**
 * Lo que la ficha del pedido decide sobre la tarjeta de Cobro, en un solo sitio:
 * si se dibuja y en qué modo, la nota de la pasarela y si lleva «DNI y agencia
 * Shalom» en un pedido pagado por web.
 *
 * Vivía escrito dentro de `order-drawer.tsx`. Desde el 07-11-2026 lo lee también
 * el paso de después de «Generar pedido» en Leads (MOM §25.2), que enseña la
 * MISMA tarjeta (`PickupKeyPanel`) para el pedido recién creado: con dos copias
 * de este armado, Leads ofrecería el cobro por agencia en pedidos donde la
 * ficha no, o al revés.
 */
export interface OrderPaymentPanelSource {
  row: {
    current_courier: string | null;
    shipping_mode: string | null;
    macro_substage?: string | null;
    macro_reasons?: readonly string[] | null;
    payment_state: string | null;
    financial_status?: string | null;
    total_refunded?: number | null;
    payment_gateway?: PaymentGateway | null;
  };
  routePlan: { operation: OperationKind; candidates: readonly { key: string }[] };
  /**
   * La ficha del §8 (`loadConfirmationBrief`), o null mientras no llega o si
   * este pedido no la pide. Solo se lee su exigencia y la retención por posible
   * duplicado.
   */
  brief: {
    risk: { requirement: PaymentRequirement };
    duplicateHold?: { conflicts: readonly unknown[]; resolution: { decision: string } | null } | null;
  } | null;
  /** `shalom.create_guide`: sin él, Shalom/Olva en el plan no vuelven visible el cobro. */
  canCreateShalomGuide: boolean;
}

export interface OrderPaymentPanelSetup {
  presentation: OrderPaymentPanelPresentation;
  /** Shopify dice «pagado» pero no lo cobró el checkout: por qué el panel sigue pidiendo la constancia. */
  gatewayNote: string | null;
  /** `offersShalomDestination`: el bloque «DNI y agencia Shalom» en un pedido pagado por web. */
  shalomDestination: boolean;
}

/**
 * Lo que exige la regla de riesgo para el cobro (§8). La retención por posible
 * duplicado sin excepción aprobada pide adelanto aunque el cliente no lo pida.
 */
export function confirmationRiskRequirement(brief: OrderPaymentPanelSource["brief"]): PaymentRequirement | null {
  if (!brief) return null;
  if (brief.risk.requirement === "pago_completo") return "pago_completo";
  if (brief.duplicateHold?.conflicts.length && brief.duplicateHold.resolution?.decision !== "exception") {
    return "exigir_adelanto";
  }
  return brief.risk.requirement ?? null;
}

export function orderPaymentPanelFor(source: OrderPaymentPanelSource): OrderPaymentPanelSetup {
  const { row, routePlan } = source;
  const presentation = orderPaymentPanelPresentation({
    operation: routePlan.operation,
    currentCourier: row.current_courier,
    shippingMode: row.shipping_mode,
    macroSubstage: row.macro_substage,
    macroReasons: row.macro_reasons,
    riskRequirement: confirmationRiskRequirement(source.brief),
    paymentState: row.payment_state,
    paymentFacts: {
      financialStatus: row.financial_status,
      totalRefunded: row.total_refunded,
      paymentGateway: row.payment_gateway,
    },
    hasAgencyCandidate:
      source.canCreateShalomGuide &&
      routePlan.candidates.some((candidate) => candidate.key === "shalom" || candidate.key === "olva"),
  });
  const gatewayNote =
    (row.financial_status ?? "").toLowerCase() === "paid" &&
    (row.payment_gateway === "manual" || row.payment_gateway === "cod")
      ? `${PAYMENT_GATEWAY_LABEL[row.payment_gateway]}: no lo cobró el checkout. Para darlo por pagado, sube la constancia.`
      : null;
  // «DNI y agencia Shalom» en un pedido pagado por web (MOM §Pagos, #KP200104):
  // se ofrece donde Shalom puede ser el destino, lo pueda crear o no este rol.
  const shalomDestination = offersShalomDestination({
    operation: routePlan.operation,
    currentCourier: row.current_courier,
    shippingMode: row.shipping_mode,
    shalomCandidate: routePlan.candidates.some((candidate) => candidate.key === "shalom"),
  });
  return { presentation, gatewayNote, shalomDestination };
}

/**
 * La tarjeta de Cobro en un pedido contra entrega abierto (Lima o Provincia
 * COD), opcional, aunque nada la exija (13-11-2026): para subir la constancia
 * de un cliente que pagó por adelantado. Con lo validado cubriendo el total,
 * el rótulo dice «PAGADO - NO COBRAR» (`orderFullyPaid`) y la ruta del
 * motorizado «Pagado». Lo que ya se dibujaba, se dibuja igual.
 */
export function codPaymentPanel(
  presentation: OrderPaymentPanelPresentation,
  row: { macro_operation?: string | null; general_status?: string | null } | null,
): OrderPaymentPanelPresentation {
  if (presentation.show || !row) return presentation;
  const cod = row.macro_operation === "lima" || row.macro_operation === "provincia_cod";
  const open = !["entregado", "anulado", "devuelto"].includes((row.general_status ?? "").trim());
  return cod && open ? { show: true, mode: "optional" } : presentation;
}
