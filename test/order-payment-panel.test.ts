import { describe, expect, it } from "vitest";
import { orderPaymentPanelPresentation } from "@/lib/order-payment-panel";

const BASE = {
  operation: "provincia_cod" as const,
  currentCourier: null,
  shippingMode: null,
  macroSubstage: "sin_llamar",
  paymentState: "sin_pago",
  hasAgencyCandidate: true,
};

describe("jerarquía de pagos en el drawer", () => {
  it("trata el pago como opcional en Provincia COD aunque Shalom esté disponible", () => {
    expect(orderPaymentPanelPresentation(BASE)).toEqual({
      show: true,
      mode: "optional",
    });
  });

  it("lo vuelve obligatorio cuando el MOM exige un adelanto", () => {
    // El abono es un MOTIVO de la macroetapa, no una subetapa: si el panel lo
    // siguiera buscando en `macro_substage` bajaría a opcional justo en el
    // pedido que está frenado por el pago.
    expect(
      orderPaymentPanelPresentation({
        ...BASE,
        macroSubstage: "volver_a_contactar",
        macroReasons: ["pago_requerido_pendiente"],
      }),
    ).toEqual({ show: true, mode: "required" });
  });

  it("la regla de riesgo del §8 vuelve obligatorio el cobro en Provincia COD", () => {
    // Es el «o una regla de riesgo lo exige» que este archivo nombraba desde el
    // principio sin tener de dónde leerlo.
    expect(
      orderPaymentPanelPresentation({ ...BASE, riskRequirement: "exigir_adelanto" }),
    ).toEqual({ show: true, mode: "required" });
    expect(
      orderPaymentPanelPresentation({ ...BASE, riskRequirement: "pago_completo" }),
    ).toEqual({ show: true, mode: "required" });
  });

  it("«sugerir» no fuerza el panel: es una recomendación para la llamada", () => {
    // Con un solo antecedente el MOM sugiere, no exige. Forzarlo pondría el cobro
    // por encima de la ruta en un COD que puede salir contra entrega.
    expect(
      orderPaymentPanelPresentation({ ...BASE, riskRequirement: "sugerir_adelanto" }),
    ).toEqual({ show: true, mode: "optional" });
  });

  it("prioriza el cobro en una operación de Agencia", () => {
    expect(
      orderPaymentPanelPresentation({
        ...BASE,
        operation: "agencia",
      }),
    ).toEqual({ show: true, mode: "required" });
  });

  it("mantiene visible un pago ya iniciado aunque no haya ruta de Agencia", () => {
    expect(
      orderPaymentPanelPresentation({
        ...BASE,
        hasAgencyCandidate: false,
        paymentState: "adelanto_cargado",
      }),
    ).toEqual({ show: true, mode: "optional" });
  });

  it("oculta el panel cuando el pago no corresponde ni tiene actividad", () => {
    expect(
      orderPaymentPanelPresentation({
        ...BASE,
        hasAgencyCandidate: false,
      }),
    ).toEqual({ show: false, mode: "optional" });
  });
});
