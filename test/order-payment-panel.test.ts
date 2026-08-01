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
      showPickupKey: false,
    });
  });

  it("lo vuelve obligatorio cuando el MOM exige un adelanto", () => {
    expect(
      orderPaymentPanelPresentation({
        ...BASE,
        macroSubstage: "pago_requerido_pendiente",
      }),
    ).toEqual({ show: true, mode: "required", showPickupKey: false });
  });

  it("prioriza pago y clave en una operación de Agencia", () => {
    expect(
      orderPaymentPanelPresentation({
        ...BASE,
        operation: "agencia",
      }),
    ).toEqual({ show: true, mode: "required", showPickupKey: true });
  });

  it("mantiene visible un pago ya iniciado aunque no haya ruta de Agencia", () => {
    expect(
      orderPaymentPanelPresentation({
        ...BASE,
        hasAgencyCandidate: false,
        paymentState: "adelanto_cargado",
      }),
    ).toEqual({ show: true, mode: "optional", showPickupKey: false });
  });

  it("oculta el panel cuando el pago no corresponde ni tiene actividad", () => {
    expect(
      orderPaymentPanelPresentation({
        ...BASE,
        hasAgencyCandidate: false,
      }),
    ).toEqual({ show: false, mode: "optional", showPickupKey: false });
  });
});
