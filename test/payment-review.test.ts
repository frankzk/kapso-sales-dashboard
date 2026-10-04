import { describe, expect, it } from "vitest";
import {
  describePaymentValidator,
  limaDayBounds,
  paymentKindLabel,
  paymentObservationLabel,
  paymentReviewLane,
} from "@/lib/payment-review";

describe("payment review lanes", () => {
  const today = "2026-08-18T05:00:00.000Z";

  it("mantiene pendientes y observados como trabajo activo", () => {
    expect(paymentReviewLane("pendiente_revision", null, today)).toBe("pending");
    expect(paymentReviewLane("posible_duplicado", null, today)).toBe("observed");
    expect(paymentReviewLane("info_incompleta", null, today)).toBe("observed");
    expect(paymentReviewLane("revision_admin", null, today)).toBe("observed");
  });

  it("solo muestra las validaciones del día y nunca deja un rechazo como tarea", () => {
    expect(paymentReviewLane("validado", "2026-08-18T06:00:00.000Z", today)).toBe("validated");
    expect(paymentReviewLane("validado", "2026-08-17T23:00:00.000Z", today)).toBeNull();
    expect(paymentReviewLane("rechazado", "2026-08-18T06:00:00.000Z", today)).toBeNull();
  });

  it("calcula el día operativo en hora de Lima", () => {
    expect(limaDayBounds(new Date("2026-08-18T12:00:00.000Z"))).toEqual({
      date: "2026-08-18",
      startIso: "2026-08-18T05:00:00.000Z",
      endIso: "2026-08-19T05:00:00.000Z",
    });
  });

  it("expone etiquetas operativas claras", () => {
    expect(paymentKindLabel("total")).toBe("Pago total");
    expect(paymentObservationLabel("info_incompleta")).toBe("Información incompleta");
  });
});

describe("describePaymentValidator", () => {
  it("una persona se nombra", () => {
    expect(describePaymentValidator({ kind: "persona", name: "gabriela" })).toEqual({
      by: "Validado por gabriela",
      detail: null,
    });
  });

  it("el estado de cuenta de Yape dice con qué movimiento (MOM §16.2)", () => {
    // #KP138765: «Benito Cac*», S/ 30, a las 09:22:42 de Lima.
    expect(
      describePaymentValidator({
        kind: "estado_yape",
        payer: "Benito Cac*",
        amount: 30,
        at: "2026-10-04T14:22:42.000Z",
      }),
    ).toEqual({
      by: "Validado por el estado de cuenta de Yape",
      detail: "Movimiento: Benito Cac* · S/ 30.00 · 04/10, 09:22:42",
    });
  });

  it("la pasarela, y lo que no dejó rastro, no se atribuyen a nadie", () => {
    expect(describePaymentValidator({ kind: "pasarela", name: "Flow" }).by).toBe("Validado por la pasarela Flow");
    expect(describePaymentValidator({ kind: "sin_registro" }).by).toBe("Validado sin persona registrada");
    expect(describePaymentValidator(null).by).toBe("Validado");
  });
});
